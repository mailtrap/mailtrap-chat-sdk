import { Message, parseMarkdown } from "chat";
import type { MailtrapRawMessage, MailtrapReceivedEmail } from "./types.js";
import { parseEmailAddress, stripHtml } from "./utils.js";

const DISPLAY_NAME_RE = /^([^<]+)<[^>]+>$/;

export function parseInboundEmail(
  email: MailtrapReceivedEmail,
  threadId: string,
  fromAddress: string,
): Message<MailtrapRawMessage> {
  const authorEmail = parseEmailAddress(email.from);
  const authorName = extractDisplayName(email.from);
  const text = email.text || stripHtml(email.html || "");

  const raw: MailtrapRawMessage = {
    id: email.id,
    messageId: email.message_id,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    text: email.text ?? undefined,
    html: email.html ?? undefined,
    headers: email.headers ?? undefined,
    createdAt: email.created_at,
    mailtrapThreadId: email.thread_id,
    attachments: (email.attachments || []).map((a) => ({
      filename: a.filename || "attachment",
      contentType: a.content_type || "application/octet-stream",
      url: a.download_url ?? undefined,
    })),
  };

  return new Message({
    id: email.id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw,
    author: {
      userId: authorEmail,
      userName: authorEmail,
      fullName: authorName,
      isBot: false,
      isMe: authorEmail === fromAddress,
    },
    metadata: {
      dateSent: new Date(email.created_at),
      edited: false,
    },
    attachments: (email.attachments || []).map((a) => ({
      type: "file" as const,
      name: a.filename || "attachment",
      mimeType: a.content_type || "application/octet-stream",
    })),
    isMention: true,
  });
}

function extractDisplayName(from: string): string {
  const match = from.match(DISPLAY_NAME_RE);
  if (match?.[1]) {
    return match[1].trim();
  }
  return from;
}
