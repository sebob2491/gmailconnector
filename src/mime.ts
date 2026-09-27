import { Buffer } from "node:buffer";

export interface OutgoingAttachment {
  content: Buffer;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
  contentId?: string;
}

export interface OutgoingMessage {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

export class MimeError extends Error {}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CRLF = "\r\n";

/** Strips CR/LF so user-supplied values can never inject extra headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** Encodes a header value as RFC 2047 encoded-words when it contains non-ASCII text. */
export function encodeHeaderValue(value: string): string {
  const clean = oneLine(value);
  if (isAscii(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

const ADDRESS_RE = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+$/;

export function validateAddresses(field: string, addresses: string[] | undefined): string[] {
  const list = (addresses ?? []).map((a) => a.trim()).filter(Boolean);
  for (const address of list) {
    if (!ADDRESS_RE.test(address)) {
      throw new MimeError(`Invalid email address in "${field}": "${address}". Use plain addresses like user@example.com.`);
    }
  }
  return list;
}

function addressHeader(name: string, addresses: string[]): string | undefined {
  if (!addresses.length) return undefined;
  return `${name}: ${addresses.join(`,${CRLF} `)}`;
}

function wrapBase64(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return (b64.match(/.{1,76}/g) ?? [""]).join(CRLF);
}

function boundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `=_gmail_mcp_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function quoteParam(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** filename parameter with an RFC 2231 extended form for non-ASCII names. */
function filenameParams(param: "name" | "filename", filename: string): string {
  const clean = oneLine(filename);
  if (isAscii(clean)) return `${param}=${quoteParam(clean)}`;
  const ext = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${param}=${quoteParam(encodeHeaderValue(clean))}; ${param}*=UTF-8''${ext}`;
}

function leafPart(headers: string[], content: Buffer): string {
  return [...headers, "Content-Transfer-Encoding: base64", "", wrapBase64(content)].join(CRLF);
}

function textPart(subtype: "plain" | "html", text: string): string {
  return leafPart([`Content-Type: text/${subtype}; charset=UTF-8`], Buffer.from(text, "utf8"));
}

function multipart(subtype: string, parts: string[]): string {
  const b = boundary();
  return [
    `Content-Type: multipart/${subtype}; boundary="${b}"`,
    "",
    ...parts.map((p) => `--${b}${CRLF}${p}`),
    `--${b}--`,
  ].join(CRLF);
}

function attachmentPart(att: OutgoingAttachment, index: number): string {
  const filename = att.filename ?? `attachment-${index + 1}`;
  const mimeType = oneLine(att.mimeType || "application/octet-stream");
  const headers = [`Content-Type: ${mimeType}; ${filenameParams("name", filename)}`];
  if (att.inline) {
    const cid = oneLine(att.contentId ?? filename).replace(/^<|>$/g, "");
    headers.push(`Content-Disposition: inline; ${filenameParams("filename", filename)}`, `Content-ID: <${cid}>`);
  } else {
    headers.push(`Content-Disposition: attachment; ${filenameParams("filename", filename)}`);
  }
  return leafPart(headers, att.content);
}

/** Builds a complete RFC 822 message. Gmail fills in From, Date and Message-ID on send. */
export function buildMime(msg: OutgoingMessage): string {
  const attachments = msg.attachments ?? [];
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new MimeError(`Attachments total ${(total / 1048576).toFixed(1)} MB; Gmail allows at most 25 MB per message.`);
  }

  let body: string;
  const inline = msg.html ? attachments.filter((a) => a.inline) : [];
  const regular = attachments.filter((a) => !inline.includes(a));
  if (msg.html) {
    const plain = msg.text ?? htmlToText(msg.html);
    body = multipart("alternative", [textPart("plain", plain), textPart("html", msg.html)]);
    if (inline.length) body = multipart("related", [body, ...inline.map(attachmentPart)]);
  } else {
    body = textPart("plain", msg.text ?? "");
  }
  if (regular.length) {
    body = multipart("mixed", [body, ...regular.map((a, i) => attachmentPart({ ...a, inline: false }, i))]);
  }

  const headers = [
    addressHeader("To", validateAddresses("to", msg.to)),
    addressHeader("Cc", validateAddresses("cc", msg.cc)),
    addressHeader("Bcc", validateAddresses("bcc", msg.bcc)),
    `Subject: ${encodeHeaderValue(msg.subject ?? "")}`,
    msg.inReplyTo ? `In-Reply-To: ${oneLine(msg.inReplyTo)}` : undefined,
    msg.references ? `References: ${oneLine(msg.references)}` : undefined,
    "MIME-Version: 1.0",
  ].filter((h): h is string => Boolean(h));
  return [...headers, body].join(CRLF);
}

/** Accepts standard or URL-safe base64 (with or without padding/whitespace). */
export function decodeBase64(content: string): Buffer {
  const normalized = content.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new MimeError("Attachment content must be base64-encoded.");
  return Buffer.from(normalized, "base64");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Small, dependency-free HTML to readable-text conversion for email bodies. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = decodeEntities(href);
      if (!label) return url;
      return url.startsWith("mailto:") || decodeEntities(label) === url ? label : `${label} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote)\s*>/gi, "\n")
    .replace(/<(p|div|h[1-6]|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
