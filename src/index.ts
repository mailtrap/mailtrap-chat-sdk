// @mailtrap/chat-sdk-adapter

export type { ChatInstance } from "./adapter.js";
export {
  MailtrapAdapter,
  resolveMailtrapAdapterConfig,
} from "./adapter.js";
export type {
  MailtrapAdapterConfig,
  MailtrapAttachment,
  MailtrapRawMessage,
  MailtrapReceivedEmail,
  MailtrapThreadId,
  MailtrapWebhookPayload,
  ResolvedMailtrapAdapterConfig,
} from "./types.js";

import { MailtrapAdapter } from "./adapter.js";
import type { MailtrapAdapterConfig } from "./types.js";

/**
 * Create a new Mailtrap adapter instance.
 * Reads config + env vars:
 * MAILTRAP_API_TOKEN, MAILTRAP_WEBHOOK_SECRET, FROM_ADDRESS, FROM_NAME.
 */
export function createMailtrapAdapter(
  config: MailtrapAdapterConfig = {},
): MailtrapAdapter {
  return new MailtrapAdapter(config);
}
