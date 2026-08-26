/**
 * Decoded thread identifier for Mailtrap email threads.
 * Encoded format: `mailtrap:{toAddress}:{rootMessageIdHash}`
 */
export interface MailtrapThreadId {
  /** SHA-256 hash (first 16 hex chars) of the root Message-ID */
  rootMessageIdHash: string;
  /** Counterparty email address — acts as "channel" identifier */
  toAddress: string;
}

export interface MailtrapRawMessage {
  attachments?: MailtrapAttachment[];
  cc?: string[];
  createdAt: string;
  from: string;
  headers?: Record<string, string>;
  html?: string;
  /** Mailtrap Email API message UUID (or inbound object id) */
  id: string;
  /** RFC 822 Message-ID header */
  messageId: string;
  subject: string;
  text?: string;
  to: string[];
  /** Mailtrap inbound thread id when known */
  mailtrapThreadId?: string | null;
}

export interface MailtrapAttachment {
  content?: string;
  contentType: string;
  filename: string;
  url?: string;
}

export interface MailtrapAdapterConfig {
  /** Mailtrap API token. Falls back to MAILTRAP_API_TOKEN env var. */
  apiKey?: string;
  /**
   * Email API category (X-MT-Category). Defaults to `chat-sdk`.
   * Applied to every outbound message.
   */
  category?: string;
  /**
   * Sender email address.
   * Falls back to FROM_ADDRESS env var. Required via config or env.
   */
  fromAddress?: string;
  /**
   * Display name for the From header.
   * Falls back to FROM_NAME env var.
   */
  fromName?: string;
  /** Webhook signing secret. Falls back to MAILTRAP_WEBHOOK_SECRET env var. */
  webhookSecret?: string;
}

/** Resolved adapter config after applying env fallbacks. */
export interface ResolvedMailtrapAdapterConfig extends MailtrapAdapterConfig {
  fromAddress: string;
}

export interface MailtrapInboundWebhookEvent {
  event: "inbound.message_received" | string;
  event_id?: string;
  id?: string;
  inbox_id?: number;
  inboxId?: number;
  message_id?: string;
  messageId?: string;
  inbound_message_id?: string;
  sender_name?: string;
  timestamp?: number;
}

export interface MailtrapWebhookPayload {
  events?: MailtrapInboundWebhookEvent[];
  event?: string;
  inbox_id?: number;
  message_id?: string;
}

export interface MailtrapReceivedEmail {
  attachments?: Array<{
    attachment_id?: string;
    content_type: string | null;
    filename: string | null;
    download_url?: string | null;
  }>;
  cc?: string[];
  created_at: string;
  from: string;
  headers?: Record<string, string> | null;
  html?: string | null;
  id: string;
  inbox_id: number;
  in_reply_to?: string | null;
  message_id: string;
  references?: string[];
  subject: string;
  text?: string | null;
  to: string[];
  thread_id?: string | null;
}
