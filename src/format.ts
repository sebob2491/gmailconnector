import { Buffer } from "node:buffer";
import { decodeEntities, htmlToText, isValidAddress, type Mailbox } from "./mime.js";

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

/**
 * Parses an address-list header (RFC 5322, leniently) into mailboxes. Handles quoted display names
 * (which may contain commas or "<...>"), comments such as `root@host (Cron Daemon)`, and groups such
 * as `undisclosed-recipients:;` or `Team: a@x.com, b@y.com;`, whose names are dropped.
 */
export function parseMailboxes(value: string | undefined): Mailbox[] {
  const out: Mailbox[] = [];
  if (!value) return out;
  let text = "";
  let comment = "";
  let quoted = false;
  let depth = 0;
  let angle = false;
  const flush = () => {
    const mailbox = toMailbox(text, comment);
    if (mailbox) out.push(mailbox);
    text = "";
    comment = "";
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      text += ch;
      if (ch === "\\") text += value[++i] ?? "";
      else if (ch === '"') quoted = false;
    } else if (depth) {
      if (ch === "\\") comment += value[++i] ?? "";
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else comment += ch;
    } else if (angle) {
      text += ch;
      if (ch === ">") angle = false;
    } else if (ch === '"') {
      quoted = true;
      text += ch;
    } else if (ch === "(") {
      depth = 1;
    } else if (ch === "<") {
      angle = true;
      text += ch;
    } else if (ch === ":") {
      // Start of a group: what came before is the group's name, not an address.
      text = "";
      comment = "";
    } else if (ch === "," || ch === ";") {
      flush();
    } else {
      text += ch;
    }
  }
  flush();
  return out;
}

function unquote(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return trimmed;
}

function toMailbox(text: string, comment: string): Mailbox | undefined {
  const segment = text.trim();
  if (!segment) return undefined;
  // The address is the angle-addr at the end, outside any quoted display name.
  const angle = /<([^<>]*)>\s*$/.exec(segment);
  const raw = (angle ? angle[1] : segment).trim();
  // Whitespace inside a quoted local part ("john doe"@x.com) is part of the address.
  const address = raw.includes('"') ? raw : raw.replace(/\s+/g, "");
  if (!address.includes("@")) return undefined;
  const name = angle ? unquote(segment.slice(0, angle.index)) : comment.trim();
  return { address, ...(name ? { name } : {}) };
}

/** Real recipients from a header: valid addresses only, deduplicated (case-insensitive), minus `exclude`. */
export function recipientsFrom(value: string | undefined, exclude: string[] = []): Mailbox[] {
  const seen = new Set(exclude.map((a) => a.toLowerCase()));
  const out: Mailbox[] = [];
  for (const mailbox of parseMailboxes(value)) {
    const key = mailbox.address.toLowerCase();
    if (seen.has(key) || !isValidAddress(mailbox.address)) continue;
    seen.add(key);
    out.push(mailbox);
  }
  return out;
}

