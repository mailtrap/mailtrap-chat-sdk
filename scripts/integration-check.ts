import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load examples/basic/.env
const envPath = resolve("examples/basic/.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);
  if (!process.env[key]) process.env[key] = value;
}

function sign(body: string): string {
  return createHmac("sha256", process.env.MAILTRAP_WEBHOOK_SECRET!).update(body).digest("hex");
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const base = "http://localhost:3000";

await check("GET / health", async () => {
  const res = await fetch(base + "/");
  const text = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!text.includes("running")) throw new Error(`unexpected body: ${text}`);
});

await check("POST /webhook without signature → 401", async () => {
  const body = JSON.stringify({ events: [] });
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("POST /webhook bad signature → 401", async () => {
  const body = JSON.stringify({ events: [] });
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "mailtrap-signature": "0".repeat(64),
    },
    body,
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("POST /webhook valid signature + empty events → 200", async () => {
  const body = JSON.stringify({ events: [] });
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "mailtrap-signature": sign(body),
    },
    body,
  });
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
});

await check("POST /webhook valid signature + inbound event (missing message) → 200", async () => {
  // Signed payload is accepted; unknown message fetch is swallowed so Mailtrap
  // does not retry permanently failing events.
  const body = JSON.stringify({
    events: [
      {
        event: "inbound.message_received",
        inbox_id: 1,
        message_id: "00000000-0000-0000-0000-000000000000",
      },
    ],
  });
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "mailtrap-signature": sign(body),
    },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`expected 200, got ${res.status}`);
  }
});

// Direct adapter outbound test (no webhook)
await check("adapter openDM + postMessage hits Mailtrap Email API", async () => {
  const { createMailtrapAdapter } = await import("../src/index.js");
  const { MemoryStateAdapter } = await import("@chat-adapter/state-memory");

  const mailtrap = createMailtrapAdapter({ category: "chat-sdk" });
  const state = new MemoryStateAdapter();
  await state.connect();
  await mailtrap.initialize({
    getState: () => state,
    processMessage: () => undefined,
  });

  const threadId = await mailtrap.openDM("jane@example.com");
  try {
    await mailtrap.postMessage(
      threadId,
      "Integration test from chat-sdk adapter",
    );
    console.log("      outbound send succeeded");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("reached its limit") ||
      msg.includes("403") ||
      msg.includes("Sending usage")
    ) {
      console.log(`      outbound reached Mailtrap API (${msg})`);
      return;
    }
    throw err;
  }
});

await check("resolveMailtrapAdapterConfig env fallbacks", async () => {
  const { resolveMailtrapAdapterConfig } = await import("../src/adapter.js");
  const resolved = resolveMailtrapAdapterConfig({});
  if (!resolved.fromAddress) throw new Error("fromAddress missing");
  if (!resolved.apiKey) throw new Error("apiKey missing");
  if (!resolved.webhookSecret) throw new Error("webhookSecret missing");
  console.log(`      from=${resolved.fromAddress}`);
});

// Full inbound → onNewMention → reply loop (stub inbound message fetch; live Email API send)
await check("inbound webhook → onNewMention → outbound reply", async () => {
  const { createHmac: hmac } = await import("node:crypto");
  const { createMailtrapAdapter } = await import("../src/index.js");
  const { WebhookHandler } = await import("../src/webhook-handler.js");
  const { MemoryStateAdapter } = await import("@chat-adapter/state-memory");
  const { Chat } = await import("chat");

  const secret = process.env.MAILTRAP_WEBHOOK_SECRET!;
  const state = new MemoryStateAdapter();
  await state.connect();

  const mailtrap = createMailtrapAdapter({ category: "chat-sdk" });
  const chat = new Chat({
    userName: "email-bot",
    adapters: { mailtrap },
    state,
  });

  let handledText = "";
  chat.onNewMention(async (thread, message) => {
    handledText = message.text;
    await thread.subscribe();
    await thread.post(`Got your email: ${message.text}`);
  });

  await chat.webhooks;

  const originalFetch = WebhookHandler.prototype.fetchEmailContent;
  WebhookHandler.prototype.fetchEmailContent = async () => ({
    id: "inbound-e2e-1",
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
    created_at: new Date().toISOString(),
    thread_id: "thr_test",
    attachments: [],
  });

  try {
    const body = JSON.stringify({
      events: [
        {
          event: "inbound.message_received",
          inbox_id: 42,
          message_id: "inbound-e2e-1",
        },
      ],
    });
    const signature = hmac("sha256", secret).update(body).digest("hex");
    const res = await chat.webhooks.mailtrap(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mailtrap-signature": signature,
        },
        body,
      }),
    );

    if (res.status !== 200) {
      throw new Error(`webhook status ${res.status}`);
    }
    if (handledText !== "Please check invoice 4821") {
      throw new Error(`handler text mismatch: ${handledText}`);
    }
    console.log("      inbound→handler→reply loop completed (send hit Mailtrap API or succeeded)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Domain quota still proves the reply path reached Email API after inbound handling
    if (
      handledText === "Please check invoice 4821" &&
      (msg.includes("reached its limit") ||
        msg.includes("403") ||
        msg.includes("Sending usage"))
    ) {
      console.log(`      inbound handled; outbound hit domain limit (${msg})`);
      return;
    }
    throw err;
  } finally {
    WebhookHandler.prototype.fetchEmailContent = originalFetch;
  }
});

if (process.exitCode) {
  console.log("\nSome tests failed.");
  process.exit(1);
}
console.log("\nAll integration checks passed.");
