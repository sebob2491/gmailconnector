import { htmlToText } from "./mime.js";

/** Subset of the Gmail API Message resource we rely on. */
export interface ApiMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: ApiMessagePart[];
}

export interface ApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: ApiMessagePart;
  raw?: string;
}

export type MessageFormat = "MINIMAL" | "METADATA_ONLY" | "FULL_CONTENT" | "PLAIN_TEXT" | "RAW";

export const METADATA_HEADERS = ["Subject", "From", "To", "Cc", "Bcc", "Date", "Message-ID", "References", "Reply-To"];

/** Maps a tool-level format to the Gmail API `format` query parameter. */
export function apiFormat(format: MessageFormat): "metadata" | "full" | "raw" {
  if (format === "RAW") return "raw";
  if (format === "MINIMAL" || format === "METADATA_ONLY") return "metadata";
  return "full";
}

export function header(part: ApiMessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Splits an address-list header on commas that are outside quotes, comments and angle brackets. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted) {
      current += ch + (value[++i] ?? "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && ch === "(") paren++;
    else if (!quoted && ch === ")") paren = Math.max(0, paren - 1);
    if (ch === "," && !quoted && !angle && !paren) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Returns the bare address from `"Name" <user@x.com>` or `user@x.com`. */
export function bareAddress(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1] : address).trim().toLowerCase();
}

export function decodeBody(data: string, contentType?: string): string {
  const buf = Buffer.from(data, "base64url");
  const charset = /charset="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export interface AttachmentInfo {
  id?: string;
  partId?: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface ExtractedContent {
  text?: string;
  html?: string;
  attachments: AttachmentInfo[];
}

/**
 * Walks a message payload collecting the first text/plain and text/html bodies plus attachments.
 * `loadData` fetches bodies Gmail stored out-of-line (large text parts carry only an attachmentId).
 */
export async function extractContent(
  payload: ApiMessagePart | undefined,
  loadData: (attachmentId: string) => Promise<string>,
): Promise<ExtractedContent> {
  const result: ExtractedContent = { attachments: [] };
  const visit = async (part: ApiMessagePart): Promise<void> => {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    if (part.parts?.length) {
      for (const child of part.parts) await visit(child);
      return;
    }
    const isBodyText =
      (mimeType === "text/plain" || mimeType === "text/html") && !part.filename && !disposition.startsWith("attachment");
    if (isBodyText) {
      const key = mimeType === "text/plain" ? "text" : "html";
      if (result[key] !== undefined) return;
      let data = part.body?.data;
      if (!data && part.body?.attachmentId) data = await loadData(part.body.attachmentId);
      result[key] = data ? decodeBody(data, header(part, "Content-Type")) : "";
      return;
    }
    if (part.filename || part.body?.attachmentId) {
      const contentId = header(part, "Content-ID")?.replace(/^<|>$/g, "");
      result.attachments.push({
        id: part.body?.attachmentId,
        partId: part.partId,
        filename: part.filename || "(unnamed)",
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
        inline: disposition.startsWith("inline") || (!disposition && Boolean(contentId)),
        ...(contentId ? { contentId } : {}),
      });
    }
  };
  if (payload) await visit(payload);
  return result;
}

export function viewUrl(email: string, fragment: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#${fragment}`;
}

export interface FormattedMessage {
  id: string;
  threadId: string;
  snippet?: string;
  subject?: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  date?: string;
  labelIds?: string[];
  plaintextBody?: string;
  htmlBody?: string;
  attachments?: Omit<AttachmentInfo, "partId">[];
  raw?: string;
  viewUrl: string;
}

export async function formatMessage(
  msg: ApiMessage,
  format: MessageFormat,
  email: string,
  loadData: (attachmentId: string) => Promise<string>,
): Promise<FormattedMessage> {
  const url = viewUrl(email, `all/${msg.id}`);
  if (format === "RAW") {
    return { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, raw: decodeBody(msg.raw ?? ""), viewUrl: url };
  }
  const p = msg.payload;
  const out: FormattedMessage = { id: msg.id, threadId: msg.threadId, viewUrl: url };
  if (format !== "METADATA_ONLY") {
    out.snippet = msg.snippet;
    out.subject = header(p, "Subject") ?? "";
  }
  out.sender = header(p, "From");
  out.toRecipients = parseAddressList(header(p, "To"));
  const cc = parseAddressList(header(p, "Cc"));
  const bcc = parseAddressList(header(p, "Bcc"));
  if (cc.length) out.ccRecipients = cc;
  if (bcc.length) out.bccRecipients = bcc;
  out.date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(p, "Date");
  out.labelIds = msg.labelIds ?? [];

  if (format === "FULL_CONTENT" || format === "PLAIN_TEXT") {
    const content = await extractContent(p, loadData);
    out.plaintextBody = content.text ?? (content.html !== undefined ? htmlToText(content.html) : "");
    if (format === "FULL_CONTENT" && content.html !== undefined) out.htmlBody = content.html;
    if (content.attachments.length) out.attachments = content.attachments.map(({ partId: _p, ...a }) => a);
  }
  return out;
}
