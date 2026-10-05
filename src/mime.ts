import { Buffer } from "node:buffer";

/**
 * Attachment content still in the base64url text Gmail delivered it in (as ASCII bytes). It is
 * re-attached by re-wrapping that text as base64, without decoding the file and encoding it again.
 */
export class Base64UrlData {
  /** Length of the text without "=" padding. */
  private readonly chars: number;

  constructor(readonly base64url: Uint8Array) {
    let n = base64url.length;
    while (n && base64url[n - 1] === 0x3d) n--;
    this.chars = n;
  }

  /** The size of the file it encodes, in bytes. */
  get size(): number {
    return Math.floor((this.chars * 3) / 4);
  }

  /** Length of the same content as padded base64. */
  get base64Length(): number {
    return Math.ceil(this.chars / 4) * 4;
  }

  /** The file itself (only needed for attached emails, which may be sent as 7-bit text). */
  bytes(): Buffer {
    return Buffer.from(latin1(this.base64url.subarray(0, this.chars)), "base64url");
  }

  /** Standard base64 for characters [start, end) of the text, `end` a multiple of 4 unless it is the last block. */
  base64Block(start: number, end: number): string {
    return base64Of(Buffer.from(latin1(this.base64url.subarray(start, Math.min(end, this.chars))), "base64url"));
  }
}

export interface OutgoingAttachment {
  /** The file, or Gmail's base64url text of it (forwarded or kept attachments). */
  content: Buffer | Base64UrlData;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
  contentId?: string;
}

/** A parsed address with an optional display name. */
export interface Mailbox {
  name?: string;
  address: string;
}

/** Plain addresses typed by a user, or mailboxes carried over from existing headers. */
export type Recipient = string | Mailbox;

