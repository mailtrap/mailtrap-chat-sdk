import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  StreamChunk,
  StreamOptions,
  WebhookOptions,
} from "chat";
import { Message, NotImplementedError, parseMarkdown } from "chat";
import type { Root } from "mdast";
import { MailtrapClient } from "mailtrap";
import { MailtrapFormatConverter } from "./format-converter.js";
import { parseInboundEmail } from "./message-parser.js";
import { renderMessage } from "./message-renderer.js";
import { ThreadResolver } from "./thread-resolver.js";
import type {
  MailtrapAdapterConfig,
  MailtrapRawMessage,
  MailtrapThreadId,
  ResolvedMailtrapAdapterConfig,
} from "./types.js";
import {
  generateMessageId,
  hashMessageId,
  parseEmailAddress,
} from "./utils.js";
import { resolveEventIds, WebhookHandler } from "./webhook-handler.js";

const DEFAULT_CATEGORY = "chat-sdk";

export type { ChatInstance };

export function resolveMailtrapAdapterConfig(
  config: MailtrapAdapterConfig = {},
): ResolvedMailtrapAdapterConfig {
  const fromAddress = config.fromAddress || process.env.FROM_ADDRESS;
  if (!fromAddress) {
    throw new Error(
      "fromAddress is required. Provide it via config.fromAddress or FROM_ADDRESS env var.",
    );
  }

  return {
    ...config,
    fromAddress,
    fromName: config.fromName ?? process.env.FROM_NAME,
    apiKey: config.apiKey || process.env.MAILTRAP_API_TOKEN,
    webhookSecret: config.webhookSecret || process.env.MAILTRAP_WEBHOOK_SECRET,
  };
}

