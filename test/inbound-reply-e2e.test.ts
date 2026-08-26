import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { MailtrapClient } from "mailtrap";
import { createMailtrapAdapter } from "../src/index.js";
import { WebhookHandler } from "../src/webhook-handler.js";
import type { MailtrapReceivedEmail } from "../src/types.js";

const SECRET = "inbound-e2e-secret";
const FROM = "bot@mailtrap.io";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function inboundFixture(
  overrides: Partial<MailtrapReceivedEmail> = {},
): MailtrapReceivedEmail {
  return {
    id: "1866872391602282496",
    inbox_id: 42,
    from: "Jane Doe <jane@example.com>",
    to: ["bot@inbound.mailtrap.io"],
    cc: [],
    subject: "Need help with billing",
    text: "Please check invoice 4821",
    html: null,
    message_id: "<root-msg@example.com>",
    in_reply_to: null,
    references: [],
    headers: {},
    created_at: "2026-08-26T10:00:00.000Z",
    thread_id: "thr_test",
    attachments: [],
    ...overrides,
  };
}

describe("inbound webhook → bot reply", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(WebhookHandler.prototype, "fetchEmailContent");
    sendSpy = vi
      .spyOn(MailtrapClient.prototype, "send")
      .mockResolvedValue({
        success: true,
        message_ids: ["outbound-uuid-1"],
      } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function bootBot(handlers: {
    onNew?: (text: string) => Promise<void> | void;
    onFollowUp?: (text: string) => Promise<void> | void;
  }) {
    const state = new MemoryStateAdapter();
    await state.connect();

    const mailtrap = createMailtrapAdapter({
      fromAddress: FROM,
      fromName: "E2E Bot",
      apiKey: "test-token",
      webhookSecret: SECRET,
      category: "chat-sdk",
    });

    const chat = new Chat({
      userName: "email-bot",
      adapters: { mailtrap },
      state,
    });

    const seen: { newMentions: string[]; followUps: string[] } = {
      newMentions: [],
      followUps: [],
    };

    chat.onNewMention(async (thread, message) => {
      seen.newMentions.push(message.text);
      await thread.subscribe();
      await handlers.onNew?.(message.text);
      await thread.post(`Got your email: ${message.text}`);
    });

    chat.onSubscribedMessage(async (thread, message) => {
      seen.followUps.push(message.text);
      await handlers.onFollowUp?.(message.text);
      await thread.post(`Echo: ${message.text}`);
    });

    // Force adapter initialize via webhook getter
    await chat.webhooks;

    return { chat, mailtrap, seen };
  }

  async function postWebhook(
    chat: Chat,
    event: {
      inbox_id: number;
      message_id: string;
    },
  ): Promise<Response> {
    const body = JSON.stringify({
      events: [
        {
          event: "inbound.message_received",
          inbox_id: event.inbox_id,
          message_id: event.message_id,
        },
      ],
    });
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mailtrap-signature": sign(body),
      },
      body,
    });
    return chat.webhooks.mailtrap(request);
  }

  it("fetches inbound mail, runs onNewMention, and sends threaded reply", async () => {
    fetchSpy.mockResolvedValue(inboundFixture());
    const { chat, seen } = await bootBot({});

    const res = await postWebhook(chat, {
      inbox_id: 42,
      message_id: "1866872391602282496",
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(42, "1866872391602282496");
    expect(seen.newMentions).toEqual(["Please check invoice 4821"]);
    expect(seen.followUps).toEqual([]);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![0] as {
      to: Array<{ email: string }>;
      subject: string;
      text: string;
      category: string;
      headers: Record<string, string>;
      from: { email: string; name?: string };
    };

    expect(payload.from.email).toBe(FROM);
    expect(payload.to[0]?.email).toBe("jane@example.com");
    expect(payload.subject).toBe("Re: Need help with billing");
    expect(payload.text).toContain("Got your email: Please check invoice 4821");
    expect(payload.category).toBe("chat-sdk");
    expect(payload.headers["Message-ID"]).toMatch(/^<.+@mailtrap\.io>$/);
    expect(payload.headers["In-Reply-To"]).toBe("<root-msg@example.com>");
    expect(payload.headers.References).toContain("<root-msg@example.com>");
  });

  it("routes follow-up inbound mail to onSubscribedMessage", async () => {
    const { chat, seen } = await bootBot({});

    fetchSpy.mockResolvedValueOnce(inboundFixture());
    await postWebhook(chat, {
      inbox_id: 42,
      message_id: "1866872391602282496",
    });

    fetchSpy.mockResolvedValueOnce(
      inboundFixture({
        id: "1866872391602282497",
        text: "Also please rush this",
        message_id: "<follow-up@example.com>",
        in_reply_to: "<root-msg@example.com>",
        references: ["<root-msg@example.com>"],
        subject: "Re: Need help with billing",
      }),
    );

    const res = await postWebhook(chat, {
      inbox_id: 42,
      message_id: "1866872391602282497",
    });

    expect(res.status).toBe(200);
    expect(seen.newMentions).toEqual(["Please check invoice 4821"]);
    expect(seen.followUps).toEqual(["Also please rush this"]);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    const followUpSend = sendSpy.mock.calls[1]![0] as {
      text: string;
      subject: string;
      headers: Record<string, string>;
    };
    expect(followUpSend.text).toContain("Echo: Also please rush this");
    expect(followUpSend.subject).toBe("Re: Need help with billing");
    expect(followUpSend.headers["In-Reply-To"]).toBe(
      "<follow-up@example.com>",
    );
  });

  it("ignores the bot's own mail looping back into inbound", async () => {
    fetchSpy.mockResolvedValue(
      inboundFixture({
        from: `E2E Bot <${FROM}>`,
        text: "loop",
      }),
    );
    const { chat, seen } = await bootBot({});

    const res = await postWebhook(chat, {
      inbox_id: 42,
      message_id: "1866872391602282496",
    });

    expect(res.status).toBe(200);
    expect(seen.newMentions).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("returns 200 when inbound message fetch fails", async () => {
    fetchSpy.mockRejectedValue(new Error("message not found"));
    const { chat, seen } = await bootBot({});

    const res = await postWebhook(chat, {
      inbox_id: 42,
      message_id: "missing",
    });

    expect(res.status).toBe(200);
    expect(seen.newMentions).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
