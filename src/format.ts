import { Buffer, isAscii } from "node:buffer";
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

/** The charset parameter of a Content-Type header value, if any. */
export function charsetOf(contentType: string | undefined): string | undefined {
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
}

/**
 * The declared charset of the message part with `partId` (e.g. a Windows-1252 CSV attachment), from
 * its Content-Type header. Pass it to readTextFile/decodeTextFile so text attachments decode correctly.
 */
export function attachmentCharset(payload: ApiMessagePart | undefined, partId: string | undefined): string | undefined {
  if (partId === undefined) return undefined;
  const stack = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.partId === partId) return charsetOf(header(part, "Content-Type"));
    stack.push(...(part.parts ?? []));
  }
  return undefined;
}

/** Charsets whose text is all ASCII bytes, read through escape sequences (ISO-2022-JP, HZ, UTF-7). */
const SEVEN_BIT = /^(?:iso-?2022|csiso2022|hz-|utf-?7)/;

/** East Asian multibyte charsets, in which a few bytes of text can happen to be valid UTF-8 as well. */
const EAST_ASIAN = /^(?:gb|x-gbk|big5|cn-big5|csbig5|x-x-big5|shift[-_]?jis|x-sjis|sjis|ms_kanji|csshiftjis|windows-(?:31j|936|949|950)|euc-|x-euc|cseuc|ks_c_5601|ksc5601|korean)/;

/** True when `bytes` holds at most `max` bytes outside ASCII. */
function fewNonAscii(bytes: Uint8Array, max: number): boolean {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80 && ++n > max) return false;
  return true;
}

/** Charsets that mean "UTF-8 if it is valid": senders often label Windows-1252 text as one of these. */
const UTF8_LIKE = new Set(["utf-8", "utf8", "us-ascii", "ascii", "unicode-1-1-utf-8"]);

/**
 * Decodes text in its declared charset, except that non-ASCII bytes forming valid UTF-8 are read as
 * UTF-8 whatever the label says. Gmail hands out message bodies already converted to UTF-8 while the
 * part still declares its original charset (e.g. ISO-8859-1), and decoding those as declared turns
 * "—" into "â€”"; text really written in a single-byte or East Asian charset is almost never valid
 * UTF-8 (except a few characters of East Asian text, which are read as declared when they are valid
 * there). Undeclared, unknown or wrongly declared UTF-8 falls back to Windows-1252. `partial` says the
 * bytes are cut off, so a split last character doesn't count against UTF-8.
 */
export function decodeCharset(bytes: Uint8Array, declared?: string, partial = false): string {
  const charset = declared?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  const utf8 = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes, { stream: partial });
  // UTF-16/32 text is full of bytes that could pass as UTF-8 only by accident: trust the label.
  if (charset && /^utf-?(16|32)/.test(charset)) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // fall through
    }
  }
  // Plain ASCII reads the same in every charset except the 7-bit ones that switch modes with escapes.
  const ascii = isAscii(bytes);
  if (ascii && !(charset && SEVEN_BIT.test(charset))) return utf8();
  // A few bytes of GBK, Big5, Shift_JIS or EUC text can pass for UTF-8 by chance ("C4 A3" is 模 in GBK and ģ in
  // UTF-8), while text Gmail converted to UTF-8 has more than a few: up to 8 are read as declared if valid there.
  if (charset && EAST_ASIAN.test(charset) && fewNonAscii(bytes, 8)) {
    try {
      return new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(bytes, { stream: partial });
    } catch {
      // Not valid in the declared charset (or an unknown name): go on as for any other charset.
    }
  }
  if (!charset || UTF8_LIKE.has(charset) || !ascii) {
    try {
      return utf8();
    } catch {
      // Not UTF-8: decode as declared below.
    }
  }
  if (charset && !UTF8_LIKE.has(charset)) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown charset name.
    }
  }
  return new TextDecoder("windows-1252").decode(bytes);
}

export function decodeBody(data: string, contentType?: string): string {
  return decodeCharset(Buffer.from(data, "base64url"), charsetOf(contentType));
}