export class MailtrapAdapter
  implements Adapter<MailtrapThreadId, MailtrapRawMessage>
{
  readonly name = "mailtrap";
  readonly userName: string;

  private readonly config: ResolvedMailtrapAdapterConfig;
  private client: MailtrapClient | null = null;
  private chat: ChatInstance | null = null;
  private readonly threadResolver = new ThreadResolver();
  private readonly formatConverter = new MailtrapFormatConverter();
  private webhookHandler: WebhookHandler | null = null;

  constructor(config: MailtrapAdapterConfig = {}) {
    this.config = resolveMailtrapAdapterConfig(config);
    this.userName = this.config.fromAddress;
  }

  private getClient(): MailtrapClient {
    if (!this.client) {
      const apiKey = this.config.apiKey;
      if (!apiKey) {
        throw new Error(
          "Mailtrap API token is required. Provide it via config.apiKey or MAILTRAP_API_TOKEN env var.",
        );
      }
      this.client = new MailtrapClient({
        token: apiKey,
        userAgent:
          "mailtrap-chat-sdk-adapter (https://github.com/mailtrap/mailtrap-chat-sdk)",
      });
    }
    return this.client;
  }

  private getCategory(): string {
    return this.config.category || DEFAULT_CATEGORY;
  }

  private logError(message: string, meta: Record<string, unknown>): void {
    const logger = this.chat?.getLogger("mailtrap");
    if (logger?.error) {
      logger.error(message, meta);
      return;
    }
    console.error(`[mailtrap] ${message}`, meta);
  }

  initialize(chat: ChatInstance): Promise<void> {
    this.getClient();
    this.chat = chat;
    this.threadResolver.state = chat.getState();

    const webhookSecret = this.config.webhookSecret || "";
    this.webhookHandler = new WebhookHandler(this.getClient(), webhookSecret);
    return Promise.resolve();
  }

  encodeThreadId(id: MailtrapThreadId): string {
    return this.threadResolver.encodeThreadId(id);
  }

  decodeThreadId(threadId: string): MailtrapThreadId {
    return this.threadResolver.decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    const { toAddress } = this.decodeThreadId(threadId);
    return `mailtrap:${toAddress}`;
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (!(this.webhookHandler && this.chat)) {
      throw new Error("Adapter not initialized. Call initialize() first.");
    }

    const webhookSecret = this.config.webhookSecret;
    if (!webhookSecret) {
      throw new Error(
        "Webhook secret is required for webhook verification (config.webhookSecret or MAILTRAP_WEBHOOK_SECRET env)",
      );
    }

    const result = await this.webhookHandler.parseWebhookRequest(request);
    if (result.status !== 200) {
      return new Response(null, { status: result.status });
    }

    for (const event of result.events) {
      const { inboxId, messageId } = resolveEventIds(event);
      if (!inboxId || !messageId) {
        continue;
      }

      try {
        const email = await this.webhookHandler.fetchEmailContent(
          inboxId,
          messageId,
        );

        const senderAddress = parseEmailAddress(email.from);
        if (senderAddress === parseEmailAddress(this.config.fromAddress)) {
          // Ignore the bot's own outbound mail if it loops back into inbound.
          continue;
        }

        const headers = email.headers || {};
        const inReplyTo =
          email.in_reply_to ||
          headers["in-reply-to"] ||
          headers["In-Reply-To"] ||
          undefined;
        const references =
          (email.references && email.references.length > 0
            ? email.references
            : undefined) ||
          headers.references ||
          headers.References ||
          undefined;

        const threadId = await this.threadResolver.resolveThreadId({
          toAddress: senderAddress,
          messageId: email.message_id,
          inReplyTo: inReplyTo ?? undefined,
          references,
        });

        if (email.subject) {
          await this.threadResolver.trackSubject(threadId, email.subject);
        }

        const parsed = parseInboundEmail(
          email,
          threadId,
          this.config.fromAddress,
        );
        await this.chat.processMessage(this, threadId, parsed, options);
      } catch (err) {
        // Return 200 below so Mailtrap does not retry permanent failures
        // (unknown/deleted message ids). Errors are logged for operators.
        this.logError("Failed to process inbound event", {
          error: err,
          inboxId,
          messageId,
        });
      }
    }

    return new Response(null, { status: 200 });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<{ id: string; raw: MailtrapRawMessage; threadId: string }> {
    const client = this.getClient();

    let normalized: { text?: string; formatted?: Root };
    if (typeof message === "string") {
      normalized = { text: message };
    } else if ("markdown" in message) {
      normalized = {
        formatted: parseMarkdown((message as { markdown: string }).markdown),
      };
    } else if ("raw" in message) {
      normalized = { text: (message as { raw: string }).raw };
    } else if ("ast" in message) {
      normalized = { formatted: (message as { ast: Root }).ast };
    } else if ("card" in message) {
      const card = message as {
        card?: { title?: string };
        fallbackText?: string;
      };
      normalized = {
        text:
          card.fallbackText ||
          card.card?.title ||
          "Card messages are not fully supported by this adapter version.",
      };
    } else if ("type" in message) {
      normalized = {
        text: "Card messages are not fully supported by this adapter version.",
      };
    } else {
      normalized = message as { text?: string; formatted?: Root };
    }

    const decoded = this.threadResolver.decodeThreadId(threadId);
    const rendered = await renderMessage(normalized);

    const messageId = generateMessageId(this.config.fromAddress);
    const replyHeaders = await this.threadResolver.getReplyHeaders(threadId);
    const headers: Record<string, string> = {
      "Message-ID": messageId,
      ...(replyHeaders || {}),
    };

    const storedSubject = await this.threadResolver.getSubject(threadId);
    const subject = storedSubject
      ? storedSubject.toLowerCase().startsWith("re:")
        ? storedSubject
        : `Re: ${storedSubject}`
      : "New message";

    const response = await client.send({
      from: {
        email: this.config.fromAddress,
        name: this.config.fromName,
      },
      to: [{ email: decoded.toAddress }],
      subject,
      html: rendered.html,
      text: rendered.text,
      category: this.getCategory(),
      headers,
    });

    if (!response.success || !response.message_ids?.[0]) {
      throw new Error("Failed to send email via Mailtrap Email API");
    }

    await this.threadResolver.trackMessage(threadId, messageId);

    return {
      id: response.message_ids[0],
      raw: {
        id: response.message_ids[0],
        messageId,
        from: this.config.fromAddress,
        to: [decoded.toAddress],
        subject,
        text: rendered.text,
        html: rendered.html,
        headers,
        createdAt: new Date().toISOString(),
      },
      threadId,
    };
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<{ id: string; raw: MailtrapRawMessage; threadId: string }> {
    let markdown = "";

    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        markdown += chunk;
        continue;
      }

      if (chunk.type === "markdown_text") {
        markdown += chunk.text;
      }
    }

    if (!markdown) {
      throw new Error(
        "Mailtrap adapter received a stream with no textual content. Email requires text.",
      );
    }

    return this.postMessage(threadId, { markdown });
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: unknown,
  ): never {
    throw new NotImplementedError(
      "editMessage is not supported by the Mailtrap adapter",
      "editMessage",
    );
  }

  deleteMessage(_threadId: string, _messageId: string): never {
    throw new NotImplementedError(
      "deleteMessage is not supported by the Mailtrap adapter",
      "deleteMessage",
    );
  }

  addReaction(
    _threadId: string,
    _messageId: string,
    _reaction: string,
  ): never {
    throw new NotImplementedError(
      "addReaction is not supported by the Mailtrap adapter",
      "addReaction",
    );
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _reaction: string,
  ): never {
    throw new NotImplementedError(
      "removeReaction is not supported by the Mailtrap adapter",
      "removeReaction",
    );
  }

  startTyping(_threadId: string): never {
    throw new NotImplementedError(
      "startTyping is not supported by the Mailtrap adapter",
      "startTyping",
    );
  }

  renderFormatted(content: Root): string {
    return this.formatConverter.fromAst(content);
  }

  async openDM(email: string): Promise<string> {
    // Allocate a thread id only — do not track a phantom Message-ID, or the
    // first postMessage would send In-Reply-To / References to a never-sent id.
    const seed = generateMessageId(this.config.fromAddress);
    const threadId = this.threadResolver.encodeThreadId({
      toAddress: parseEmailAddress(email),
      rootMessageIdHash: hashMessageId(seed),
    });
    return threadId;
  }

  fetchThread(threadId: string): Promise<{
    id: string;
    channelId: string;
    metadata: Record<string, unknown>;
  }> {
    const decoded = this.decodeThreadId(threadId);
    return Promise.resolve({
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      metadata: {
        title: `Conversation with ${decoded.toAddress}`,
        toAddress: decoded.toAddress,
      },
    });
  }

  fetchMessages(_threadId: string): Promise<{
    messages: Message<MailtrapRawMessage>[];
    nextCursor?: string;
  }> {
    return Promise.resolve({ messages: [] });
  }

  parseMessage(raw: MailtrapRawMessage): Message<MailtrapRawMessage> {
    const authorEmail = parseEmailAddress(raw.from);
    const text = raw.text || "";
    return new Message({
      id: raw.id,
      threadId: "",
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: authorEmail,
        fullName: authorEmail,
        userName: authorEmail,
        isBot: false,
        isMe: authorEmail === this.config.fromAddress,
      },
      metadata: {
        dateSent: new Date(raw.createdAt),
        edited: false,
      },
      attachments: [],
    });
  }
}
