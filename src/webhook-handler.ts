import {
  MailtrapClient,
  verifyWebhookSignature,
} from "mailtrap";
import type {
  MailtrapInboundWebhookEvent,
  MailtrapReceivedEmail,
  MailtrapWebhookPayload,
} from "./types.js";

interface WebhookResult {
  events: MailtrapInboundWebhookEvent[];
  status: number;
}

export class WebhookHandler {
  constructor(
    private readonly client: MailtrapClient,
    private readonly webhookSecret: string,
  ) {}

  async parseWebhookRequest(request: Request): Promise<WebhookResult> {
    const body = await request.text();
    const signature =
      request.headers.get("mailtrap-signature") ||
      request.headers.get("Mailtrap-Signature") ||
      "";

    if (this.webhookSecret) {
      const valid = verifyWebhookSignature(body, signature, this.webhookSecret);
      if (!valid) {
        return { status: 401, events: [] };
      }
    }

    let payload: MailtrapWebhookPayload;
    try {
      payload = JSON.parse(body) as MailtrapWebhookPayload;
    } catch {
      return { status: 400, events: [] };
    }

    const raw = Array.isArray(payload.events)
      ? payload.events
      : [payload as MailtrapInboundWebhookEvent];

    const events = raw.filter((e) => {
      const type = e.event ?? (payload as { event?: string }).event;
      return !type || type === "inbound.message_received";
    });

    return { status: 200, events };
  }

  async fetchEmailContent(
    inboxId: number,
    messageId: string,
  ): Promise<MailtrapReceivedEmail> {
    const message = await this.client.inbound.messages.get(inboxId, messageId);

    return {
      id: message.id,
      inbox_id: message.inbox_id,
      from: message.from || "",
      to: message.to || [],
      cc: message.cc || [],
      subject: message.subject || "",
      text: message.text_body,
      html: message.html_body,
      message_id: message.rfc_message_id || `<${message.id}@inbound.mailtrap.io>`,
      in_reply_to: message.in_reply_to,
      references: message.references || [],
      headers: message.headers,
      created_at: message.received_at,
      thread_id: message.thread_id,
      attachments: (message.attachments || []).map((a) => ({
        attachment_id: a.attachment_id,
        filename: a.filename,
        content_type: a.content_type,
        download_url: "download_url" in a ? a.download_url : null,
      })),
    };
  }
}

export function resolveEventIds(event: MailtrapInboundWebhookEvent): {
  inboxId: number | null;
  messageId: string | null;
} {
  const inboxId = Number(event.inbox_id ?? event.inboxId);
  const messageId = String(
    event.message_id ?? event.messageId ?? event.inbound_message_id ?? "",
  );
  return {
    inboxId: Number.isFinite(inboxId) && inboxId > 0 ? inboxId : null,
    messageId: messageId || null,
  };
}