export interface AttachmentInfo {
  /** Gmail's attachment ID, used to download the file; not shown in results (they're long, and partId is stable). */
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

/** Parts nested deeper than this are ignored (real emails nest a few levels; this keeps the walk off the stack limit). */
export const MAX_MIME_DEPTH = 64;

/**
 * Walks a message payload collecting its body text and HTML plus attachments.
 * - Inside multipart/alternative, the first non-empty text/plain and the last HTML version win.
 * - format=flowed text has its soft line breaks joined (see unflow).
 * - Other multiparts (mixed, related, …) concatenate their body parts in order, so a body that
 *   Apple Mail splits around an inline attachment is kept whole.
 * - Attached emails (message/rfc822) are attachments; their text never becomes this message's body.
 * - An unnamed text/calendar part (how Exchange and Outlook send an invitation) is listed as the
 *   attachment "invite.ics", unless the email also attaches the event as a file (as Google Calendar does).
 * - Parts more than MAX_MIME_DEPTH levels down are ignored.
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
  const invites: AttachmentInfo[] = [];

  const walk = async (part: ApiMessagePart, embedded: boolean, depth: number): Promise<{ text?: string; html?: string }> => {
    if (depth > MAX_MIME_DEPTH) return {};
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    if (mimeType.startsWith("message/")) {
      if (part.body?.attachmentId || part.filename) {
        addAttachment(part, "attached-message.eml");
      } else {
        for (const child of part.parts ?? []) await walk(child, true, depth + 1);
      }
      return {};
    }
    if (part.parts?.length) {
      const results: { text?: string; html?: string }[] = [];
      for (const child of part.parts) results.push(await walk(child, embedded, depth + 1));
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
      const contentType = header(part, "Content-Type");
      const content = data ? decodeBody(data, contentType) : "";
      if (mimeType !== "text/plain") return { html: content };
      return { text: FLOWED.test(contentType ?? "") ? unflow(content, DEL_SP.test(contentType ?? "")) : content };
    }
    if (mimeType === "text/calendar" && !part.filename) {
      addAttachment(part, "invite.ics");
      invites.push(attachments[attachments.length - 1]);
    } else if (part.filename || part.body?.attachmentId) addAttachment(part, "(unnamed)");
    return {};
  };

  const { text, html } = payload ? await walk(payload, false, 0) : {};
  const calendarFile = (a: AttachmentInfo) => /^(?:text\/calendar|application\/ics)$/i.test(a.mimeType) || /\.(?:ics|vcs)$/i.test(a.filename);
  if (invites.length && attachments.some((a) => !invites.includes(a) && calendarFile(a))) {
    return { text, html, attachments: attachments.filter((a) => !invites.includes(a)) };
  }
  return { text, html, attachments };
}

const FLOWED = /;\s*format\s*=\s*"?flowed"?\s*(?:;|$)/i;
const DEL_SP = /;\s*delsp\s*=\s*"?yes"?\s*(?:;|$)/i;

/**
 * Joins the soft line breaks of format=flowed text (RFC 3676): a line ending in a space continues on the
 * next line of the same quote depth (with `delSp`, without that space). Quoted lines keep their depth,
 * as ">" marks; the space added in front of lines that start with ">", "From " or a space is removed;
 * the signature line "-- " stays a line of its own.
 */
export function unflow(text: string, delSp: boolean): string {
  const out: string[] = [];
  const marks = (depth: number) => (depth ? `${">".repeat(depth)} ` : "");
  let paragraph: string | undefined;
  let paragraphDepth = 0;
  for (const raw of text.split(/\r?\n/)) {
    let depth = 0;
    while (raw.charCodeAt(depth) === 62 /* > */) depth++;
    let line = raw.charCodeAt(depth) === 32 ? raw.slice(depth + 1) : raw.slice(depth);
    const flowed = line.endsWith(" ") && line !== "-- ";
    if (flowed && delSp) line = line.slice(0, -1);
    // An empty line ends a paragraph even after a soft break (stricter readings would swallow it).
    if (paragraph !== undefined && depth === paragraphDepth && line) paragraph += line;
    else {
      if (paragraph !== undefined) out.push(marks(paragraphDepth) + paragraph);
      paragraph = line;
      paragraphDepth = depth;
    }
    if (!flowed) {
      out.push(marks(depth) + paragraph);
      paragraph = undefined;
    }
  }
  if (paragraph !== undefined) out.push(marks(paragraphDepth) + paragraph);
  return out.join("\n");
}

/** The readable body: the plain-text part, or the HTML converted to text when that's missing or blank. */
export function bodyText(content: { text?: string; html?: string }): string {
  if (content.text?.trim()) return content.text;
  if (content.html !== undefined) return htmlToText(content.html);
  return content.text ?? "";
}

/** Gmail's internalDate (milliseconds since 1970) as ISO 8601 to the second, e.g. 2026-10-20T21:09:45Z; undefined if it isn't a time. */
export function isoTime(internalDate: string | number | undefined): string | undefined {
  if (internalDate === undefined || internalDate === "") return undefined;
  const date = new Date(Number(internalDate));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function viewUrl(email: string, fragment: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#${fragment}`;
}

/**
 * Invisible characters that marketing emails pad their previews with (combining grapheme joiner,
 * zero-width spaces, direction marks, soft hyphens, blank Braille and Hangul fillers, BOM).
 * U+200D (zero-width joiner) is kept because emoji sequences need it.
 */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u2800\u3164\ufeff\uffa0]/g;

/**
 * The zero-width non-joiner (U+200C) and Mongolian vowel separator (U+180E) are part of words in
 * Persian, Indic scripts and Mongolian ("می‌خواهم"), where they sit between letters (after any
 * combining marks). Anywhere else they are padding, like the "&zwnj;&nbsp;" runs in email previews.
 */
const STRAY_JOINER = /(?<!\p{L}\p{M}*)[\u200c\u180e]|[\u200c\u180e](?!\p{L})/gu;

/** Removes invisible padding characters, keeping joiners that are part of words. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "").replace(STRAY_JOINER, "");
}

/** Gmail snippets are HTML-escaped and often padded; returns readable text (or undefined if empty). */
export function cleanSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return undefined;
  const clean = stripInvisible(decodeEntities(snippet)).replace(/\s+/g, " ").trim();
  return clean || undefined;
}

