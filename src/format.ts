import { Buffer, isAscii } from "node:buffer";
import { decodeEntities, HtmlTextReader, isValidAddress, type Mailbox } from "./mime.js";

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
  return bodyTextStart(content, 0).text;
}

/**
 * The start of the readable body (see bodyText): about `maxChars` characters of it (0: all), and
 * whether that is all of it. Only that much of the body is converted.
 */
export function bodyTextStart(content: { text?: string; html?: string }, maxChars: number): { text: string; complete: boolean } {
  return bodyReader(content)(maxChars);
}

/**
 * Reads the readable body (see bodyText) in steps: each call gives the start of it, about `maxChars`
 * characters long (0: all of it), converting HTML only as far as it hasn't been already, and never
 * reading past `maxInput` characters of the part.
 */
function bodyReader(
  content: { text?: string; html?: string },
  maxInput = Infinity,
): (maxChars: number) => { text: string; complete: boolean } {
  const text = content.text;
  if (text?.trim()) {
    return (maxChars) => {
      const limit = Math.min(maxChars || Infinity, maxInput);
      if (text.length <= limit) return { text, complete: true };
      const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
      return { text: text.slice(0, end), complete: false };
    };
  }
  if (content.html !== undefined) {
    const reader = new HtmlTextReader(content.html);
    return (maxChars) => reader.read(maxChars, maxInput);
  }
  return () => ({ text: text ?? "", complete: true });
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
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

// ---------- quoted history ----------

/**
 * Verbs of attribution lines ("On <date>, <name> wrote:"), in the languages of common mail programs.
 * The verb may stand anywhere on the line: "Am Mo., 1. Jan. 2024 um 10:00 Uhr schrieb Hans <…>:".
 */
const ATTRIBUTION_VERB = new RegExp(
  String.raw`(?<!\p{L})(?:wrote|schrieb|a [ée]crit|escribi[óo]|ha scritto|scrisse|schreef|geschreven|skrev|napisa[łl](?:\(a\)|a)?|pisze|escreveu|kirjoitti|napsal(?:\(a\)|a)?|написал(?:\(а\)|а)?|пишет|yazd[ıi]|írta|έγραψε)(?!\p{L})|写道|작성`,
  "iu",
);
/** Attribution lines that name the sender by address, without a verb (Gmail in Russian, Japanese…). */
const ENDS_WITH_ADDRESS = /<[^<>\s@]+@[^<>\s]+>\)?\s?[:：]$/;

/** An attribution line: dated (a digit), a verb or the sender's address, ending with ":". */
function isAttribution(line: string): boolean {
  return line.length <= 400 && /[:：]$/.test(line) && /\d/.test(line) && (ATTRIBUTION_VERB.test(line) || ENDS_WITH_ADDRESS.test(line));
}