/** Returns the bare, lower-cased address from `"Name" <user@x.com>` or `user@x.com`. */
export function bareAddress(address: string): string {
  return (parseMailboxes(address)[0]?.address ?? address).trim().toLowerCase();
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
 * Walks a message payload collecting its body text and HTML plus attachments.
 * - Inside multipart/alternative, the first non-empty text/plain and the last HTML version win.
 * - Other multiparts (mixed, related, …) concatenate their body parts in order, so a body that
 *   Apple Mail splits around an inline attachment is kept whole.
 * - Attached emails (message/rfc822) are attachments; their text never becomes this message's body.
 * `loadData` fetches bodies Gmail stored out-of-line (large text parts carry only an attachmentId).
 */
export async function extractContent(
  payload: ApiMessagePart | undefined,
  loadData: (attachmentId: string) => Promise<string>,
): Promise<ExtractedContent> {
  const attachments: AttachmentInfo[] = [];
  const addAttachment = (part: ApiMessagePart, fallbackName: string) => {
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    const contentId = header(part, "Content-ID")?.replace(/^<|>$/g, "");
    attachments.push({
      id: part.body?.attachmentId,
      partId: part.partId,
      filename: part.filename || fallbackName,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      inline: disposition.startsWith("inline") || (!disposition && Boolean(contentId)),
      ...(contentId ? { contentId } : {}),
    });
  };
  const join = (values: (string | undefined)[]) => {
    const present = values.filter((v): v is string => v !== undefined);
    return present.length ? present.join("\n") : undefined;
  };

  const walk = async (part: ApiMessagePart, embedded: boolean): Promise<{ text?: string; html?: string }> => {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    if (mimeType.startsWith("message/")) {
      if (part.body?.attachmentId || part.filename) {
        addAttachment(part, "attached-message.eml");
      } else {
        for (const child of part.parts ?? []) await walk(child, true);
      }
      return {};
    }
    if (part.parts?.length) {
      const results: { text?: string; html?: string }[] = [];
      for (const child of part.parts) results.push(await walk(child, embedded));
      if (mimeType === "multipart/alternative") {
        const texts = results.map((r) => r.text).filter((t): t is string => t !== undefined);
        const htmls = results.map((r) => r.html).filter((h): h is string => h !== undefined);
        return { text: texts.find((t) => t.trim()) ?? texts[0], html: htmls.at(-1) };
      }
      return { text: join(results.map((r) => r.text)), html: join(results.map((r) => r.html)) };
    }
    const isBodyText =
      (mimeType === "text/plain" || mimeType === "text/html") && !part.filename && !disposition.startsWith("attachment");
    if (isBodyText) {
      if (embedded) return {};
      let data = part.body?.data;
      if (!data && part.body?.attachmentId) data = await loadData(part.body.attachmentId);
      const content = data ? decodeBody(data, header(part, "Content-Type")) : "";
      return mimeType === "text/plain" ? { text: content } : { html: content };
    }
    if (part.filename || part.body?.attachmentId) addAttachment(part, "(unnamed)");
    return {};
  };

  const { text, html } = payload ? await walk(payload, false) : {};
  return { text, html, attachments };
}

/** The readable body: the plain-text part, or the HTML converted to text when that's missing or blank. */
export function bodyText(content: { text?: string; html?: string }): string {
  if (content.text?.trim()) return content.text;
  if (content.html !== undefined) return htmlToText(content.html);
  return content.text ?? "";
}

export function viewUrl(email: string, fragment: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#${fragment}`;
}

/**
 * Invisible characters that marketing emails pad their previews with (combining grapheme joiner,
 * zero-width spaces/joiners, direction marks, soft hyphens, blank Braille and Hangul fillers, BOM).
 * U+200D is kept because emoji sequences need it.
 */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u2800\u3164\ufeff\uffa0]/g;

/** Gmail snippets are HTML-escaped and often padded; returns readable text (or undefined if empty). */
export function cleanSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return undefined;
  const clean = decodeEntities(snippet).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return clean || undefined;
}

/** Removes invisible padding and collapses the runs of blank space it leaves behind. */
export function cleanBody(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[ \t\u00a0]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bodies longer than this are shortened unless the caller asks for more (0 means no limit). */
export const DEFAULT_MAX_BODY_CHARS = 20_000;

/** Cuts `text` to `max` characters (never splitting an emoji) and says how much was left out. */
export function limitLength(text: string, max: number): { text: string; omitted: number } {
  if (!max || text.length <= max) return { text, omitted: 0 };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // don't split a surrogate pair
  return { text: text.slice(0, end), omitted: text.length - end };
}

export interface FormatOptions {
  /** Maximum characters per body (plain text and HTML separately); 0 for no limit. */
  maxBodyChars?: number;
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
  /** Set when a body was shortened; says how to get the rest. */
  truncated?: string;
  viewUrl: string;
}

export async function formatMessage(
  msg: ApiMessage,
  format: MessageFormat,
  email: string,
  loadData: (attachmentId: string) => Promise<string>,
  opts: FormatOptions = {},
): Promise<FormattedMessage> {
  const url = viewUrl(email, `all/${msg.id}`);
  if (format === "RAW") {
    return { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, raw: decodeBody(msg.raw ?? ""), viewUrl: url };
  }
  const p = msg.payload;
  const out: FormattedMessage = { id: msg.id, threadId: msg.threadId, viewUrl: url };
  if (format !== "METADATA_ONLY") {
    const snippet = cleanSnippet(msg.snippet);
    if (snippet) out.snippet = snippet;
    out.subject = (header(p, "Subject") ?? "").replace(INVISIBLE, "").trim();
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
    const max = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    const plain = limitLength(cleanBody(bodyText(content)), max);
    out.plaintextBody = plain.text;
    let omitted = plain.omitted;
    if (format === "FULL_CONTENT" && content.html !== undefined) {
      const html = limitLength(content.html, max);
      out.htmlBody = html.text;
      omitted = Math.max(omitted, html.omitted);
    }
    if (omitted) {
      out.truncated =
        `Body shortened: ${omitted.toLocaleString("en-US")} more characters not shown. ` +
        `Fetch it with get_message, get_thread or get_draft and maxBodyChars: 0 for the full text.`;
    }
    if (content.attachments.length) out.attachments = content.attachments.map(({ partId: _p, ...a }) => a);
  }
  return out;
}