/**
 * Runs of blank space to collapse: two or more of any space but tab and line feed, except plain spaces
 * that indent a line (list items, preformatted text, code), which match the first alternative and stay.
 */
const BLANK_RUN = /(\n|^) {2,}(?=\S)|[^\S\n\t]{2,}/g;

/** C0 control characters other than tab and line breaks; vertical tab and form feed count as line breaks. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Removes invisible padding and control characters, and collapses the runs of blank space they leave
 * behind (any Unicode space, and CRLF line ends). Tabs are kept: spreadsheet text uses them to separate
 * cells, including empty ones; so are the spaces that indent a line.
 */
export function cleanBody(text: string): string {
  return stripInvisible(text.replace(/\r\n?/g, "\n").replace(CONTROLS, (c) => (c === "\x0b" || c === "\x0c" ? "\n" : "")))
    .replace(BLANK_RUN, (run, lineStart: string | undefined) => (lineStart === undefined ? " " : run))
    .split("\n")
    .map((line) => line.trimEnd()) // not /[^\S\n]+\n/, which is quadratic on long runs of tabs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text from an attachment, as it is in the file: only a byte-order mark and NUL characters are removed,
 * and Windows (CRLF) line ends become plain newlines. Unlike cleanBody, spaces and tabs are kept (they
 * are indentation in code and YAML, and empty cells in tab-separated data).
 */
export function attachmentText(text: string): string {
  return text.replace(/^\ufeff/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n");
}

/**
 * Where a reply's quoted history starts: "On <date>, <name> wrote:" (possibly wrapped onto a second
 * line, and in a few languages), Outlook's "-----Original Message-----", or its "From:/Sent:" header block.
 */
const QUOTE_START = new RegExp(
  [
    String.raw`^On\b[^\n]{0,300}(?:\n[^\n]{0,300})?\b(?:wrote|schrieb|a écrit|escribió|scrisse|schreef|skrev|napisał)\s?:[ \t]*$`,
    String.raw`^-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$`,
    String.raw`^From:[^\n]+\n(?:Sent|Date):[^\n]+\n(?:To|Subject|Cc):`,
  ].join("|"),
  "im",
);

export const QUOTE_HIDDEN = "[Quoted earlier messages hidden: they're above in this thread. get_message shows this email in full.]";

/**
 * Removes the trailing quoted history from a reply, for thread views where the quoted messages are
 * already shown. Only cuts when everything after the marker is quote: all lines start with ">", or
 * none do (a top-posted reply). A mix means the sender answered between quoted lines, so it's kept.
 */
export function hideQuotedHistory(text: string): string {
  const match = QUOTE_START.exec(text);
  // Real "On … wrote:" lines carry a date or time; "On Monday the team wrote:" in prose doesn't count.
  if (!match || (/^on\b/i.test(match[0]) && !/\d/.test(match[0]))) return text;
  const after = text.slice(match.index + match[0].length).split("\n").filter((l) => l.trim());
  const quoted = after.filter((l) => l.trimStart().startsWith(">")).length;
  if (quoted && quoted < after.length) return text;
  return `${text.slice(0, match.index).trimEnd()}\n\n${QUOTE_HIDDEN}`.trimStart();
}

/** Links longer than this are nearly always tracking redirects; reading views cut them to their site. */
const LONG_LINK = 200;

/** Replaces each link longer than LONG_LINK characters with `https://site/…`, and counts them. */
export function shortenLinks(text: string): { text: string; shortened: number } {
  let shortened = 0;
  const out = text.replace(/\bhttps?:\/\/[^\s<>()"']+/gi, (url) => {
    if (url.length <= LONG_LINK) return url;
    shortened++;
    return `${/^https?:\/\/[^/?#]*/i.exec(url)![0]}/…`;
  });
  return { text: out, shortened };
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
  /**
   * In PLAIN_TEXT, cut links over 200 characters to their site. Only for reading: never for text that
   * may be edited and saved again (drafts), since the cut links would replace the real ones.
   */
  shortenLinks?: boolean;
  /** In PLAIN_TEXT, hide a reply's quoted history (for thread views, where it's shown anyway). */
  hideQuotedHistory?: boolean;
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
  /** The attachments as listed in results: without Gmail's attachment ID (get_attachment takes the partId). */
  attachments?: Omit<AttachmentInfo, "id">[];
  raw?: string;
  /** Set when a body was shortened; says how to get the rest. */
  truncated?: string;
  /** Set when long links were cut; says how to get them. */
  linksShortened?: string;
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
    out.subject = stripInvisible(header(p, "Subject") ?? "").trim();
  }
  out.sender = header(p, "From");
  out.toRecipients = parseAddressList(header(p, "To"));
  const cc = parseAddressList(header(p, "Cc"));
  const bcc = parseAddressList(header(p, "Bcc"));
  if (cc.length) out.ccRecipients = cc;
  if (bcc.length) out.bccRecipients = bcc;
  out.date = isoTime(msg.internalDate) ?? header(p, "Date");
  out.labelIds = msg.labelIds ?? [];

  if (format === "FULL_CONTENT" || format === "PLAIN_TEXT") {
    const content = await extractContent(p, loadData);
    const max = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    // The quoted history is cut before cleaning, so the cleaning doesn't run over text that is dropped.
    let body = bodyText(content).replace(/\r\n?/g, "\n");
    if (opts.hideQuotedHistory && format === "PLAIN_TEXT") body = hideQuotedHistory(body);
    body = cleanBody(body);
    let shortenedLinks = 0;
    if (opts.shortenLinks && format === "PLAIN_TEXT") ({ text: body, shortened: shortenedLinks } = shortenLinks(body));
    const plain = limitLength(body, max);
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
    if (shortenedLinks) {
      out.linksShortened =
        `${shortenedLinks} long link${shortenedLinks === 1 ? " was" : "s were"} cut to ${shortenedLinks === 1 ? "its" : "their"} website (https://site/…). ` +
        `For the full links, call again with messageFormat FULL_CONTENT (and maxBodyChars: 0 if the body was also shortened).`;
    }
    if (content.attachments.length) out.attachments = content.attachments.map(({ id: _id, ...listed }) => listed);
  }
  return out;
}