/** Outlook's "-----Original Message-----" line, also in other languages. */
const ORIGINAL_MESSAGE =
  /^-{2,}\s*(?:original message|urspr[üu]ngliche nachricht|message d'origine|mensaje original|messaggio originale|oorspronkelijk bericht|ursprungligt meddelande|oprindelig meddelelse|opprinnelig melding|oryginalna wiadomo[śs][ćc]|mensagem original)\s*-{2,}$/i;

/** The first three lines of an Outlook header block (From:, Sent:/Date:, To:/Subject:/Cc:), in several languages. */
const OUTLOOK_FROM = /^\*?(?:from|von|de|da|van|fr[åa]n|fra|od|l[äa]hett[äa]j[äa]|felad[óo]|от)\*?[ \t\u00a0]?:/i;
const OUTLOOK_SENT =
  /^\*?(?:sent|date|gesendet|datum|envoy[ée]|enviado|enviada|fecha|inviato|data|verzonden|skickat|sendt|wys[łl]ano|l[äa]hetetty|elk[üu]ldve|отправлено)\*?[ \t\u00a0]?:/i;
const OUTLOOK_TO =
  /^\*?(?:to|subject|cc|an|betreff|[àa]|objet|para|asunto|oggetto|aan|onderwerp|till|[äa]mne|til|emne|do|temat|dw|kopie|vastaanottaja|aihe|assunto|c[ée]zott|t[áa]rgy|кому|тема)\*?[ \t\u00a0]?:/i;
/** A line of a header block: a short label and ":". */
const HEADER_LINE = /^\*?[\p{L}][\p{L}\p{M} .'-]{0,30}\*?[ \t\u00a0]?:/u;
/** The rule Outlook puts above its header block in plain text. */
const SEPARATOR_LINE = /^(?:_{10,}|-{10,})$/;

/** A forwarded message's header: Gmail's, Thunderbird's and Apple Mail's, in several languages. */
const FORWARD_MARKER = new RegExp(
  [
    String.raw`^-{3,}\s*(?:forwarded message|weitergeleitete nachricht|message transf[ée]r[ée]|mensaje reenviado|messaggio inoltrato|doorgestuurd bericht|mensagem encaminhada|vidarebefordrat meddelande|videresendt meddelelse|videresendt melding|wiadomo[śs][ćc] przekazana dalej|пересланное сообщение)\s*-{3,}$`,
    String.raw`^(?:begin forwarded message|anfang der weitergeleiteten nachricht|d[ée]but du message r[ée]exp[ée]di[ée]|inicio del mensaje reenviado|inizio messaggio inoltrato|begin doorgestuurd bericht)\s?:$`,
  ].join("|"),
  "i",
);

/** Where quoted history starts in a reply: the text hidden from `index` on, quoting what starts at `body`. */
interface QuoteStart {
  index: number;
  body: number;
  /** An attribution line ("On … wrote:"), below which a reply may answer between quoted lines; otherwise an Outlook header. */
  attribution: boolean;
}

/** Where the line starting at `start` ends: at its "\n", or the text's end. */
function lineEnd(text: string, start: number): number {
  const nl = text.indexOf("\n", start);
  return nl < 0 ? text.length : nl;
}

/** White space at the end of a line, as trimEnd sees it (CR included). */
function isTrailingSpace(c: number): boolean {
  return c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** A line without its quote marks (">", nested or spaced) and surrounding blanks. */
function lineContent(text: string, start: number, end: number): string {
  let i = start;
  for (let c = text.charCodeAt(i); i < end && (c === 62 || c === 32 || c === 9 || c === 0xa0); c = text.charCodeAt(++i));
  let j = end;
  while (j > i && isTrailingSpace(text.charCodeAt(j - 1))) j--;
  return text.slice(i, j);
}

/** The content (see lineContent) of the line after the one ending at `end`, if there is one. */
function nextLine(text: string, end: number): { start: number; end: number; content: string } | undefined {
  if (end >= text.length) return undefined;
  const start = end + 1;
  const next = lineEnd(text, start);
  return { start, end: next, content: lineContent(text, start, next) };
}

/** Where the quoted text below a header block starts: after its header lines and the blank lines that follow. */
function afterHeaders(text: string, from: number): number {
  let headers = true;
  for (let start = from; start < text.length; ) {
    const end = lineEnd(text, start);
    const content = lineContent(text, start, end);
    if (!(headers && HEADER_LINE.test(content))) {
      headers = false;
      if (content) return start;
    }
    start = end + 1;
  }
  return text.length;
}

/**
 * Finds where a reply's quoted history starts: an attribution line ("On <date>, <name> wrote:", wrapped
 * onto a second line or not, inside a quote or not, in several languages), Outlook's
 * "-----Original Message-----", or its From:/Sent:/To: header block. Nothing is found below a
 * forwarded message's header: what follows it is the forwarded message, not quoted history.
 */
function findQuoteStart(text: string): QuoteStart | undefined {
  // The line before, when it isn't blank (an attribution may be wrapped onto two lines).
  let previousStart = -1;
  let previous = "";
  for (let start = 0; start <= text.length; ) {
    const end = lineEnd(text, start);
    const content = lineContent(text, start, end);
    if (content) {
      if (FORWARD_MARKER.test(content)) return undefined;
      if (ORIGINAL_MESSAGE.test(content)) return { index: start, body: afterHeaders(text, end + 1), attribution: false };
      if (OUTLOOK_FROM.test(content)) {
        const sent = nextLine(text, end);
        const to = sent && nextLine(text, sent.end);
        if (sent && to && OUTLOOK_SENT.test(sent.content) && OUTLOOK_TO.test(to.content)) {
          const index = previous && SEPARATOR_LINE.test(previous) ? previousStart : start;
          return { index, body: afterHeaders(text, start), attribution: false };
        }
      }
      const last = content.charCodeAt(content.length - 1);
      if (last === 58 /* : */ || last === 0xff1a /* ： */) {
        if (isAttribution(content)) return { index: start, body: end + 1, attribution: true };
        if (previous && isAttribution(`${previous} ${content}`)) return { index: previousStart, body: end + 1, attribution: true };
      }
    }
    previousStart = start;
    previous = content;
    start = end + 1;
  }
  return undefined;
}

/** Characters that leave a line looking empty: white space and the invisible padding stripInvisible removes. */
function isBlank(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 0xa0 || c === 0xfeff || (c >= 0x2000 && c <= 0x200f) || c === 0x3000 || c === 0xad || c === 0x34f || (c >= 0x2060 && c <= 0x206f);
}

/** Whether a reply answers between the quoted lines from `from` on (some lines start with ">", others don't). */
function answersBetweenQuotes(text: string, from: number): boolean {
  let quoted = false;
  let unquoted = false;
  for (let i = from; i < text.length; ) {
    // The first character on the line that isn't blank.
    let c = text.charCodeAt(i);
    while (i < text.length && isBlank(c)) c = text.charCodeAt(++i);
    if (i >= text.length) break;
    if (c !== 10) {
      if (c === 62 /* > */) quoted = true;
      else unquoted = true;
      if (quoted && unquoted) return true;
    }
    const nl = text.indexOf("\n", i);
    if (nl < 0) break;
    i = nl + 1;
  }
  return false;
}

/** Text as compared between a quote and the message it may be quoting: lower-case words, no links or punctuation. */
function quoteWords(text: string): string {
  const words = text.replace(/\b(?:https?:\/\/|www\.|mailto:)\S*/gi, " ").toLowerCase();
  if (/^[\x00-\x7f]*$/.test(words)) return words.replace(/[^a-z0-9]+/g, " ").trim();
  return stripInvisible(words).normalize("NFC").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

/** How much of a message's start (raw characters, and words) is compared with quotes. */
const KEY_SOURCE = 1000;
const KEY_LENGTH = 200;

/** The start of a message as compared with quotes in later replies (see hideQuotedHistory). */
export interface QuoteKey {
  /** The message's first words (see quoteWords), at most KEY_LENGTH characters. */
  start: string;
  /** Whether that is the whole message. */
  whole: boolean;
}

/** A message's QuoteKey, from its readable body (the start of it is enough). */
export function quoteKey(body: string): QuoteKey {
  const words = quoteWords(body.slice(0, KEY_SOURCE));
  return { start: words.slice(0, KEY_LENGTH), whole: body.length <= KEY_SOURCE && words.length <= KEY_LENGTH };
}

/**
 * Whether quoted text (its first words `quote`; `whole` if that is all of it) is a copy of the message
 * `key` describes: it holds the message's first words, or, for a short message, is exactly it; or the
 * quote, two words or more, is all there is and the message starts with it (a quote cut down to its
 * first lines).
 */
function quotes(quote: string, whole: boolean, key: QuoteKey): boolean {
  const start = key.start;
  if (!start || !quote) return false;
  if (start.length >= 24) {
    if (quote.includes(start.slice(0, 48))) return true;
  } else if (key.whole && quote === start) return true;
  return whole && quote.includes(" ") && start.startsWith(quote) && (start.length === quote.length || start[quote.length] === " ");
}

export const QUOTE_HIDDEN = "[Quoted earlier messages hidden: they're above in this thread. get_message shows this email in full.]";

/**
 * Removes a reply's quoted history, for thread views, where the messages it quotes are shown anyway:
 * only when the quoted text is a copy of one of the `earlier` messages of the thread (their QuoteKeys),
 * so a forwarded email or a quote of a message from elsewhere stays. Below an attribution line ("On …
 * wrote:"), it is kept when the reply answers between quoted lines; below an Outlook header (nobody
 * answers between the lines of one), it is cut whatever the lines look like. Lines may end in CRLF.
 */
export function hideQuotedHistory(text: string, earlier: readonly QuoteKey[] = []): string {
  if (!earlier.length) return text;
  const found = findQuoteStart(text);
  if (!found) return text;
  if (found.attribution && answersBetweenQuotes(text, found.body)) return text;
  const quote = quoteWords(text.slice(found.body, found.body + KEY_SOURCE));
  const whole = text.length - found.body <= KEY_SOURCE;
  // Most replies quote the message just before them: look there first.
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (quotes(quote, whole, earlier[i])) return `${text.slice(0, found.index).trimEnd()}\n\n${QUOTE_HIDDEN}`.trimStart();
  }
  return text;
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
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--; // don't split a surrogate pair
  return { text: text.slice(0, end), omitted: text.length - end };
}

/**
 * The start of a body read only partway, without a link it ends inside: cut short, the link would be
 * shown as it is instead of being shortened (it is read whole when more is read).
 */
function withoutCutLink(text: string): string {
  let i = text.length;
  for (let c = text.charCodeAt(i - 1); i > 0 && !(c <= 32 || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200b)); c = text.charCodeAt(--i - 1));
  return /https?:\/\//i.test(text.slice(i)) ? text.slice(0, i) : text;
}

/**
 * Bodies are read this far past the characters shown (1.5 times as many), since cleaning and cutting
 * links shrink them; the rest would be cut anyway.
 */
const READ_AHEAD = 1.5;

/** With a limit on characters shown, at most this many times as many characters of a body part are read. */
const MAX_READ_FACTOR = 64;

/**
 * The body as shown in results: line ends normalized, the quoted history cut (`hide`), cleaned, long
 * links cut (`shorten`). With a limit (`max`), only the start of the body is read: READ_AHEAD times
 * `max` characters, then more for as long as cleaning and cutting links leave no more than `max`, so
 * whatever fits within the limit comes out exactly as if all of it had been read (up to MAX_READ_FACTOR
 * times `max` characters of the part, which only markup or padding without text ever needs).
 * `complete` says whether everything was read (or everything not read was quoted history being hidden).
 */
function readableBody(
  content: ExtractedContent,
  max: number,
  opts: { hide: boolean; shorten: boolean; earlier: readonly QuoteKey[] },
): { text: string; shortened: number; complete: boolean } {
  const read = bodyReader(content, max ? max * MAX_READ_FACTOR + 65_536 : Infinity);
  let budget = max ? Math.ceil(max * READ_AHEAD) : 0;
  let previous = -1;
  for (;;) {
    const start = read(budget);
    const stuck = start.text.length === previous; // nothing more can be read
    previous = start.text.length;
    let text = start.complete || stuck ? start.text : withoutCutLink(start.text);
    let complete = start.complete;
    // The quoted history is cut (CRLF line ends and all) before cleaning, so the cleaning doesn't run
    // over text that is dropped.
    if (opts.hide) {
      const cut = hideQuotedHistory(text, opts.earlier);
      if (cut !== text) complete = true;
      text = cut;
    }
    text = cleanBody(text);
    let shortened = 0;
    if (opts.shorten) ({ text, shortened } = shortenLinks(text));
    if (complete || text.length > max || stuck) return { text, shortened, complete };
    // Read on: in proportion to how much cleaning took away, at least a quarter more, at most four times as much.
    const wanted = (budget * (max + 1) * 1.1) / Math.max(text.length, 1);
    budget = Math.ceil(Math.min(budget * 4, Math.max(budget * 1.25, wanted)));
  }
}

export interface FormatOptions {
  /** Maximum characters per body (plain text and HTML separately); 0 for no limit. */
  maxBodyChars?: number;
  /**
   * In PLAIN_TEXT, cut links over 200 characters to their site. Only for reading: never for text that
   * may be edited and saved again (drafts), since the cut links would replace the real ones.
   */
  shortenLinks?: boolean;
  /**
   * In PLAIN_TEXT, hide a reply's quoted copy of earlier messages of its thread, which a thread view
   * shows anyway (see formatThread; a message formatted on its own has no earlier messages).
   */
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

/** Whether a format shows bodies, which then have to be read. */
function showsBody(format: MessageFormat): boolean {
  return format === "FULL_CONTENT" || format === "PLAIN_TEXT";
}

export async function formatMessage(
  msg: ApiMessage,
  format: MessageFormat,
  email: string,
  loadData: (attachmentId: string) => Promise<string>,
  opts: FormatOptions = {},
): Promise<FormattedMessage> {
  return formatContent(msg, format, email, showsBody(format) ? await extractContent(msg.payload, loadData) : undefined, opts, []);
}

/**
 * Formats the messages of a thread, in order. With hideQuotedHistory (in PLAIN_TEXT), each reply's
 * quoted copy of an earlier message of the thread is hidden, as that message is in the result; any
 * other quote (a forwarded email, a message from elsewhere) stays, and the first message keeps its
 * quote. `loader` gives each message's loadData (see extractContent). Bodies are fetched in parallel.
 */
export async function formatThread(
  messages: ApiMessage[],
  format: MessageFormat,
  email: string,
  loader: (messageId: string) => (attachmentId: string) => Promise<string>,
  opts: FormatOptions = {},
): Promise<FormattedMessage[]> {
  const contents = showsBody(format) ? await Promise.all(messages.map((m) => extractContent(m.payload, loader(m.id)))) : [];
  const keys = opts.hideQuotedHistory && format === "PLAIN_TEXT" ? contents.map((c) => quoteKey(bodyTextStart(c, KEY_SOURCE).text)) : [];
  return messages.map((m, i) => formatContent(m, format, email, contents[i], opts, keys.slice(0, i)));
}

function formatContent(
  msg: ApiMessage,
  format: MessageFormat,
  email: string,
  content: ExtractedContent | undefined,
  opts: FormatOptions,
  earlier: readonly QuoteKey[],
): FormattedMessage {
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

  if (content) {
    const max = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    const reading = format === "PLAIN_TEXT";
    const body = readableBody(content, max, {
      hide: Boolean(opts.hideQuotedHistory && reading),
      shorten: Boolean(opts.shortenLinks && reading),
      earlier,
    });
    const shortenedLinks = body.shortened;
    const plain = limitLength(body.text, max);
    out.plaintextBody = plain.text;
    let omitted = plain.omitted;
    if (format === "FULL_CONTENT" && content.html !== undefined) {
      const html = limitLength(content.html, max);
      out.htmlBody = html.text;
      omitted = Math.max(omitted, html.omitted);
    }
    if (!body.complete) {
      // Only the start of the body was read, so how much more there is isn't known.
      out.truncated = "Body shortened; the rest is available with maxBodyChars: 0.";
    } else if (omitted) {
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
