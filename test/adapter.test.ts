import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "mailtrap";
import { hashMessageId, parseEmailAddress, generateMessageId } from "../src/utils.js";
import { ThreadResolver } from "../src/thread-resolver.js";

describe("utils", () => {
  it("parses email addresses", () => {
    expect(parseEmailAddress("Ada <ada@example.com>")).toBe("ada@example.com");
    expect(parseEmailAddress("ada@example.com")).toBe("ada@example.com");
  });

  it("hashes message ids stably", () => {
    expect(hashMessageId("<a@b.com>")).toBe(hashMessageId("<a@b.com>"));
    expect(hashMessageId("<a@b.com>")).toHaveLength(16);
  });

  it("generates rfc message ids", () => {
    expect(generateMessageId("bot@mailtrap.io")).toMatch(/^<.+@mailtrap\.io>$/);
  });
});

describe("thread resolver", () => {
  it("groups replies by In-Reply-To", async () => {
    const resolver = new ThreadResolver();
    const root = "<root@example.com>";
    const t1 = await resolver.resolveThreadId({
      toAddress: "eng@acme.com",
      messageId: root,
      inReplyTo: undefined,
      references: undefined,
    });
    const t2 = await resolver.resolveThreadId({
      toAddress: "eng@acme.com",
      messageId: "<reply@example.com>",
      inReplyTo: root,
      references: root,
    });
    expect(t2).toBe(t1);
    const headers = await resolver.getReplyHeaders(t1);
    expect(headers?.["In-Reply-To"]).toBe("<reply@example.com>");
  });
});

describe("mailtrap signature", () => {
  it("verifies hmac payloads", () => {
    const secret = "test-secret";
    const body = '{"events":[]}';
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(body, "0".repeat(64), secret)).toBe(false);
  });
});

describe("openDM", () => {
  it("does not plant a phantom In-Reply-To before the first send", async () => {
    process.env.FROM_ADDRESS = process.env.FROM_ADDRESS || "bot@mailtrap.io";
    process.env.MAILTRAP_API_TOKEN =
      process.env.MAILTRAP_API_TOKEN || "test-token";
    process.env.MAILTRAP_WEBHOOK_SECRET =
      process.env.MAILTRAP_WEBHOOK_SECRET || "test-secret";

    const { createMailtrapAdapter } = await import("../src/index.js");
    const { MemoryStateAdapter } = await import("@chat-adapter/state-memory");
    const { MailtrapClient } = await import("mailtrap");
    const { vi } = await import("vitest");

    const sendSpy = vi
      .spyOn(MailtrapClient.prototype, "send")
      .mockResolvedValue({
        success: true,
        message_ids: ["outbound-1"],
      } as never);

    const state = new MemoryStateAdapter();
    await state.connect();
    const mailtrap = createMailtrapAdapter({
      fromAddress: "bot@mailtrap.io",
      apiKey: "test-token",
      webhookSecret: "test-secret",
    });
    await mailtrap.initialize({
      getState: () => state,
      getLogger: () => ({
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
      }),
      getUserName: () => "bot",
      processMessage: async () => undefined,
    } as never);

    const threadId = await mailtrap.openDM("jane@example.com");
    await mailtrap.postMessage(threadId, "Hello");

    const payload = sendSpy.mock.calls[0]![0] as {
      headers: Record<string, string>;
      to: Array<{ email: string }>;
    };
    expect(payload.to[0]?.email).toBe("jane@example.com");
    expect(payload.headers["Message-ID"]).toMatch(/^<.+@mailtrap\.io>$/);
    expect(payload.headers["In-Reply-To"]).toBeUndefined();
    expect(payload.headers.References).toBeUndefined();

    sendSpy.mockRestore();
  });
});

describe("resolveMailtrapAdapterConfig", () => {
  it("applies FROM_ADDRESS and FROM_NAME env fallbacks", async () => {
    const { resolveMailtrapAdapterConfig } = await import("../src/adapter.js");
    const prevAddress = process.env.FROM_ADDRESS;
    const prevName = process.env.FROM_NAME;
    process.env.FROM_ADDRESS = "bot@example.com";
    process.env.FROM_NAME = "Env Bot";
    try {
      const resolved = resolveMailtrapAdapterConfig({});
      expect(resolved.fromAddress).toBe("bot@example.com");
      expect(resolved.fromName).toBe("Env Bot");
    } finally {
      if (prevAddress === undefined) {
        delete process.env.FROM_ADDRESS;
      } else {
        process.env.FROM_ADDRESS = prevAddress;
      }
      if (prevName === undefined) {
        delete process.env.FROM_NAME;
      } else {
        process.env.FROM_NAME = prevName;
      }
    }
  });
});
