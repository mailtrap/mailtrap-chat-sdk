import type { Root } from "mdast";
import { MailtrapFormatConverter } from "./format-converter.js";
import { escapeHtml, stripHtml } from "./utils.js";

interface RenderInput {
  formatted?: Root;
  text?: string;
}

interface RenderOutput {
  html: string;
  text: string;
}

const converter = new MailtrapFormatConverter();

export async function renderMessage(input: RenderInput): Promise<RenderOutput> {
  if (input.formatted) {
    const html = converter.fromAst(input.formatted);
    const text = input.text || stripHtml(html);
    return { html, text };
  }

  const text = input.text || "";
  const html = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;
  return { html, text };
}