export interface OutgoingMessage {
  /** Only set to keep a draft's existing From (e.g. a send-as alias); Gmail fills it in otherwise. */
  from?: Mailbox;
  to?: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
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

/**
 * Encodes a header value as RFC 2047 encoded-words when it contains non-ASCII text (or when `force`
 * is set, e.g. for an ASCII value too long to fold). Each word is at most 64 characters, so even
 * `filename="` or "Subject: " plus the first word stays within 78.
 */
export function encodeHeaderValue(value: string, force = false): string {
  const clean = oneLine(value);
  if (isAscii(clean) && !force) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

/** An addr-spec: a dot-atom or quoted local part, then a domain; no control or invisible (format) characters. */
const ADDRESS_RE = /^(?:[^\s@<>(),;:"\[\]\\\p{Cc}\p{Cf}]+|"(?:[^"\\\p{Cc}\p{Cf}]|\\[^\p{Cc}\p{Cf}])+")@[^\s@<>(),;:"\[\]\\\p{Cc}\p{Cf}]+$/u;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export function isValidAddress(address: string): boolean {
  return ADDRESS_RE.test(address);
}

function toMailbox(field: string, recipient: Recipient): Mailbox {
  const mailbox = typeof recipient === "string" ? { address: recipient } : recipient;
  const address = mailbox.address.trim();
  if (!isValidAddress(address)) {
    if (HIDDEN_CHARACTER.test(address)) {
      throw new MimeError(
        `Invalid email address in "${field}": ${JSON.stringify(address)} contains an invisible or control character (often from copying). Retype it as plain text, like user@example.com.`,
      );
    }
    throw new MimeError(`Invalid email address in "${field}": "${address}". Use plain addresses like user@example.com.`);
  }
  return { name: mailbox.name?.trim() || undefined, address };
}

export function validateAddresses(field: string, recipients: Recipient[] | undefined): Mailbox[] {
  return (recipients ?? [])
    .filter((r) => (typeof r === "string" ? r : r.address).trim())
    .map((r) => toMailbox(field, r));
}

/** Formats a mailbox for a header, quoting or RFC 2047-encoding the display name as needed. */
export function formatMailbox(mailbox: Mailbox): string {
  if (!mailbox.name) return mailbox.address;
  const name = oneLine(mailbox.name);
  if (!isAscii(name)) return `${encodeHeaderValue(name)} <${mailbox.address}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ .]+$/.test(name) && !/^\.|\.$|\.\./.test(name)) {
    return `${name} <${mailbox.address}>`;
  }
  return `${quoteParam(name)} <${mailbox.address}>`;
}

function addressHeader(name: string, mailboxes: Mailbox[]): string | undefined {
  if (!mailboxes.length) return undefined;
  return `${name}: ${mailboxes.map(formatMailbox).join(`,${CRLF} `)}`;
}

/** Folds a long ASCII header at spaces so no line exceeds RFC 5322's limits. */
function foldHeader(name: string, value: string): string {
  const words = oneLine(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > 76 && line !== `${name}:`) {
      lines.push(line);
      line = "";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines.join(CRLF);
}

// ---------- building a message as chunks ----------

/**
 * A large piece of a message written straight into the final bytes (attachment contents), so no
 * long string is built, concatenated or encoded on the way.
 */
export interface ByteChunk {
  readonly length: number;
  /** Writes exactly `length` bytes at `pos` and returns the position after them. */
  write(out: Buffer, pos: number): number;
}

/** A message, or part of one: text (ASCII headers and boundaries) and byte chunks, in order. */
export type MimeChunk = string | ByteChunk;

/** Joins pieces with CRLF between them. */
function joinLines(items: (string | MimeChunk[])[]): MimeChunk[] {
  const out: MimeChunk[] = [];
  items.forEach((item, i) => {
    if (i) out.push(CRLF);
    if (typeof item === "string") out.push(item);
    else for (const chunk of item) out.push(chunk);
  });
  return out;
}

const encoder = new TextEncoder();

/** Bytes of a string that is (almost always) ASCII, one byte per character. */
function asciiBytes(text: string): Uint8Array {
  return /^[\x00-\x7f]*$/.test(text) ? Buffer.from(text, "latin1") : encoder.encode(text);
}

/** Standard base64 of `bytes`. */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Joins chunks into one byte array, allocated once at its final size. */
export function assembleMime(chunks: MimeChunk[]): Uint8Array<ArrayBuffer> {
  const pieces = chunks.map((c) => (typeof c === "string" ? asciiBytes(c) : c));
  // Every byte is written below (checked), so the buffer needn't be zeroed first.
  const out = Buffer.allocUnsafe(pieces.reduce((sum, p) => sum + p.length, 0));
  let pos = 0;
  for (const piece of pieces) {
    if (piece instanceof Uint8Array) {
      out.set(piece, pos);
      pos += piece.length;
    } else {
      const end = piece.write(out, pos);
      if (end !== pos + piece.length) throw new Error(`MIME chunk wrote ${end - pos} bytes instead of ${piece.length}`);
      pos = end;
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Characters per block when re-wrapping base64: a multiple of 76 (one line) and of 4 (3 bytes). */
const BASE64_BLOCK = 76 * 1024;

/**
 * Base64 of `content` in lines of 76 characters joined by CRLF, as a chunk. Blocks of the base64
 * text are made natively (decoding Gmail's base64url text and encoding it again, which also gives
 * canonical padding, exactly as decoding the whole file would) and copied line by line into place.
 */
function base64Chunk(content: Buffer | Base64UrlData): ByteChunk {
  const encoded = content instanceof Base64UrlData ? content.base64Length : Math.ceil(content.length / 3) * 4;
  const lines = Math.ceil(encoded / 76);
  // A block of base64 text: from Gmail's text, or encoded from the file (57 bytes per line).
  const block =
    content instanceof Base64UrlData
      ? (start: number) => content.base64Block(start, start + BASE64_BLOCK)
      : (start: number) => base64Of(content.subarray((start / 4) * 3, ((start + BASE64_BLOCK) / 4) * 3));
  return {
    length: encoded + Math.max(0, lines - 1) * 2,
    write(out, pos) {
      const scratch = Buffer.allocUnsafe(Math.min(BASE64_BLOCK, encoded));
      for (let start = 0; start < encoded; start += BASE64_BLOCK) {
        const length = scratch.write(block(start), 0, "latin1");
        for (let i = 0; i < length; i += 76) {
          if (start + i) {
            out[pos++] = 13;
            out[pos++] = 10;
          }
          pos += scratch.copy(out, pos, i, Math.min(i + 76, length));
        }
      }
      return pos;
    },
  };
}

function boundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `=_mcp_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function quoteParam(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** Splits `text` into pieces of at most `size` characters without splitting a %XX escape. */
function segments(text: string, size: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const token of text.match(/%[0-9A-F]{2}|[^]/g) ?? []) {
    if (current.length + token.length > size) {
      out.push(current);
      current = "";
    }
    current += token;
  }
  if (current || !out.length) out.push(current);
  return out;
}

/**
 * A name/filename parameter. Non-ASCII names get encoded-words (read by most clients) plus the
 * standard RFC 2231 form; long values are split into RFC 2231 continuations (`filename*0*=…`) on
 * their own folded lines, so no header line gets near the 998-character limit.
 */
function filenameParams(param: "name" | "filename", filename: string): string {
  const clean = oneLine(filename);
  if (isAscii(clean)) {
    if (clean.length <= 200) return `${param}=${quoteParam(clean)}`;
    return segments(clean, 54)
      .map((piece, i) => `${param}*${i}=${quoteParam(piece)}`)
      .join(`;${CRLF} `);
  }
  const ext = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const extended =
    ext.length <= 54
      ? `${param}*=UTF-8''${ext}`
      : segments(ext, 54)
          .map((piece, i) => `${param}*${i}*=${i ? "" : "UTF-8''"}${piece}`)
          .join(`;${CRLF} `);
  return `${param}=${quoteParam(encodeHeaderValue(clean))};${CRLF} ${extended}`;
}

function leafPart(headers: string[], content: Buffer | Base64UrlData): MimeChunk[] {
  return joinLines([...headers, "Content-Transfer-Encoding: base64", "", [base64Chunk(content)]]);
}

/**
 * An attached email (message/rfc822) as 7-bit text when it is plain ASCII with lines of at most 998
 * characters (RFC 2046 does not allow base64 there); undefined otherwise, to be sent as base64.
 */
function sevenBitMessage(content: Buffer): string | undefined {
  for (const byte of content) if (byte > 0x7e || byte === 0) return undefined;
  const text = latin1(content).replace(/\r?\n/g, CRLF);
  if (text.split(CRLF).some((line) => line.length > 998 || line.includes("\r"))) return undefined;
  return text.endsWith(CRLF) ? text.slice(0, -2) : text;
}

function textPart(subtype: "plain" | "html", text: string): MimeChunk[] {
  return leafPart([`Content-Type: text/${subtype}; charset=UTF-8`], Buffer.from(text, "utf8"));
}

function multipart(subtype: string, parts: MimeChunk[][]): MimeChunk[] {
  const b = boundary();
  return joinLines([
    `Content-Type: multipart/${subtype}; boundary="${b}"`,
    "",
    ...parts.map((p): MimeChunk[] => [`--${b}${CRLF}`, ...p]),
    `--${b}--`,
  ]);
}

/** A header with parameters; long or multi-line parameters start on their own folded line. */
function withParams(header: string, params: string): string {
  return params.includes(CRLF) || header.length + params.length > 76 ? `${header};${CRLF} ${params}` : `${header}; ${params}`;
}

function attachmentPart(att: OutgoingAttachment, index: number): MimeChunk[] {
  const filename = att.filename ?? `attachment-${index + 1}`;
  const mimeType = oneLine(att.mimeType || "application/octet-stream");
  const headers = [withParams(`Content-Type: ${mimeType}`, filenameParams("name", filename))];
  if (att.inline && att.contentId) {
    headers.push(withParams("Content-Disposition: inline", filenameParams("filename", filename)), `Content-ID: <${att.contentId}>`);
  } else {
    headers.push(withParams("Content-Disposition: attachment", filenameParams("filename", filename)));
  }
  if (/^message\/rfc822$/i.test(mimeType)) {
    const message = sevenBitMessage(att.content instanceof Base64UrlData ? att.content.bytes() : att.content);
    if (message !== undefined) return joinLines([...headers, "Content-Transfer-Encoding: 7bit", "", message]);
  }
  return leafPart(headers, att.content);
}

/** A Content-ID can be used as is when it is printable ASCII without spaces or <>"\\ (and not already taken). */
const PLAIN_CONTENT_ID = /^[\x21-\x7e]+$/;
const UNSAFE_IN_CONTENT_ID = /[<>"\\]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Gives every inline attachment a unique, plain-ASCII Content-ID and points the HTML's `cid:`
 * references at it. HTML refers to an attachment by its Content-ID if it came with one (forwarded
 * or saved images), otherwise by its filename (as the tools describe: `cid:<filename>`), written
 * as is or URL-encoded. When several attachments share a name, the n-th reference gets the n-th one.
 */
function assignContentIds(html: string, inline: OutgoingAttachment[]): { html: string; inline: OutgoingAttachment[] } {
  const used = new Set<string>();
  const renames = new Map<string, string[]>();
  const assigned = inline.map((att, i) => {
    const ref = oneLine(att.contentId ?? att.filename ?? `attachment-${i + 1}`).replace(/^<|>$/g, "");
    let cid = ref;
    if (!PLAIN_CONTENT_ID.test(cid) || UNSAFE_IN_CONTENT_ID.test(cid) || used.has(cid)) {
      const stem = ref.replace(/[^\w.-]+/g, "_").slice(0, 40) || "image";
      const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
      cid = `${stem}.${random}`;
    }
    used.add(cid);
    renames.set(ref, [...(renames.get(ref) ?? []), cid]);
    return { ...att, contentId: cid };
  });
  let out = html;
  // Longer names first, so "a.png" never matches inside "a.png.png".
  for (const [ref, cids] of [...renames].sort(([a], [b]) => b.length - a.length)) {
    if (cids.length === 1 && cids[0] === ref) continue;
    const forms = [...new Set([ref, encodeURI(ref), encodeURIComponent(ref), escapeHtml(ref)])].sort((a, b) => b.length - a.length);
    const re = new RegExp(`cid:(?:${forms.map(escapeRegExp).join("|")})(?=["'\\s)>]|&quot;|$)`, "gi");
    let n = 0;
    out = out.replace(re, () => `cid:${cids[Math.min(n++, cids.length - 1)]}`);
  }
  return { html: out, inline: assigned };
}

/** The size of an attachment's file in bytes. */
export function attachmentSize(content: Buffer | Base64UrlData): number {
  return content instanceof Base64UrlData ? content.size : content.length;
}

/** Builds a complete RFC 822 message as text. Gmail fills in From, Date and Message-ID on send. */
export function buildMime(msg: OutgoingMessage): string {
  return latin1(assembleMime(buildMimeChunks(msg)));
}

/**
 * Builds a complete RFC 822 message as chunks, for sending without building one long string:
 * attachments are written straight into the bytes that are uploaded (see assembleMime).
 */
export function buildMimeChunks(msg: OutgoingMessage): MimeChunk[] {
  const attachments = msg.attachments ?? [];
  const total = attachments.reduce((sum, a) => sum + attachmentSize(a.content), 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new MimeError(`Attachments total ${(total / 1048576).toFixed(1)} MB; Gmail allows at most 25 MB per message.`);
  }

  let body: MimeChunk[];
  const requested = msg.html ? attachments.filter((a) => a.inline) : [];
  const regular = attachments.filter((a) => !requested.includes(a));
  if (msg.html) {
    const { html, inline } = assignContentIds(msg.html, requested);
    const plain = msg.text ?? htmlToText(html);
    body = multipart("alternative", [textPart("plain", plain), textPart("html", html)]);
    if (inline.length) body = multipart("related", [body, ...inline.map((a, i) => attachmentPart({ ...a, inline: true }, i))]);
  } else {
    body = textPart("plain", msg.text ?? "");
  }
  if (regular.length) {
    body = multipart("mixed", [body, ...regular.map((a, i) => attachmentPart({ ...a, inline: false }, i))]);
  }

  const subject = oneLine(msg.subject ?? "");
  // RFC 5322 folds only at spaces: a word too long for one line (e.g. a long URL) needs encoded-words.
  const foldable = isAscii(subject) && !subject.split(" ").some((word) => word.length > 900);
  const headers = [
    msg.from ? `From: ${formatMailbox(toMailbox("from", msg.from))}` : undefined,
    addressHeader("To", validateAddresses("to", msg.to)),
    addressHeader("Cc", validateAddresses("cc", msg.cc)),
    addressHeader("Bcc", validateAddresses("bcc", msg.bcc)),
    foldable ? foldHeader("Subject", subject) : `Subject: ${encodeHeaderValue(subject, true)}`,
    msg.inReplyTo ? `In-Reply-To: ${oneLine(msg.inReplyTo)}` : undefined,
    msg.references ? foldHeader("References", msg.references) : undefined,
    "MIME-Version: 1.0",
  ].filter((h): h is string => Boolean(h));
  return joinLines([...headers, body]);
}

/** Accepts standard or URL-safe base64 (with or without padding/whitespace), or a base64 data: URL. */
export function decodeBase64(content: string): Buffer {
  const normalized = content
    .replace(/^\s*data:[^,]*;base64,/i, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new MimeError("Attachment content must be base64-encoded.");
  return Buffer.from(normalized, "base64");
}

// ---------- HTML entities ----------

/** Names for U+00A0…U+00FF, in order (HTML's Latin-1 entities). */
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para " +
  "middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute " +
  "Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute " +
  "THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde " +
  "ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

/** Greek letters: capitals from U+0391, small letters from U+03B1 (U+03A2 has no letter). */
const GREEK_NAMES = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega";

/** Every other HTML 4 entity, plus HTML5 names that show up in email. */
const OTHER_ENTITIES: Record<string, number> = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, QUOT: 34, AMP: 38, LT: 60, GT: 62, COPY: 169, REG: 174,
  Tab: 9, NewLine: 10, excl: 33, num: 35, dollar: 36, percnt: 37, lpar: 40, rpar: 41, ast: 42, plus: 43, comma: 44,
  period: 46, sol: 47, colon: 58, semi: 59, equals: 61, quest: 63, commat: 64, lsqb: 91, lbrack: 91, bsol: 92,
  rsqb: 93, rbrack: 93, Hat: 94, lowbar: 95, grave: 96, lcub: 123, lbrace: 123, verbar: 124, vert: 124, rcub: 125,
  rbrace: 125, half: 189, centerdot: 183,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, hairsp: 8202, ZeroWidthSpace: 8203, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  hyphen: 8208, dash: 8208, ndash: 8211, mdash: 8212, horbar: 8213, lsquo: 8216, rsquo: 8217, rsquor: 8217, sbquo: 8218,
  lsquor: 8218, ldquo: 8220, rdquo: 8221, rdquor: 8221, bdquo: 8222, ldquor: 8222, dagger: 8224, Dagger: 8225,
  bull: 8226, bullet: 8226, hellip: 8230, mldr: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
  rsaquo: 8250, oline: 8254, caret: 8257, frasl: 8260, NoBreak: 8288, euro: 8364, image: 8465, numero: 8470,
  weierp: 8472, real: 8476, trade: 8482, TRADE: 8482, alefsym: 8501, frac13: 8531, frac23: 8532, frac18: 8539,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658,
  dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713,
  ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776, ne: 8800,
  equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853,
  otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, loz: 9674,
  starf: 9733, star: 9734, phone: 9742, female: 9792, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  male: 9794, check: 10003, cross: 10007, lang: 10216, rang: 10217,
};

/** Named references, case-sensitive like HTML (`&Eacute;` is É, `&eacute;` is é). A Map, so `&constructor;` stays text. */
const NAMED_ENTITIES = new Map<string, string>([
  ...LATIN1_NAMES.split(" ").map((name, i): [string, string] => [name, String.fromCharCode(0xa0 + i)]),
  ...GREEK_NAMES.split(" ").flatMap((name, i): [string, string][] => {
    const lower: [string, string] = [name, String.fromCharCode(0x3b1 + i)];
    if (name === "sigmaf") return [lower];
    return [lower, [name[0].toUpperCase() + name.slice(1), String.fromCharCode(0x391 + i)]];
  }),
  ...Object.entries(OTHER_ENTITIES).map(([name, code]): [string, string] => [name, String.fromCodePoint(code)]),
]);

/** References browsers also accept without the ";" (when no letter, digit or "=" follows). */
const LEGACY_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "AMP", "LT", "GT", "QUOT", "COPY", "REG"]);

/** Numeric references to 0x80–0x9F mean Windows-1252 characters (e.g. `&#146;` is ’), as in browsers. */
const C1_AS_WINDOWS_1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";

const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/g;

function codePointText(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return C1_AS_WINDOWS_1252[code - 0x80];
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/** Decodes HTML character references: named (HTML 4 and common HTML5 names) and numeric. */
/**
 * Bytes as a Latin-1 string, one character per byte. (Typed via Uint8Array: the Worker's and Node's
 * type definitions disagree about Buffer#toString's parameters.)
 */
export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (match: string, hex: string | undefined, dec: string | undefined, name: string | undefined, semi: string, offset: number) => {
    if (hex) return codePointText(parseInt(hex, 16));
    if (dec) return codePointText(parseInt(dec, 10));
    if (semi) return NAMED_ENTITIES.get(name!) ?? match;
    // "&amp" without ";" is still "&" in HTML, unless it looks like part of a URL parameter (e.g. "&lt=5").
    const next = text.charAt(offset + match.length);
    return LEGACY_ENTITIES.has(name!) && !/[A-Za-z0-9=]/.test(next) ? NAMED_ENTITIES.get(name!)! : match;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- HTML to text ----------

/** Elements that start and end a paragraph (a blank line around them). */
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figure", "ul", "ol", "dl"]);
/** Elements that start and end a line. */
const LINE_TAGS = new Set([
  "div", "tr", "li", "dd", "dt", "table", "caption", "section", "article", "header", "footer", "nav", "aside", "main",
  "address", "center", "form", "fieldset", "legend", "details", "summary", "figcaption", "hr", "menu", "dir",
]);
/** Elements whose content is never shown. */
const HIDDEN_TAGS = ["script", "style", "title", "template", "xmp", "iframe", "noembed", "noframes"];
const HIDDEN_END = new Map(HIDDEN_TAGS.map((tag) => [tag, new RegExp(`</${tag}[\\s/>]`, "gi")]));
/** HTML's collapsible white space (plus no-break spaces, which emails use as padding). */
const HTML_SPACE = /[ \t\n\r\f ]+/g;

function isHtmlSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Reads a tag's attributes from `i` (just after its name) through the closing ">", like a browser:
 * quotes only matter around attribute values. Returns the index after ">", or -1 if the document ends
 * inside the tag (browsers then drop the rest). Linear in the tag's length.
 */
function scanAttributes(html: string, i: number, attrs?: Map<string, string>): number {
  const n = html.length;
  while (i < n) {
    let c = html.charCodeAt(i);
    if (c === 62 /* > */) return i + 1;
    if (isHtmlSpace(c) || c === 47 /* / */) {
      i++;
      continue;
    }
    const nameStart = i;
    i++; // the first character always belongs to the name, even "=" or a quote
    while (i < n && (c = html.charCodeAt(i)) !== 62 && c !== 61 && c !== 47 && !isHtmlSpace(c)) i++;
    const name = attrs ? html.slice(nameStart, i).toLowerCase() : "";
    while (i < n && isHtmlSpace(html.charCodeAt(i))) i++;
    if (html.charCodeAt(i) !== 61 /* = */) {
      if (attrs && !attrs.has(name)) attrs.set(name, "");
      continue;
    }
    i++;
    while (i < n && isHtmlSpace(html.charCodeAt(i))) i++;
    c = html.charCodeAt(i);
    let value: string;
    if (c === 34 || c === 39) {
      const close = html.indexOf(c === 34 ? '"' : "'", i + 1);
      if (close < 0) return -1;
      value = attrs ? html.slice(i + 1, close) : "";
      i = close + 1;
    } else {
      const start = i;
      while (i < n && (c = html.charCodeAt(i)) !== 62 && !isHtmlSpace(c)) i++;
      value = attrs ? html.slice(start, i) : "";
    }
    if (attrs && !attrs.has(name)) attrs.set(name, value);
  }
  return -1;
}

/** Collects output text, collapsing white space and blank lines as a browser lays them out. */
class TextBuilder {
  parts: string[] = [];
  private lineStart = true;
  private newlines = 0;
  /** A collapsed space is due before the next word. */
  space = false;
  /** A separator due before the next word on this line (a tab between table cells). */
  sep = "";
  /** A list marker due before the next word. */
  marker = "";

  private emit(s: string) {
    if (this.lineStart) {
      if (this.marker) this.parts.push(this.marker, " ");
    } else if (this.sep) this.parts.push(this.sep);
    else if (this.space) this.parts.push(" ");
    this.parts.push(s);
    this.lineStart = false;
    this.newlines = 0;
    this.space = false;
    this.sep = "";
    this.marker = "";
  }

  /** Normal text: runs of white space become one space, which is dropped at line starts. */
  text(raw: string) {
    const t = decodeEntities(raw).replace(HTML_SPACE, " ");
    if (!t) return;
    const lead = t.charCodeAt(0) === 32;
    const trail = t.length > 1 && t.charCodeAt(t.length - 1) === 32;
    if (lead) this.space = true;
    const core = t.slice(lead ? 1 : 0, trail ? -1 : t.length);
    if (core) this.emit(core);
    if (trail) this.space = true;
  }

  /** Preformatted text: spaces and line breaks are kept. */
  pre(raw: string) {
    const lines = decodeEntities(raw).replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
    lines.forEach((line, i) => {
      if (i) this.newline();
      if (line) this.emit(line);
    });
  }

  word(s: string) {
    if (s) this.emit(s);
  }

  /** A line break (<br>); more than one blank line in a row is not kept. */
  newline() {
    if (this.newlines < 2) this.parts.push("\n");
    this.newlines = Math.min(this.newlines + 1, 2);
    this.lineStart = true;
    this.space = false;
    this.sep = "";
  }

  /** Ends the current line, if anything is on it. */
  line() {
    if (!this.lineStart) this.newline();
  }

  /** Leaves a blank line before what follows (unless at the very start). */
  blank() {
    if (!this.parts.length || this.marker) return;
    this.line();
    if (this.newlines < 2) this.newline();
  }

  get length() {
    return this.parts.length;
  }

  textSince(index: number): string {
    return this.parts.slice(index).join("").trim();
  }

  toString() {
    return this.parts.join("").trim();
  }
}

/**
 * Converts an email's HTML to readable text, the way a browser would show it: white space collapses,
 * block elements and <br> make lines, lists get markers, table cells are separated by tabs, and links
 * keep their address as "label (url)". Runs in linear time on any input, including broken HTML.
 */
export function htmlToText(html: string): string {
  const b = new TextBuilder();
  const n = html.length;
  const lists: { ordered: boolean; next: number }[] = [];
  let link: { href: string; start: number; alts: string[] } | undefined;
  let pre = 0;
  let preStart = false;
  let pos = 0;

  const closeLink = () => {
    if (!link) return;
    const { href, start, alts } = link;
    link = undefined;
    const label = b.textSince(start);
    const url = href.trim();
    const alt = alts.join(" ").trim();
    if (!url || url.startsWith("#") || /^javascript:/i.test(url)) {
      if (!label) b.word(alt);
      return;
    }
    if (/^mailto:/i.test(url)) {
      if (!label) b.word(alt || decodeURIComponent(url.slice(7).split("?")[0]));
      return;
    }
    if (!label) {
      if (alt && alt !== url) {
        b.word(alt);
        b.space = true;
        b.word(`(${url})`);
      } else b.word(url);
      return;
    }
    if (label !== url) {
      b.space = true;
      b.word(`(${url})`);
    }
  };

  while (pos < n) {
    const lt = html.indexOf("<", pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos) {
      let raw = html.slice(pos, textEnd);
      if (pre) {
        if (preStart) raw = raw.replace(/^\r?\n/, "");
        b.pre(raw);
      } else b.text(raw);
      preStart = false;
    }
    if (lt < 0) break;
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      // Comments, including unterminated ones (which hide the rest, as in browsers), DOCTYPE and <![…]>.
      let end: number;
      if (html.startsWith("<!--", lt)) {
        if (html.startsWith("<!-->", lt)) end = lt + 5;
        else if (html.startsWith("<!--->", lt)) end = lt + 6;
        else {
          const close = html.indexOf("-->", lt + 4);
          end = close < 0 ? n : close + 3;
        }
      } else {
        const close = html.indexOf(">", lt + 2);
        end = close < 0 ? n : close + 1;
      }
      pos = end;
      continue;
    }
    if (c1 === 63 /* ? */ || (c1 === 47 /* / */ && !isLetter(html.charCodeAt(lt + 2)))) {
      const close = html.indexOf(">", lt + 2);
      pos = close < 0 ? n : close + 1;
      continue;
    }
    const closing = c1 === 47;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      // A "<" that doesn't start a tag is just text.
      if (pre) b.pre("<");
      else b.text("<");
      pos = lt + 1;
      continue;
    }
    let i = nameStart + 1;
    for (let c = html.charCodeAt(i); i < n && c !== 62 && c !== 47 && !isHtmlSpace(c); c = html.charCodeAt(++i));
    const tag = html.slice(nameStart, i).toLowerCase();
    const wantAttrs = !closing && (tag === "a" || tag === "img" || tag === "ol");
    const attrs = wantAttrs ? new Map<string, string>() : undefined;
    const end = scanAttributes(html, i, attrs);
    if (end < 0) break;
    pos = end;

    if (!closing && HIDDEN_END.has(tag)) {
      const re = HIDDEN_END.get(tag)!;
      re.lastIndex = pos;
      const m = re.exec(html);
      if (!m) break;
      const after = scanAttributes(html, m.index + 2 + tag.length);
      if (after < 0) break;
      pos = after;
      continue;
    }

    if (tag === "br") b.newline();
    else if (tag === "a") {
      closeLink();
      if (!closing) link = { href: decodeEntities(attrs!.get("href") ?? ""), start: b.length, alts: [] };
    } else if (tag === "img") {
      const alt = attrs?.get("alt");
      if (link && alt) link.alts.push(decodeEntities(alt).replace(HTML_SPACE, " ").trim());
    } else if (tag === "td" || tag === "th") {
      if (closing) b.sep = "\t";
    } else if (tag === "li") {
      b.line();
      if (!closing) {
        const list = lists.at(-1);
        b.marker = list?.ordered ? `${list.next++}.` : "-";
      }
    } else if (tag === "ul" || tag === "ol") {
      if (closing) lists.pop();
      if (lists.length) b.line();
      else b.blank();
      if (!closing) lists.push({ ordered: tag === "ol", next: Number.parseInt(attrs?.get("start") ?? "", 10) || 1 });
    } else if (PARAGRAPH_TAGS.has(tag)) {
      b.blank();
      if (tag === "pre") {
        pre = Math.max(0, pre + (closing ? -1 : 1));
        preStart = !closing;
      }
    } else if (LINE_TAGS.has(tag)) b.line();
  }
  closeLink();
  return b.toString();
}
