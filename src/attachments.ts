/**
 * Turns attachment bytes into something Claude can read: text for documents (including Word,
 * Excel, PowerPoint and many PDFs), or an image. Runs in Node and Cloudflare Workers (node:zlib is
 * available there via nodejs_compat; it is ~25x cheaper than DecompressionStream for many small streams).
 *
 * Readers take a character budget and stop once they have that much text, and unpack at most
 * MAX_PART_BYTES per part and MAX_FILE_BYTES per file, so large files and decompression bombs stay
 * within the Worker's memory and CPU limits. Results say when the text is incomplete and why.
 */
import { Buffer } from "node:buffer";
import { inflateRawSync, inflateSync } from "node:zlib";
import { attachmentText, decodeCharset, limitLength } from "./format.js";
import { htmlToText, latin1 } from "./mime.js";

export type AttachmentKind = "text" | "image" | "pdf" | "office" | "binary";

const TEXT_TYPES =
  /^(?:text\/|application\/(?:json|xml|csv|x-csv|ics|rtf|javascript|x-javascript|ecmascript|x-yaml|yaml|sql|x-sh|x-ndjson)$)|\+(?:json|xml)$/i;
const TEXT_EXTENSIONS = /\.(txt|csv|tsv|json|xml|ics|vcf|md|log|ya?ml|html?|eml|rtf|sql|ini|cfg|conf)$/i;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OFFICE_TYPE = /officedocument\.(wordprocessingml|spreadsheetml|presentationml)|ms-(word|excel|powerpoint)\.[\w.]*macroenabled/i;

/** Types that say nothing about the content ("download this"), so the file name decides. */
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/download",
  "application/x-download",
  "application/force-download",
  "application/unknown",
  "application/x-unknown",
]);

/** Common non-standard names for types we read. */
const TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "application/x-pdf": "application/pdf",
  "application/acrobat": "application/pdf",
};

const OOXML = "application/vnd.openxmlformats-officedocument";
const BY_EXTENSION: Record<string, string> = {
  docx: `${OOXML}.wordprocessingml.document`,
  dotx: `${OOXML}.wordprocessingml.template`,
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  xltx: `${OOXML}.spreadsheetml.template`,
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pptx: `${OOXML}.presentationml.presentation`,
  potx: `${OOXML}.presentationml.template`,
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  pdf: "application/pdf",
};

/**
 * The type to read a file as. Content with an unmistakable signature (PDF, PNG, JPEG, GIF, WebP)
 * wins over whatever the sender declared; ZIP files named .docx/.xlsx/.pptx are Office files; generic
 * types ("application/octet-stream", "application/x-download", …) fall back to the file name.
 */
export function sniffType(bytes: Uint8Array, mimeType: string, filename: string): string {
  const declared = mimeType.toLowerCase().split(";")[0].trim();
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (head.startsWith("%PDF")) return "application/pdf";
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  const type = TYPE_ALIASES[declared] ?? declared;
  const byName = BY_EXTENSION[/\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ""];
  if (head.startsWith("PK\x03\x04") && byName && (GENERIC_TYPES.has(type) || /zip|officedocument|ms-(word|excel|powerpoint)|msword/.test(type))) {
    return byName;
  }
  if (!GENERIC_TYPES.has(type)) return type;
  return byName ?? (type || "application/octet-stream");
}

export function kindOf(mimeType: string, filename: string): AttachmentKind {
  const type = mimeType.toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (OFFICE_TYPE.test(type)) return "office";
  if (TEXT_TYPES.test(type) || type === "message/rfc822" || TEXT_EXTENSIONS.test(filename)) return "text";
  return "binary";
}

/**
 * Decodes text bytes: a byte-order mark wins; then decodeCharset with the declared charset (the
 * attachment's Content-Type, or an HTML <meta>), which reads valid non-ASCII UTF-8 as UTF-8 and
 * otherwise the declared charset, else Windows-1252 (what Excel and Windows programs write).
 * `partial` says the bytes are cut off, so a split last character is fine.
 */
function decodeText(bytes: Uint8Array, declared: string | undefined, html: boolean, partial: boolean): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  let charset = declared;
  if (!charset?.trim() && html) {
    charset = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(latin1(bytes.subarray(0, 1024)))?.[1];
  }
  return decodeCharset(bytes, charset, partial);
}

export interface TextReadOptions extends ReadOptions {
  /** The charset parameter of the attachment's Content-Type, if any. */
  charset?: string;
}

/** Reads a text attachment (HTML is converted to readable text), decoding only as much as `maxChars` needs. */
export function readTextFile(bytes: Uint8Array, mimeType: string, filename: string, opts: TextReadOptions = {}): ReadResult {
  const budget = new Budget(opts.maxChars);
  const html = /html/i.test(mimeType) || /\.html?$/i.test(filename);
  // A character takes at most 4 bytes; HTML markup can take many more bytes per character of text, but only so much is converted.
  const maxBytes = html ? Math.min(budget.chars * 50, MAX_HTML_BYTES) : budget.chars * 4 + 4;
  const partial = bytes.length > maxBytes;
  if (html && bytes.length > MAX_HTML_BYTES) budget.cut(FILE_TOO_LARGE);
  const decoded = decodeText(partial ? bytes.subarray(0, maxBytes) : bytes, opts.charset, html, partial);
  const text = html ? htmlToText(decoded) : decoded.replace(/^\ufeff/, "");
  // When the whole file was decoded, the caller can count what it cuts; only a cut-off read means "more".
  return budget.result(text, partial || text.length > MAX_TEXT_CHARS);
}

/** The text of a text attachment as one string (with a note when it is incomplete). */
export function decodeTextFile(bytes: Uint8Array, mimeType: string, filename: string, charset?: string): string {
  return withNote(readTextFile(bytes, mimeType, filename, { charset }));
}

// ---------- limits ----------

/** Most text a reader returns, even when asked for everything (maxChars: 0). */
export const MAX_TEXT_CHARS = 1_000_000;
/** Most bytes one ZIP entry or PDF stream may unpack to (the Worker has 128 MB of memory in all). */
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** Most bytes of an HTML attachment that are converted to text (its markup is kept in memory several times over). */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
/** Most bytes all parts of one file may unpack to together, which also bounds the CPU spent. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Large parts compressed more than this are decompression bombs; real documents stay far below it. */
const MAX_RATIO = 500;

const PART_TOO_LARGE = "Part of this file is too large to read here, so only its beginning is shown.";
const PDF_PART_TOO_LARGE = "Part of this PDF is too large to read here and was skipped.";
const FILE_TOO_LARGE = "This file is too large to read here in full, so only its beginning is shown.";
const TEXT_TOO_LONG = `The text is longer than ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters, so only the beginning is shown.`;

/** Most tokens (operands and operators) of a PDF's content streams that are read; a few bytes each, far more than a text layer needs. */
const MAX_PDF_TOKENS = 8_000_000;
const PDF_TOO_COMPLEX = "This PDF's content is too complex to read here in full, so only the first part is shown.";

/** Thrown when a file can't be read within the memory limits, e.g. a decompression bomb. */
export class FileTooLargeError extends Error {}

export interface ReadOptions {
  /** Stop once this many characters of text are collected; 0 (or omitted) reads up to MAX_TEXT_CHARS. */
  maxChars?: number;
}

export interface ReadResult {
  text: string;
  /** Reading stopped because `maxChars` characters were collected; asking for more shows more. */
  more?: boolean;
  /** Why the text stops early no matter what `maxChars` asks for (size limits). */
  incomplete?: string;
}

/** Tracks what one file's reading may still spend. */
class Budget {
  /** Characters to collect before stopping. */
  readonly chars: number;
  /** True when `chars` is the caller's own limit rather than MAX_TEXT_CHARS. */
  private readonly callerLimit: boolean;
  private unpacked = 0;
  /** Content-stream tokens that may still be read. */
  tokens = MAX_PDF_TOKENS;
  incomplete?: string;

  constructor(maxChars?: number) {
    this.callerLimit = Boolean(maxChars && maxChars > 0 && maxChars < MAX_TEXT_CHARS);
    this.chars = this.callerLimit ? maxChars! : MAX_TEXT_CHARS;
  }

  /** Bytes the next part may unpack to. */
  get partBytes(): number {
    return Math.min(MAX_PART_BYTES, MAX_FILE_BYTES - this.unpacked);
  }

  spend(bytes: number) {
    this.unpacked += bytes;
  }

  cut(reason: string) {
    this.incomplete ??= reason;
  }

  /** The result, given the text and whether reading stopped because enough text was collected. */
  result(text: string, stopped: boolean): ReadResult {
    const out: ReadResult = { text };
    if (stopped) {
      if (this.callerLimit) out.more = true;
      else this.cut(TEXT_TOO_LONG);
    }
    if (this.incomplete) out.incomplete = this.incomplete;
    return out;
  }
}

/**
 * What get_attachment shows for a read file: its text (as it is in the file, cut to `maxChars`; 0
 * means as much as can be read) and, when text is missing, a note saying why and whether calling
 * again with a larger maxChars would show more.
 */
export function attachmentResult(read: ReadResult, maxChars: number): { text: string; truncated?: string } {
  const callerLimit = maxChars > 0 && maxChars < MAX_TEXT_CHARS;
  const { text, omitted } = limitLength(attachmentText(read.text), callerLimit ? maxChars : MAX_TEXT_CHARS);
  const notes: string[] = [];
  if (callerLimit && read.more) {
    notes.push(
      `Shortened: only the first ${maxChars.toLocaleString("en-US")} characters are shown. ` +
        `Call again with a larger maxChars (or 0, for up to ${MAX_TEXT_CHARS.toLocaleString("en-US")}) to read further.`,
    );
  } else if (callerLimit && omitted) {
    notes.push(
      `Shortened: ${omitted.toLocaleString("en-US")} more characters not shown. ` +
        `Call again with maxChars: 0 for ${read.incomplete ? "them" : "all of it"}.`,
    );
  } else if (omitted && !read.incomplete) {
    notes.push(TEXT_TOO_LONG);
  }
  if (read.incomplete) notes.push(`${read.incomplete} Open it in Gmail with viewUrl to see the rest.`);
  return notes.length ? { text, truncated: notes.join(" ") } : { text };
}

/** Appends a note about missing text, for callers that only take a string. */
function withNote(result: ReadResult): string {
  return result.incomplete ? `${result.text}\n\n[${result.incomplete}]` : result.text;
}

// ---------- decompression ----------

/**
 * Inflates zlib or raw deflate data, refusing to produce more than `maxBytes` (it throws instead, so
 * a decompression bomb can't exhaust memory). Z_SYNC_FLUSH tolerates streams with trailing bytes or
 * a missing end marker (common in PDFs), and makes a cut-off input inflate to the start of the output.
 */
function inflate(data: Uint8Array, format: "deflate" | "deflate-raw", maxBytes: number): Buffer {
  const opts = { finishFlush: 2 /* Z_SYNC_FLUSH */, maxOutputLength: Math.max(1, maxBytes) };
  return format === "deflate" ? inflateSync(data, opts) : inflateRawSync(data, opts);
}

/** True for the error inflate throws when output would pass maxOutputLength (Node and Workers word it differently). */
function isOverLimit(err: unknown): boolean {
  return err instanceof RangeError || /too large|memory limit|maxOutputLength/i.test(String((err as Error | undefined)?.message));
}

// ---------- ZIP (the container format of .docx/.xlsx/.pptx) ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && pos + 46 <= bytes.length; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    entries.push({
      method: view.getUint16(pos + 10, true),
      compressedSize: view.getUint32(pos + 20, true),
      size: view.getUint32(pos + 24, true),
      localOffset: view.getUint32(pos + 42, true),
      name: new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength)),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads up to `want` bytes of an entry's content as text; `cut` says the entry has more. Entries larger
 * than needed are read by inflating a matching share of their compressed data, so a large sheet costs
 * only what is shown. Throws FileTooLargeError for entries that unpack to far more than they claim.
 */
function readEntry(bytes: Uint8Array, entry: ZipEntry, budget: Budget, want = MAX_PART_BYTES): { xml: string; cut: boolean } {
  if (entry.localOffset < 0 || entry.localOffset + 30 > bytes.length) throw new Error("damaged ZIP file: an entry lies beyond its end");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const packed = bytes.subarray(start, start + entry.compressedSize);
  const limit = Math.min(want, budget.partBytes);
  if (limit <= 0) {
    budget.cut(FILE_TOO_LARGE);
    return { xml: "", cut: true };
  }
  const done = (data: Uint8Array, cut: boolean) => {
    budget.spend(data.length);
    return { xml: new TextDecoder().decode(data), cut };
  };
  if (entry.method === 0) return done(packed.subarray(0, limit), packed.length > limit);
  if (entry.method !== 8) throw new Error(`unsupported ZIP compression method ${entry.method}`);
  // 0xFFFFFFFF is the ZIP64 marker (the real size is elsewhere, and some writers put it even on small entries): size unknown.
  const size = entry.size === 0xffffffff ? undefined : entry.size;
  if (size !== undefined && size > MAX_PART_BYTES && size / Math.max(1, packed.length) > MAX_RATIO) {
    throw new FileTooLargeError(
      "This file unpacks to far more data than its size suggests (a damaged file or a decompression bomb), so it wasn't read.",
    );
  }
  if (size === undefined || size <= limit) {
    try {
      return done(inflate(packed, "deflate-raw", limit), false);
    } catch (err) {
      if (!isOverLimit(err)) throw err;
      if (size !== undefined) throw new FileTooLargeError("This file unpacks to more data than it declares (a damaged file or a decompression bomb), so it wasn't read.");
    }
  }
  // Inflate only the share of the compressed data that should unpack to `limit` bytes (an unknown size is taken as the usual ratio).
  let take = Math.max(1024, Math.floor(packed.length * (limit / (size ?? packed.length * 8)) * 0.9));
  for (let attempt = 0; attempt < 3; attempt++, take = Math.floor(take / 4)) {
    try {
      return done(inflate(packed.subarray(0, take), "deflate-raw", limit), true);
    } catch (err) {
      if (!isOverLimit(err)) throw err;
    }
  }
  throw new FileTooLargeError("This file unpacks to far more data than its size suggests (a damaged file or a decompression bomb), so it wasn't read.");
}

/** The first read of a part whose parser can continue from where it stopped (sheets, shared strings); reads grow from there. */
const FIRST_READ_BYTES = 64 * 1024;

/**
 * How many bytes of XML to unpack first for `chars` characters of text from a parser that starts
 * over when it falls short (documents and slides, whose markup takes many bytes per character).
 */
function firstReadBytes(chars: number): number {
  return Math.min(MAX_PART_BYTES, Math.max(FIRST_READ_BYTES, chars * 16));
}

// ---------- XML ----------

const XML_NAMED: Record<string, number> = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39 };
/** Where the entity entityCode last read ends (the index after its ";"). */
let entityEnd = 0;
/** The code units of decoded entities, turned into text a chunk at a time. */
const XML_UNITS: number[] = [];

/** The code point of the entity at `amp` (one of the five named ones, or &#N; / &#xH; with up to 8 digits and a valid code point), or -1. */
function entityCode(text: string, amp: number): number {
  let semi = -1;
  for (let p = amp + 2, stop = Math.min(text.length, amp + 12); p < stop; p++) {
    if (text.charCodeAt(p) === 59 /* ; */) {
      semi = p;
      break;
    }
  }
  if (semi < 0) return -1;
  entityEnd = semi + 1;
  if (text.charCodeAt(amp + 1) === 35 /* # */) {
    const hex = text.charCodeAt(amp + 2) === 120 || text.charCodeAt(amp + 2) === 88; /* x X */
    let p = amp + (hex ? 3 : 2);
    if (p === semi || semi - p > 8) return -1;
    let code = 0;
    for (; p < semi; p++) {
      const d = text.charCodeAt(p);
      const v = hex ? (d < 128 ? HEX_VALUE[d] : -1) : d >= 48 && d <= 57 ? d - 48 : -1;
      if (v < 0) return -1;
      code = code * (hex ? 16 : 10) + v;
    }
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? code : -1;
  }
  return XML_NAMED[text.slice(amp + 1, semi)] ?? -1;
}

/**
 * Decodes XML's five named entities and numeric character references, by a scan: only what is
 * decoded is copied, in chunks, so a million references cost their length, not an object each.
 */
function decodeXml(text: string): string {
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  let out = "";
  let pos = 0;
  let count = 0;
  const flush = () => {
    if (!count) return;
    XML_UNITS.length = count;
    out += String.fromCharCode.apply(null, XML_UNITS);
    count = 0;
  };
  while (amp >= 0) {
    const code = entityCode(text, amp);
    if (code < 0) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    if (amp > pos) {
      flush();
      out += text.slice(pos, amp);
    }
    if (code > 0xffff) {
      XML_UNITS[count++] = 0xd800 + ((code - 0x10000) >> 10);
      XML_UNITS[count++] = 0xdc00 + ((code - 0x10000) & 0x3ff);
    } else XML_UNITS[count++] = code;
    if (count >= STRING_CHUNK - 1) flush();
    pos = entityEnd;
    amp = text.indexOf("&", pos);
  }
  flush();
  return pos < text.length ? out + text.slice(pos) : out;
}

/**
 * An element tag: `name` is the local name, without any namespace prefix (`x:row` and `row` are
 * both "row"); its attributes sit in `xml` at [attrStart, attrEnd) and are read with attr(); `end`
 * is the index after ">". One object serves every tag of a walk, so a handler must not keep it.
 */
interface XmlTag {
  name: string;
  close: boolean;
  empty: boolean;
  xml: string;
  attrStart: number;
  attrEnd: number;
  end: number;
}

const TAG: XmlTag = { name: "", close: false, empty: false, xml: "", attrStart: 0, attrEnd: 0, end: 0 };

/** True for the characters that end an element or attribute name: white space and the delimiters / > < ! ? " ' =. */
function isXmlNameEnd(c: number): boolean {
  return c <= 32 || c === 47 || c === 62 || c === 60 || c === 33 || c === 63 || c === 34 || c === 39 || c === 61;
}

/**
 * Walks XML in one pass from `from`: `onTag` gets each element tag and `onText` each run of
 * character data (decoded). Either returns true to stop. Malformed markup ends the walk. Linear
 * time, by character code: Office parts have millions of tags.
 */
function walkXml(xml: string, onTag: (tag: XmlTag) => boolean | void, onText: (text: string) => boolean | void, from = 0): void {
  const n = xml.length;
  let pos = from;
  TAG.xml = xml;
  while (pos < n) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos && onText(decodeXml(xml.slice(pos, textEnd)))) return;
    if (lt < 0) return;
    const c = xml.charCodeAt(lt + 1);
    if (c === 33 /* ! */ || c === 63 /* ? */) {
      if (xml.startsWith("<![CDATA[", lt)) {
        const end = xml.indexOf("]]>", lt + 9);
        if (end < 0 || onText(xml.slice(lt + 9, end))) return;
        pos = end + 3;
        continue;
      }
      if (xml.startsWith("<!--", lt)) {
        const end = xml.indexOf("-->", lt + 4);
        if (end < 0) return;
        pos = end + 3;
        continue;
      }
      const end = xml.indexOf(">", lt); // <!DOCTYPE, <?xml
      if (end < 0) return;
      pos = end + 1;
      continue;
    }
    // A tag: "<" [/] name [attributes] [/] ">"; attributes start with white space or "/", and their quoted values may hold ">".
    const close = c === 47;
    let p = close ? lt + 2 : lt + 1;
    const nameStart = p;
    let colon = -1;
    for (; p < n; p++) {
      const d = xml.charCodeAt(p);
      if (isXmlNameEnd(d)) break;
      if (d === 58 && colon < 0) colon = p;
    }
    const attrStart = p;
    if (p === nameStart || p >= n) return;
    let quote = 0;
    for (; p < n; p++) {
      const d = xml.charCodeAt(p);
      if (quote) {
        if (d === quote) quote = 0;
      } else if (d === 34 || d === 39) quote = d;
      else if (d === 62) break;
      else if (d === 60) return;
    }
    if (p >= n) return;
    const empty = p > attrStart && xml.charCodeAt(p - 1) === 47;
    TAG.name = xml.slice(colon >= 0 ? colon + 1 : nameStart, attrStart);
    TAG.close = close;
    TAG.empty = empty;
    TAG.attrStart = attrStart;
    TAG.attrEnd = empty ? p - 1 : p;
    TAG.end = p + 1;
    if (onTag(TAG)) return;
    pos = p + 1;
  }
}

/** Where the attribute value findAttr last found ends. */
let attrValueEnd = 0;

/**
 * Where a tag's attribute value starts in its XML, by local name (any namespace prefix, or, when
 * `prefixed`, only with one), with its end left in attrValueEnd; -1 when the tag has no such attribute.
 */
function findAttr(tag: XmlTag, name: string, prefixed: boolean): number {
  const { xml, attrEnd } = tag;
  let p = tag.attrStart;
  while (p < attrEnd) {
    const c = xml.charCodeAt(p);
    if (isXmlNameEnd(c)) {
      p++;
      continue;
    }
    // The qualified name, "=" (white space around it allowed) and the quoted value.
    const start = p;
    let local = p;
    for (; p < attrEnd; p++) {
      const d = xml.charCodeAt(p);
      if (isXmlNameEnd(d)) break;
      if (d === 58) local = p + 1;
    }
    const nameEnd = p;
    while (p < attrEnd && xml.charCodeAt(p) <= 32) p++;
    if (xml.charCodeAt(p) !== 61 /* = */) continue;
    p++;
    while (p < attrEnd && xml.charCodeAt(p) <= 32) p++;
    const quote = xml.charCodeAt(p);
    if (quote !== 34 && quote !== 39) continue;
    const valueEnd = xml.indexOf(quote === 34 ? '"' : "'", p + 1);
    if (valueEnd < 0 || valueEnd > attrEnd) return -1;
    if (nameEnd - local === name.length && (local > start || !prefixed) && xml.startsWith(name, local)) {
      attrValueEnd = valueEnd;
      return p + 1;
    }
    p = valueEnd + 1;
  }
  return -1;
}

/** A tag's attribute value, decoded, by local name. */
function attrValue(tag: XmlTag, name: string, prefixed: boolean): string | undefined {
  const at = findAttr(tag, name, prefixed);
  return at < 0 ? undefined : decodeXml(tag.xml.slice(at, attrValueEnd));
}

/** An attribute's decoded value, by local name (any namespace prefix, or none). */
const attr = (tag: XmlTag, name: string) => attrValue(tag, name, false);

/** The relationship id (`r:id`) of an element; unlike `attr`, it needs a prefix, so a plain `id` doesn't match. */
const relId = (tag: XmlTag) => attrValue(tag, "id", true);

// ---------- Office Open XML packages ----------

/** The folder part of a package path, with its trailing "/" ("" at the root). */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** Resolves a relationship target against the folder of the part that refers to it. */
function resolvePath(folder: string, target: string): string {
  const out: string[] = [];
  for (const segment of (target.startsWith("/") ? target.slice(1) : folder + target).split("/")) {
    if (segment === "..") out.pop();
    else if (segment && segment !== ".") out.push(segment);
  }
  return out.join("/");
}

/** A ZIP-based Office file: parts by name (case-insensitive, as OPC requires) and their relationships. */
class Package {
  private readonly parts = new Map<string, ZipEntry>();

  constructor(
    private readonly bytes: Uint8Array,
    entries: ZipEntry[],
    readonly budget: Budget,
  ) {
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!this.parts.has(key)) this.parts.set(key, entry);
    }
  }

  entry(path: string): ZipEntry | undefined {
    return this.parts.get(path.toLowerCase());
  }

  /** Paths of parts matching `re` (tested against lower-cased names). */
  find(re: RegExp): string[] {
    return [...this.parts.keys()].filter((name) => re.test(name));
  }

  /** Up to `want` bytes of a part's XML; `cut` says it has more. */
  read(path: string, want = MAX_PART_BYTES): { xml: string; cut: boolean } | undefined {
    const entry = this.entry(path);
    return entry && readEntry(this.bytes, entry, this.budget, want);
  }

  /** A part's relationships: id → target path and type. */
  rels(path: string): Map<string, { target: string; type: string }> {
    const out = new Map<string, { target: string; type: string }>();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const xml = this.read(`${folderOf(path)}_rels/${name}.rels`)?.xml ?? "";
    walkXml(
      xml,
      (tag) => {
        if (tag.name !== "Relationship" || tag.close || attr(tag, "TargetMode") === "External") return;
        const id = attr(tag, "Id");
        const target = attr(tag, "Target");
        if (id && target) out.set(id, { target: resolvePath(folderOf(path), target), type: attr(tag, "Type") ?? "" });
      },
      () => {},
    );
    return out;
  }

  /**
   * Feeds a part to a reader that continues where it left off: feed(xml, cut) gets the part as
   * read so far (`cut` says there is more). Reading starts at FIRST_READ_BYTES; each further read
   * is sized for the rest of the reader's text at the density seen so far (with a margin), and at
   * least doubles, until the reader is full or the part is read.
   */
  feedGrowing(path: string, reader: GrowingReader): void {
    let want = FIRST_READ_BYTES;
    for (;;) {
      const part = this.read(path, want);
      if (!part) return;
      reader.feed(part.xml, part.cut);
      if (!part.cut || reader.full || want >= MAX_PART_BYTES || this.budget.partBytes <= 0) {
        if (part.cut && !reader.full) this.budget.cut(PART_TOO_LARGE);
        return;
      }
      const rate = reader.length / part.xml.length;
      const estimate = rate > 0 ? part.xml.length + Math.ceil(((reader.limit - reader.length) / rate) * 1.25) : want * 4;
      want = Math.min(MAX_PART_BYTES, Math.max(want * 2, estimate));
    }
  }

  /**
   * Parses a part with `parse(xml, limit)`, unpacking more of it until the parser has `limit`
   * characters (it says so with `full`) or the part is read. Returns the parser's result.
   */
  parseGrowing(path: string, limit: number, parse: (xml: string, limit: number) => Parsed): Parsed {
    for (let want = firstReadBytes(limit); ; want *= 4) {
      const part = this.read(path, want);
      if (!part) return { text: "", full: false };
      const parsed = parse(part.xml, limit);
      if (!part.cut || parsed.full || want >= MAX_PART_BYTES || this.budget.partBytes <= 0) {
        if (part.cut && !parsed.full) this.budget.cut(PART_TOO_LARGE);
        return parsed;
      }
    }
  }
}

/** A parser's text, and whether it stopped because it reached its character limit. */
interface Parsed {
  text: string;
  full: boolean;
}

/** A reader fed a part piece by piece (see Package.feedGrowing): how much text it has, and wants. */
interface GrowingReader {
  feed(xml: string, cut: boolean): void;
  readonly full: boolean;
  readonly length: number;
  readonly limit: number;
}

/** Sorts part names like "slide10.xml" after "slide2.xml". */
const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/** Tables nested, or cells open, deeper than this are read as part of what holds them; rows wider than Excel's limit are cut there. */
const MAX_TABLE_DEPTH = 64;
const MAX_COLUMNS = 16_384;

/** Collects text up to a character limit. */
class TextSink {
  readonly parts: string[] = [];
  length = 0;

  constructor(readonly limit: number) {}

  get full() {
    return this.length >= this.limit;
  }

  add(text: string) {
    this.parts.push(text);
    this.length += text.length;
  }
}

/**
 * The text of WordprocessingML or DrawingML (Word bodies, PowerPoint slides): only the text runs
 * (`t`), so deleted text, field codes and drawing coordinates are left out; tabs and line breaks;
 * table rows as tab-separated cells; and only one branch of each mc:AlternateContent (Word stores
 * text boxes twice, once as a fallback for old readers).
 */
function documentText(xml: string, limit: number): Parsed {
  const sink = new TextSink(limit);
  const cells: { parts: string[]; span: number }[] = [];
  const rows: string[][] = [];
  let inText = false;
  let hidden = 0;
  let tabStops = 0;
  let newlines = 0;
  const put = (s: string) => {
    const cell = cells.at(-1);
    if (cell) cell.parts.push(s);
    else if (s !== "\n" || newlines < 2) {
      // A run of empty paragraphs ends up as one blank line anyway, so it needn't take up the text budget.
      newlines = s === "\n" ? newlines + 1 : s.endsWith("\n") ? 1 : 0;
      sink.add(s);
    }
  };
  walkXml(
    xml,
    (tag) => {
      const { name, close, empty } = tag;
      if (name === "Fallback" || name === "del" || name === "moveFrom") {
        if (!empty) hidden = Math.max(0, hidden + (close ? -1 : 1)); // a stray closing tag must not hide what follows
        return;
      }
      if (hidden) return;
      switch (name) {
        case "t":
          inText = !close && !empty;
          break;
        case "tabs":
        case "tabLst":
          if (!empty) tabStops += close ? -1 : 1;
          break;
        case "tab":
        case "ptab":
          if (!close && !tabStops) put("\t");
          break;
        case "br":
        case "cr":
          if (!close) put("\n");
          break;
        case "noBreakHyphen":
          if (!close) put("-");
          break;
        case "p":
          if (close || empty) put(cells.length ? " " : "\n");
          break;
        case "tr":
          if (empty) break;
          if (!close) {
            if (rows.length < MAX_TABLE_DEPTH) rows.push([]);
          } else {
            const row = rows.pop() ?? [];
            while (row.length && !row[row.length - 1]) row.pop(); // no trailing tabs
            put(`${row.join("\t")}\n`);
          }
          break;
        case "tc":
          if (empty) break;
          if (!close) {
            if (cells.length < MAX_TABLE_DEPTH) cells.push({ parts: [], span: 1 });
          } else {
            const cell = cells.pop();
            const text = (cell?.parts.join("") ?? "").replace(/\s+/g, " ").trim();
            const row = rows.at(-1);
            if (!row) put(text);
            else {
              row.push(text);
              // The columns a cell spans are padded, up to Excel's width.
              const padding = Math.min(Math.max(0, (cell?.span ?? 1) - 1), Math.max(0, MAX_COLUMNS - row.length));
              for (let i = 0; i < padding; i++) row.push("");
            }
          }
          break;
        case "gridSpan": {
          const cell = cells.at(-1);
          if (cell) cell.span = Math.min(64, Math.max(1, Number(attr(tag, "val")) || 1));
          break;
        }
      }
      return sink.full;
    },
    (text) => {
      if (inText && !hidden) put(text);
      return sink.full;
    },
  );
  return { text: tidyLines(sink.parts.join("")), full: sink.full };
}

// ---------- spreadsheets ----------

type DateKind = "date" | "time" | "datetime" | "duration";

/** A simple number format: text around the number, decimals, a thousands separator, a percent sign (the value times 100). */
interface NumberFormat {
  prefix: string;
  suffix: string;
  decimals: number;
  thousands: boolean;
  percent: boolean;
}

type CellFormat = DateKind | NumberFormat;

/** Most characters of a number format code that are looked at, and most cell styles read. */
const MAX_FORMAT_CODE = 256;
const MAX_CELL_STYLES = 65_536;

/** Built-in number formats that show dates or times (ids 27-36 and 50-58 are East Asian date formats). */
function builtinDateKind(id: number): DateKind | undefined {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 31) || id === 36 || (id >= 50 && id <= 54) || id === 57 || id === 58) return "date";
  if ((id >= 18 && id <= 21) || (id >= 32 && id <= 35) || id === 45 || id === 47 || id === 55 || id === 56) return "time";
  if (id === 22) return "datetime";
  if (id === 46) return "duration";
  return undefined;
}

/**
 * What a custom number format shows: a date, a time, both, an elapsed duration ([h]:mm), or a
 * number with a simple format (0.0%, "$"#,##0.00, …); undefined for anything else. Only the first
 * section (positive numbers) counts, and only its first MAX_FORMAT_CODE characters.
 */
function cellFormat(code: string): CellFormat | undefined {
  const section = code.slice(0, MAX_FORMAT_CODE).split(";")[0];
  // The format without quoted text, escaped characters, padding and colour/condition brackets (but with [h]-style ones).
  const f = section
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?![hms]+\])[^[\]]*\]/gi, "");
  if (/\[[hms]+\]/i.test(f)) return "duration";
  const date = /[yd]/i.test(f) || /m{3,}/i.test(f);
  const time = /[hs]/i.test(f) || /am\/pm|a\/p/i.test(f);
  if (date || time) return date && time ? "datetime" : date ? "date" : "time";
  return numberFormat(section);
}

/** A simple number format: literal text, then digits with an optional thousands separator and decimals, a percent sign, more text. */
function numberFormat(section: string): NumberFormat | undefined {
  const m = /^((?:"[^"]*"|\\.|[^"#0?,.%\\[\]*_;@E])*)([#?,]*0*(?:\.[0#?]+)?)(%?)((?:"[^"]*"|\\.|[^"#0?,.%\\[\]*_;@E])*)$/.exec(section);
  if (!m || !m[2] || !/[0#?]/.test(m[2])) return undefined;
  const literal = (text: string) => text.replace(/"([^"]*)"|\\(.)/g, "$1$2");
  const dot = m[2].indexOf(".");
  return { prefix: literal(m[1]), suffix: literal(m[4]), decimals: dot < 0 ? 0 : Math.min(20, m[2].length - dot - 1), thousands: m[2].includes(","), percent: m[3] === "%" };
}

/** Built-in number formats 1-4 and 9-10; the rest show plain numbers (or dates, see builtinDateKind). */
function builtinNumberFormat(id: number): NumberFormat | undefined {
  const codes: Record<number, string> = { 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%" };
  return codes[id] === undefined ? undefined : numberFormat(codes[id]);
}

/** A number shown with a simple format: decimals, thousands separators, percent, text around it. */
function formatNumber(n: number, format: NumberFormat): string {
  const value = format.percent ? n * 100 : n;
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return String(n);
  let digits = Math.abs(value).toFixed(format.decimals);
  if (format.thousands) {
    const dot = digits.indexOf(".");
    const whole = dot < 0 ? digits : digits.slice(0, dot);
    let grouped = "";
    for (let i = 0; i < whole.length; i++) grouped += (i && (whole.length - i) % 3 === 0 ? "," : "") + whole[i];
    digits = grouped + (dot < 0 ? "" : digits.slice(dot));
  }
  return `${value < 0 && Number(digits) !== 0 ? "-" : ""}${format.prefix}${digits}${format.percent ? "%" : ""}${format.suffix}`;
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** The calendar date of a day counted from 1970-01-01 (proleptic Gregorian, like Date), as "YYYY-MM-DD". */
function civilDate(day: number): string {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Shows an Excel serial date/time number as ISO-style text; returns undefined when it isn't a plausible date. */
function formatSerial(serial: number, kind: DateKind, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return undefined;
  const seconds = Math.round(serial * 86400);
  if (kind === "duration") {
    return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  }
  // Day 1 is 1900-01-01, and Excel counts a 1900-02-29 that never was (day 60). The epochs are days from 1970-01-01.
  const epoch = date1904 ? -24107 : serial < 60 ? -25568 : -25569;
  const days = Math.floor(seconds / 86400);
  const date = !date1904 && days === 60 ? "1900-02-29" : civilDate(epoch + days);
  const rest = seconds - days * 86400;
  const time = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}${rest % 60 ? `:${pad(rest % 60)}` : ""}`;
  return kind === "date" ? date : kind === "time" ? time : `${date} ${time}`;
}

/** The zero-based column of a cell reference like "C12" at [start, end) of `text` (2 for C), or undefined. */
function columnIndex(text: string, start: number, end: number): number | undefined {
  let n = 0;
  let i = start;
  for (; i < end && i < start + 3; i++) {
    let c = text.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    if (c < 65 || c > 90) break;
    n = n * 26 + c - 64;
  }
  return i > start ? n - 1 : undefined;
}

/** Cells further right than this are put right after the previous cell instead of padding the row with tabs. */
const MAX_COLUMN_GAP = 200;
/** Up to this many missing (or empty) rows become blank lines; longer gaps get one line saying so. */
const MAX_BLANK_ROWS = 10;
/** Excel's last row. */
const MAX_ROWS = 1_048_576;

interface SheetContext {
  shared(index: number): string | undefined;
  /** What each cell style (by index) shows: a date or time kind, or a number format. */
  formats: (CellFormat | undefined)[];
  date1904: boolean;
}

/** Text on one line: tabs and line breaks become spaces. */
const oneLine = (text: string) => text.replace(/[\t\r\n]+/g, " ");

/** A number as Excel shows it: up to 15 significant digits, so binary noise like 0.30000000000000004 doesn't show. */
function numberText(value: string, n: number): string {
  // A value of at most 15 characters without an exponent has at most 15 significant digits already, and prints the same.
  if (value.length <= 15 && !value.includes("e") && !value.includes("E")) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** Cell text as Excel shows it (dates formatted, booleans as TRUE/FALSE), on one line; shared strings come ready. */
function cellText(type: string | undefined, value: string, inline: string, style: number, ctx: SheetContext): string {
  if (type === "s") return value.trim() === "" ? "" : (ctx.shared(Number(value)) ?? "");
  if (type === "inlineStr") return oneLine(inline);
  if (type === "b") return value.trim() === "1" ? "TRUE" : value.trim() === "0" ? "FALSE" : oneLine(value);
  if (type === "str" || type === "e" || type === "d") return oneLine(value);
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n)) return oneLine(value);
  const format = ctx.formats[style];
  if (format === undefined) return numberText(value, n);
  if (typeof format === "string") return formatSerial(n, format, ctx.date1904) ?? numberText(value, n);
  return formatNumber(n, format);
}

/**
 * Reads a worksheet as tab-separated rows, each cell in its column (Excel leaves empty cells out
 * of the file), from as much of the part as has been read: feed() continues after the last
 * complete row, so a part can be unpacked a piece at a time until the text limit is reached.
 */
class SheetReader {
  readonly sink: TextSink;
  /** Where the next feed continues: after the last complete row. */
  offset = 0;
  private lastRow = 0;
  private row = 0;
  private cells: (string | undefined)[] = [];
  private nextColumn = 0;
  // The cell being read (one record, reused: a sheet has many cells).
  private hasCell = false;
  private column = 0;
  private type: string | undefined;
  private style = 0;
  private value = "";
  private inline = "";
  private inValue = false;
  private inInline = false;
  private inText = false;
  private phonetic = 0;

  constructor(
    limit: number,
    private readonly ctx: SheetContext,
  ) {
    this.sink = new TextSink(limit);
  }

  get full() {
    return this.sink.full;
  }

  get length() {
    return this.sink.length;
  }

  get limit() {
    return this.sink.limit;
  }

  /** Reads the rows of `xml` from `offset` on; when `cut` says the part has more, an unfinished last row is left for the next feed. */
  feed(xml: string, cut: boolean) {
    this.hasCell = this.inValue = this.inInline = this.inText = false;
    this.phonetic = 0;
    let done = this.offset;
    walkXml(
      xml,
      (tag) => {
        switch (tag.name) {
          case "row":
            if (tag.close) {
              this.flushRow();
              done = tag.end;
            } else {
              const r = Number(attr(tag, "r"));
              this.row = Number.isInteger(r) && r > this.lastRow && r <= MAX_ROWS ? r : this.row + 1;
              this.cells = [];
              this.nextColumn = 0;
              if (tag.empty) {
                this.flushRow();
                done = tag.end;
              }
            }
            break;
          case "c":
            if (tag.close) {
              if (this.hasCell) {
                this.cells[this.column] = cellText(this.type, this.value, this.inline, this.style, this.ctx);
                this.nextColumn = this.column + 1;
              }
              this.hasCell = false;
            } else {
              const ref = findAttr(tag, "r", false);
              const column = ref < 0 ? undefined : columnIndex(tag.xml, ref, attrValueEnd);
              const wanted = column !== undefined && column >= this.nextColumn && column - this.nextColumn <= MAX_COLUMN_GAP ? column : this.nextColumn;
              const at = Math.min(wanted, MAX_COLUMNS - 1);
              if (tag.empty) this.nextColumn = at + 1;
              else {
                this.hasCell = true;
                this.column = at;
                this.type = attr(tag, "t");
                this.style = Number(attr(tag, "s") ?? 0);
                this.value = "";
                this.inline = "";
              }
            }
            break;
          case "v":
            this.inValue = !tag.close && !tag.empty;
            break;
          case "is":
            this.inInline = !tag.close && !tag.empty;
            break;
          case "t":
            this.inText = !tag.close && !tag.empty;
            break;
          case "rPh":
            if (!tag.empty) this.phonetic += tag.close ? -1 : 1;
            break;
        }
        return this.sink.full;
      },
      (text) => {
        if (!this.hasCell) return;
        if (this.inValue) this.value += text;
        else if (this.inInline && this.inText && !this.phonetic) this.inline += text;
      },
      this.offset,
    );
    this.offset = cut ? done : xml.length;
  }

  /** Writes the row; an empty row is left to the next row's gap (so a run of them becomes blank lines, or one line saying so). */
  private flushRow() {
    const { row, lastRow, cells, sink } = this;
    let end = cells.length;
    while (end > 0 && !cells[end - 1]) end--; // no trailing tabs
    if (!end) return;
    const gap = row - lastRow - 1;
    if (gap > MAX_BLANK_ROWS) sink.add(`(rows ${lastRow + 1}–${row - 1} are empty)\n`);
    else if (gap > 0) sink.add("\n".repeat(gap));
    let line = "";
    for (let i = 0; i < end; i++) line += i ? `\t${cells[i] ?? ""}` : (cells[i] ?? "");
    sink.add(`${line}\n`);
    this.lastRow = row;
  }

  text(): string {
    const text = this.sink.parts.join("");
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
    return end === text.length ? text : text.slice(0, end);
  }
}

/**
 * The shared strings table, without phonetic guides (<rPh>, e.g. Japanese furigana), each on one
 * line as cells show them; feed() continues after the last complete string, so the table can be
 * unpacked a piece at a time, as far as the cells point.
 */
class SharedStrings {
  readonly strings: string[] = [];
  /** Where the next feed continues: after the last complete <si>. */
  offset = 0;

  feed(xml: string, cut: boolean) {
    let current: string | undefined;
    let inText = false;
    let phonetic = 0;
    let done = this.offset;
    walkXml(
      xml,
      ({ name, close, empty, end }) => {
        if (name === "si") {
          if (empty) this.strings.push("");
          else if (close) {
            this.strings.push(oneLine(current ?? ""));
            current = undefined;
          } else {
            current = "";
            return;
          }
          done = end;
        } else if (name === "t") inText = !close && !empty;
        else if (name === "rPh" && !empty) phonetic += close ? -1 : 1;
      },
      (text) => {
        if (current !== undefined && inText && !phonetic) current += text;
      },
      this.offset,
    );
    this.offset = cut ? done : xml.length;
  }
}

/** What each cell style (by index) shows: dates and times, and simple number formats. */
function cellStyles(xml: string): (CellFormat | undefined)[] {
  const custom = new Map<number, CellFormat | undefined>();
  const formats: (CellFormat | undefined)[] = [];
  let inCellXfs = false;
  walkXml(
    xml,
    (tag) => {
      const { name, close, empty } = tag;
      if (name === "numFmt" && !close) {
        // Only the start of a format code matters, so a huge one isn't even decoded.
        const at = findAttr(tag, "formatCode", false);
        const code = at < 0 ? "" : decodeXml(tag.xml.slice(at, Math.min(attrValueEnd, at + 8 * MAX_FORMAT_CODE)));
        custom.set(Number(attr(tag, "numFmtId")), cellFormat(code));
      }
      else if (name === "cellXfs" && !empty) inCellXfs = !close;
      else if (name === "xf" && inCellXfs && !close && formats.length < MAX_CELL_STYLES) {
        const id = Number(attr(tag, "numFmtId") ?? 0);
        formats.push(custom.has(id) ? custom.get(id) : (builtinDateKind(id) ?? builtinNumberFormat(id)));
      }
    },
    () => {},
  );
  return formats;
}

function readWorkbook(pkg: Package, workbookPath: string): ReadResult {
  const { budget } = pkg;
  const rels = pkg.rels(workbookPath);
  const relOfType = (type: string) => [...rels.values()].find((r) => r.type.endsWith(`/${type}`))?.target;
  const listed: { name: string; rel?: { target: string; type: string } }[] = [];
  let date1904 = false;
  walkXml(
    pkg.read(workbookPath)?.xml ?? "",
    (tag) => {
      if (tag.close) return;
      if (tag.name === "workbookPr") date1904 = /^(1|true)$/i.test(attr(tag, "date1904") ?? "");
      if (tag.name !== "sheet") return;
      const state = attr(tag, "state");
      const label = `${attr(tag, "name") ?? listed.length + 1}${state && state !== "visible" ? " (hidden)" : ""}`;
      listed.push({ name: label, rel: rels.get(relId(tag) ?? "") });
    },
    () => {},
  );
  // Sheets in workbook order, found through the workbook's relationships. Chart and dialog sheets have no cells.
  const sheets = listed
    .filter((s) => s.rel?.type.endsWith("/worksheet"))
    .map((s) => ({ name: s.name, path: s.rel!.target }));
  if (!rels.size) {
    // No relationships (not written by Office): match sheet files to names by position.
    for (const [i, path] of pkg.find(/^xl\/worksheets\/sheet\d+\.xml$/).sort(byNumber).entries()) {
      sheets.push({ name: listed[i]?.name ?? String(i + 1), path });
    }
  }

  const sharedPath = relOfType("sharedStrings") ?? "xl/sharedStrings.xml";
  const shared = new SharedStrings();
  let sharedWant = FIRST_READ_BYTES / 2;
  let sharedCut = true;
  const loadShared = () => {
    const part = pkg.read(sharedPath, (sharedWant *= 2));
    if (part) shared.feed(part.xml, part.cut);
    sharedCut = Boolean(part?.cut);
  };
  const stylesXml = pkg.read(relOfType("styles") ?? "xl/styles.xml")?.xml;
  const ctx: SheetContext = {
    shared(index) {
      // The table is read only as far as needed; read more of it when a cell points further.
      while (index >= shared.strings.length && sharedCut && sharedWant < MAX_PART_BYTES && budget.partBytes > 0) loadShared();
      if (index >= shared.strings.length && sharedCut) budget.cut(PART_TOO_LARGE);
      return shared.strings[index];
    },
    formats: stylesXml ? cellStyles(stylesXml) : [],
    date1904,
  };
  loadShared();

  const parts: string[] = [];
  let length = 0;
  for (const [i, sheet] of sheets.entries()) {
    const reader = new SheetReader(budget.chars - length, ctx);
    pkg.feedGrowing(sheet.path, reader);
    const { full } = reader;
    const part = `--- Sheet: ${sheet.name} ---\n${reader.text()}`;
    parts.push(part);
    length += part.length + 2;
    if (full) return budget.result(parts.join("\n\n"), true);
    if (length >= budget.chars) return budget.result(parts.join("\n\n"), i < sheets.length - 1);
  }
  return budget.result(parts.join("\n\n"), false);
}

function readPresentation(pkg: Package, presentationPath: string): ReadResult {
  const { budget } = pkg;
  const rels = pkg.rels(presentationPath);
  const slides: string[] = [];
  walkXml(
    pkg.read(presentationPath)?.xml ?? "",
    (tag) => {
      const rel = tag.name === "sldId" && !tag.close ? rels.get(relId(tag) ?? "") : undefined;
      if (rel) slides.push(rel.target);
    },
    () => {},
  );
  if (!slides.length) slides.push(...pkg.find(/^ppt\/slides\/slide\d+\.xml$/).sort(byNumber));
  const parts: string[] = [];
  let length = 0;
  for (const [i, path] of slides.entries()) {
    const { text, full } = pkg.parseGrowing(path, budget.chars - length, documentText);
    const part = `--- Slide ${i + 1} ---\n${text}`;
    parts.push(part);
    length += part.length + 2;
    if (full || length >= budget.chars) return budget.result(parts.join("\n\n"), full || i < slides.length - 1);
  }
  return budget.result(parts.join("\n\n"), false);
}

/** Extracts the text of a Word, Excel or PowerPoint (Office Open XML) file, stopping once `maxChars` are collected. */
export async function readOffice(bytes: Uint8Array, opts: ReadOptions = {}): Promise<ReadResult> {
  const pkg = new Package(bytes, zipEntries(bytes), new Budget(opts.maxChars));
  // The package's own relationships name its main part (usually word/document.xml, xl/workbook.xml or ppt/presentation.xml).
  const main = [...pkg.rels("").values()].find((r) => r.type.endsWith("/officeDocument"))?.target;
  const has = (path: string | undefined): path is string => Boolean(path && pkg.entry(path));
  const word = has(main) && main.startsWith("word/") ? main : has("word/document.xml") ? "word/document.xml" : undefined;
  if (word) {
    const { text, full } = pkg.parseGrowing(word, pkg.budget.chars, documentText);
    return pkg.budget.result(text, full);
  }
  const workbook = has(main) && main.startsWith("xl/") ? main : "xl/workbook.xml";
  if (has(workbook) || pkg.find(/^xl\/worksheets\/sheet\d+\.xml$/).length) return readWorkbook(pkg, workbook);
  const presentation = has(main) && main.startsWith("ppt/") ? main : "ppt/presentation.xml";
  if (has(presentation) || pkg.find(/^ppt\/slides\/slide\d+\.xml$/).length) return readPresentation(pkg, presentation);
  throw new Error("not a Word, Excel or PowerPoint file");
}

/** The text of an Office file as one string (with a note when it is incomplete). */
export async function officeText(bytes: Uint8Array, opts: ReadOptions = {}): Promise<string> {
  return withNote(await readOffice(bytes, opts));
}

// ---------- PDF ----------

const win1252Decoder = new TextDecoder("windows-1252");

/**
 * Decodes PDF string bytes (held one per character) as Windows-1252, PDF's common single-byte text
 * encoding. Plain ASCII needs no decoding, which skips a costly round trip for most strings.
 */
function win1252(raw: string): string {
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) > 127) return win1252Decoder.decode(Buffer.from(raw, "latin1"));
  return raw;
}

/** Code units (or bytes) turned into a string at a time: String.fromCharCode takes them as arguments, on the stack. */
const STRING_CHUNK = 4096;
/** Where the string readLiteral last read ends (the index after its ")"). */
let literalEnd = 0;
/** The bytes of a literal string being read with escapes (chunks of this many become text at a time). */
const LITERAL_BYTES: number[] = [];
/** Nested parentheses in a literal string are balanced up to this depth; past it they are plain characters. */
const MAX_PAREN_DEPTH = 4096;

/**
 * Reads a literal string starting at `start` (the "("): its bytes, one per character; `literalEnd`
 * is then the index after ")". Escapes are read byte by byte into chunks, so a string of millions
 * of escapes or parentheses costs its length, not a copy per character.
 */
function readLiteral(s: string, start: number): string {
  const n = s.length;
  // Most strings have no escapes or nested parentheses: their ")" is the first special character.
  for (let i = start + 1; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 41 /* ) */) {
      literalEnd = i + 1;
      return s.slice(start + 1, i);
    }
    if (c === 92 /* \ */ || c === 40 /* ( */) break;
  }
  const bytes = LITERAL_BYTES;
  let count = 0;
  let out = "";
  let depth = 1;
  let pos = start + 1;
  const put = (b: number) => {
    bytes[count++] = b;
    if (count === STRING_CHUNK) {
      bytes.length = count;
      out += String.fromCharCode.apply(null, bytes);
      count = 0;
    }
  };
  while (pos < n) {
    const c = s.charCodeAt(pos++);
    if (c === 92 /* \ */) {
      const e = s.charCodeAt(pos);
      if (e === 110 /* n */) put(10);
      else if (e === 114 /* r */) put(13);
      else if (e === 116 /* t */) put(9);
      else if (e === 98 /* b */) put(8);
      else if (e === 102 /* f */) put(12);
      else if (e >= 48 && e <= 55) {
        let value = 0;
        for (let digits = 0; digits < 3 && s.charCodeAt(pos) >= 48 && s.charCodeAt(pos) <= 55; digits++) value = value * 8 + s.charCodeAt(pos++) - 48;
        put(value & 0xff);
        continue;
      } else if (e === 13 /* \r: a line continuation */) {
        pos += s.charCodeAt(pos + 1) === 10 ? 2 : 1;
        continue;
      } else if (e === 10) {
        pos++;
        continue;
      } else if (pos < n) put(e); // \( \) \\ and anything else: the character itself
      pos++;
    } else if (c === 40 /* ( */) {
      if (depth < MAX_PAREN_DEPTH) depth++;
      put(c);
    } else if (c === 41 /* ) */ && --depth === 0) {
      literalEnd = pos;
      break;
    } else put(c);
  }
  if (pos >= n) literalEnd = n;
  if (count) {
    bytes.length = count;
    out += String.fromCharCode.apply(null, bytes);
  }
  return out;
}

/** A hex string's bytes, one per character. */
function hexBytes(hex: string): string {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, "");
  return latin1(Buffer.from(digits.length % 2 ? `${digits}0` : digits, "hex"));
}

// ---------- PDF objects ----------

class PdfName {
  constructor(readonly name: string) {}
}

class PdfRef {
  constructor(readonly num: number) {}
}

class PdfString {
  constructor(readonly bytes: string) {}
}

type PdfDict = Map<string, PdfValue>;
type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfDict | PdfValue[];

/** A stream object: its dictionary and where its (still encoded) data lies in the file. */
interface PdfStream {
  dict: PdfDict;
  start: number;
  end: number;
}

const PDF_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const PDF_NAME = /\/([^\s/[\]()<>{}%]*)/y;
const PDF_REF_TAIL = /\s+(\d+)\s+R(?![^\s/[\]()<>{}%])/y;
const PDF_KEYWORD = /[A-Za-z]+/y;
/** Arrays and dictionaries nested deeper than this are treated as damage. */
const MAX_NESTING = 32;

function skipPdfSpace(s: string, p: { pos: number }) {
  for (;;) {
    const c = s.charCodeAt(p.pos);
    if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0) p.pos++;
    else if (c === 37 /* % */) {
      const eol = s.slice(p.pos).search(/[\r\n]/);
      p.pos = eol < 0 ? s.length : p.pos + eol;
    } else return;
  }
}

/** A name's characters: "#xx" escapes decoded (an invalid escape stays as written). */
function pdfName(raw: string): string {
  let hash = raw.indexOf("#");
  if (hash < 0) return raw;
  let out = "";
  let pos = 0;
  while (hash >= 0) {
    const a = raw.charCodeAt(hash + 1);
    const b = raw.charCodeAt(hash + 2);
    const high = a < 128 ? HEX_VALUE[a] : -1;
    const low = b < 128 ? HEX_VALUE[b] : -1;
    if (high >= 0 && low >= 0) {
      out += raw.slice(pos, hash) + String.fromCharCode(high * 16 + low);
      pos = hash + 3;
    }
    hash = raw.indexOf("#", Math.max(pos, hash + 1));
  }
  return out + raw.slice(pos);
}

/** Parses one PDF object (dictionary, array, string, name, number, reference, …) at `p.pos`; undefined if damaged. */
function parsePdfValue(s: string, p: { pos: number }, depth = 0): PdfValue | undefined {
  skipPdfSpace(s, p);
  if (p.pos >= s.length || depth > MAX_NESTING) return undefined;
  const c = s.charCodeAt(p.pos);
  if (c === 60 /* < */) {
    if (s.charCodeAt(p.pos + 1) !== 60) {
      const end = s.indexOf(">", p.pos);
      if (end < 0) return undefined;
      const value = new PdfString(hexBytes(s.slice(p.pos + 1, end)));
      p.pos = end + 1;
      return value;
    }
    p.pos += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      skipPdfSpace(s, p);
      if (s.startsWith(">>", p.pos)) {
        p.pos += 2;
        return dict;
      }
      PDF_NAME.lastIndex = p.pos;
      const key = PDF_NAME.exec(s);
      if (!key) return undefined;
      p.pos = PDF_NAME.lastIndex;
      const value = parsePdfValue(s, p, depth + 1);
      if (value === undefined) return undefined;
      dict.set(pdfName(key[1]), value);
    }
  }
  if (c === 91 /* [ */) {
    p.pos++;
    const array: PdfValue[] = [];
    for (;;) {
      skipPdfSpace(s, p);
      if (s.charCodeAt(p.pos) === 93 /* ] */) {
        p.pos++;
        return array;
      }
      const value = parsePdfValue(s, p, depth + 1);
      if (value === undefined) return undefined;
      array.push(value);
    }
  }
  if (c === 40 /* ( */) {
    const literal = readLiteral(s, p.pos);
    p.pos = literalEnd;
    return new PdfString(literal);
  }
  if (c === 47 /* / */) {
    PDF_NAME.lastIndex = p.pos;
    const m = PDF_NAME.exec(s)!;
    p.pos = PDF_NAME.lastIndex;
    return new PdfName(pdfName(m[1]));
  }
  PDF_NUMBER.lastIndex = p.pos;
  const number = PDF_NUMBER.exec(s);
  if (number) {
    p.pos = PDF_NUMBER.lastIndex;
    if (/^\d+$/.test(number[0])) {
      PDF_REF_TAIL.lastIndex = p.pos;
      if (PDF_REF_TAIL.exec(s)) {
        p.pos = PDF_REF_TAIL.lastIndex;
        return new PdfRef(Number(number[0]));
      }
    }
    return Number(number[0]);
  }
  PDF_KEYWORD.lastIndex = p.pos;
  const keyword = PDF_KEYWORD.exec(s)?.[0];
  if (keyword === "true" || keyword === "false" || keyword === "null") {
    p.pos = PDF_KEYWORD.lastIndex;
    return keyword === "true" ? true : keyword === "false" ? false : null;
  }
  return undefined;
}

const nameOf = (v: PdfValue | PdfStream | undefined) => (v instanceof PdfName ? v.name : undefined);
const isDict = (v: unknown): v is PdfDict => v instanceof Map;
const isStream = (v: unknown): v is PdfStream => typeof v === "object" && v !== null && "start" in v && "dict" in v;

/** Most objects a PDF may have for its page tree to be used (larger ones are read in file order), and most "N G obj" headers looked at. */
const MAX_PDF_OBJECTS = 200_000;
const MAX_PDF_HEADERS = 400_000;
/** Most object streams a PDF may have for its page tree to be used. */
const MAX_OBJECT_STREAMS = 2_000;
/** Longest object (other than stream data) that is parsed. */
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

/** The file's bytes, typed as Node's Buffer (the Worker's own Buffer type has no indexOf for strings). */
type PdfBytes = ReturnType<typeof bufferOf>;
const bufferOf = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** True for bytes that can be part of a PDF keyword or number (not white space or a delimiter). */
function isRegularByte(b: number | undefined): boolean {
  return b !== undefined && !(b <= 32 || b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37);
}

/** The object number of an "N G obj" header whose "obj" starts at `at`, read backwards. */
function headerNumber(buf: Uint8Array, at: number): number | undefined {
  let i = at - 1;
  const digits = () => {
    const end = i;
    while (i >= 0 && buf[i] >= 48 && buf[i] <= 57) i--;
    return end - i;
  };
  const spaces = () => {
    const end = i;
    while (i >= 0 && (buf[i] === 32 || buf[i] === 10 || buf[i] === 13 || buf[i] === 9 || buf[i] === 12 || buf[i] === 0)) i--;
    return end - i;
  };
  if (!spaces() || !digits() || !spaces()) return undefined;
  const end = i;
  if (!digits() || end - i > 10 || isRegularByte(buf[i])) return undefined;
  return Number(latin1(buf.subarray(i + 1, end + 1)));
}

/**
 * A PDF's objects, found by scanning the file for "N G obj" (so a damaged cross-reference table
 * doesn't matter) and by reading object streams. When an object is defined more than once (each
 * incremental update appends new versions), the definition furthest into the file wins.
 */
/** Where a top-level object's body lies: from `at` (just after its "obj" keyword) to `end`; `streamAt` is its "stream" keyword, -1 for none. */
interface PdfBody {
  at: number;
  end: number;
  streamAt: number;
}

class PdfFile {
  /** Top-level objects by number. */
  private readonly top = new Map<number, PdfBody>();
  /** Objects packed in object streams: number → the stream's object number and its index there. */
  private readonly packed = new Map<number, { stream: number; index: number }>();
  private readonly objectStreams = new Map<number, { text: string; first: number; offsets: number[] }>();
  private readonly cache = new Map<number, PdfValue | PdfStream | null>();
  private readonly decoded = new Map<number, string | null>();
  private readonly cmaps = new Map<number, CMap | null>();
  private readonly programs = new Map<number, FontProgram | null>();
  private resolving = 0;
  root?: PdfDict;

  private constructor(
    readonly buf: PdfBytes,
    readonly budget: Budget,
  ) {}

  /**
   * Indexes a PDF's objects in one pass over the file; undefined when its page tree can't be used
   * (no trailer, encrypted, too big). Each keyword is looked for with a cursor that only moves
   * forward, and an object's body ends at the next "endobj", "N G obj" header or MAX_OBJECT_BYTES,
   * whichever comes first, so a file missing its keywords still costs its length, not its square.
   */
  static open(bytes: Uint8Array, budget: Budget): PdfFile | undefined {
    const buf = bufferOf(bytes);
    const n = buf.length;
    const file = new PdfFile(buf, budget);
    const objectStreams: { num: number; at: number }[] = [];
    let trailer: { at: number; dict: PdfDict } | undefined;
    // The next occurrence of each keyword at or after the position being read (n when there is none).
    const cursors = { obj: 0, endobj: 0, stream: 0, endstream: 0 };
    const next = (keyword: keyof typeof cursors, from: number) => {
      if (cursors[keyword] < from) {
        const found = buf.indexOf(keyword, from);
        cursors[keyword] = found < 0 ? n : found;
      }
      return cursors[keyword];
    };
    let headers = 0;
    let pos = 0;
    for (;;) {
      const at = next("obj", pos);
      if (at >= n) break;
      pos = at + 3;
      if (at >= 3 && buf[at - 1] === 0x64 && buf[at - 2] === 0x6e && buf[at - 3] === 0x65) continue; // endobj
      if (isRegularByte(buf[at + 3])) continue;
      const num = headerNumber(buf, at);
      if (num === undefined) continue;
      if (++headers > MAX_PDF_HEADERS) return undefined;
      if (file.top.size >= MAX_PDF_OBJECTS && !file.top.has(num)) return undefined;
      const limit = Math.min(next("endobj", pos), next("obj", pos), pos + MAX_OBJECT_BYTES, n);
      const streamAt = next("stream", pos) < limit ? cursors.stream : -1;
      const body: PdfBody = { at: pos, end: limit, streamAt };
      file.top.set(num, body);
      if (streamAt >= 0) {
        const dict = parsePdfValue(latin1(buf.subarray(pos, streamAt)), { pos: 0 });
        if (isDict(dict)) {
          const type = nameOf(dict.get("Type"));
          if (type === "ObjStm") objectStreams.push({ num, at });
          if (type === "XRef" && (!trailer || at > trailer.at)) trailer = { at, dict };
        }
        // A stream's data can hold anything (even "1 0 obj"), so continue after its "endstream"; the body ends there, or at its "endobj".
        const dataEnd = next("endstream", streamAt + 6);
        body.end = Math.min(dataEnd < n ? dataEnd + 9 : n, next("endobj", streamAt));
        pos = dataEnd < n ? dataEnd + 9 : n;
      }
    }
    const classic = buf.lastIndexOf("trailer", buf.length);
    if (classic >= 0 && (!trailer || classic > trailer.at)) {
      const dict = parsePdfValue(latin1(buf.subarray(classic + 7, Math.min(buf.length, classic + 7 + 65536))), { pos: 0 });
      if (isDict(dict)) trailer = { at: classic, dict };
    }
    if (!trailer || trailer.dict.has("Encrypt")) return undefined;
    if (objectStreams.length > MAX_OBJECT_STREAMS) return undefined;
    for (const { num, at } of objectStreams) if (!file.indexObjectStream(num, at)) return undefined;
    const root = file.dict(trailer.dict.get("Root"));
    if (!root) return undefined;
    file.root = root;
    return file;
  }

  /** Reads an object stream's index, so its objects can be found (a later definition by file position wins). */
  private indexObjectStream(num: number, at: number): boolean {
    const stream = this.stream(new PdfRef(num));
    const n = stream?.dict.get("N");
    const first = stream?.dict.get("First");
    if (!stream || typeof n !== "number" || typeof first !== "number") return false;
    const text = this.decode(stream, num);
    if (text === undefined) return false;
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    const offsets: number[] = [];
    for (let i = 0; i < Math.min(n, header.length / 2); i++) {
      const member = header[2 * i];
      offsets.push(header[2 * i + 1]);
      if (!Number.isInteger(member)) return false;
      if ((this.top.get(member)?.at ?? -1) < at) this.packed.set(member, { stream: num, index: i });
    }
    this.objectStreams.set(num, { text, first, offsets });
    return true;
  }

  /** The object a value refers to (or the value itself); undefined when missing or damaged. */
  get(value: PdfValue | undefined): PdfValue | PdfStream | undefined {
    if (!(value instanceof PdfRef)) return value;
    const num = value.num;
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached ?? undefined;
    if (this.resolving > 8) return undefined; // references to references (e.g. /Length) only go so deep
    this.resolving++;
    let result: PdfValue | PdfStream | undefined;
    try {
      const member = this.packed.get(num);
      const body = this.top.get(num);
      if (member) {
        const holder = this.objectStreams.get(member.stream)!;
        const start = holder.first + holder.offsets[member.index];
        const end = member.index + 1 < holder.offsets.length ? holder.first + holder.offsets[member.index + 1] : holder.text.length;
        result = parsePdfValue(holder.text.slice(start, end), { pos: 0 });
      } else if (body) {
        const value = parsePdfValue(latin1(this.buf.subarray(body.at, body.streamAt >= 0 ? body.streamAt : body.end)), { pos: 0 });
        result = body.streamAt >= 0 && isDict(value) ? this.streamAt(value, body.streamAt, body.end) : value;
      }
    } finally {
      this.resolving--;
    }
    this.cache.set(num, result ?? null);
    return result;
  }

  /** The stream whose "stream" keyword is at `keyword`, its data ending by /Length, else at the "endstream" before `bodyEnd`. */
  private streamAt(dict: PdfDict, keyword: number, bodyEnd: number): PdfStream {
    let start = keyword + 6;
    if (this.buf[start] === 13) start++;
    if (this.buf[start] === 10) start++;
    const length = this.get(dict.get("Length"));
    let end = typeof length === "number" && length >= 0 ? start + length : -1;
    // Trust /Length only when "endstream" follows it.
    if (end < 0 || end > this.buf.length || !latin1(this.buf.subarray(end, end + 32)).includes("endstream")) {
      const found = this.buf.subarray(start, Math.max(start, bodyEnd)).indexOf("endstream");
      end = found < 0 ? Math.max(start, bodyEnd) : start + found;
      while (end > start && (this.buf[end - 1] === 10 || this.buf[end - 1] === 13)) end--;
    }
    return { dict, start, end };
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const v = this.get(value);
    return isDict(v) ? v : isStream(v) ? v.dict : undefined;
  }

  array(value: PdfValue | undefined): PdfValue[] | undefined {
    const v = this.get(value);
    return Array.isArray(v) ? v : undefined;
  }

  stream(value: PdfValue | undefined): PdfStream | undefined {
    const v = this.get(value);
    return isStream(v) ? v : undefined;
  }

  /**
   * A stream's decoded bytes, within the file's unpacking budget and `maxBytes`; undefined for
   * filters other than Flate, damaged data or a stream too large to unpack (which is noted when
   * the file's own limit was hit, not the caller's).
   */
  decodeBytes(stream: PdfStream, maxBytes = MAX_PART_BYTES): Uint8Array | undefined {
    const filters = [this.get(stream.dict.get("Filter"))].flat().map((f) => nameOf(f as PdfValue));
    if (!filters.every((f) => f === undefined || f === "FlateDecode" || f === "Fl") || filters.length > 2) return undefined;
    let data: Uint8Array = this.buf.subarray(stream.start, stream.end);
    try {
      for (const filter of filters) {
        if (!filter) continue;
        const limit = Math.min(maxBytes, this.budget.partBytes);
        if (limit <= 0) throw new RangeError("budget");
        data = inflate(data, "deflate", limit);
        this.budget.spend(data.length);
      }
      return data;
    } catch (err) {
      if (!isOverLimit(err)) return undefined;
      const limit = Math.min(maxBytes, this.budget.partBytes);
      if (this.budget.partBytes <= maxBytes) this.budget.cut(this.budget.partBytes <= 0 ? FILE_TOO_LARGE : PDF_PART_TOO_LARGE);
      // An aborted inflate did the work of `limit` bytes: charge it, so a file can't have it done over and over.
      this.budget.spend(limit);
      return undefined;
    }
  }

  /** A stream's decoded content (one character per byte), see decodeBytes; cached by object number, failures too. */
  decode(stream: PdfStream, num?: number, maxBytes = MAX_PART_BYTES): string | undefined {
    if (num !== undefined && this.decoded.has(num)) return this.decoded.get(num) ?? undefined;
    const data = this.decodeBytes(stream, maxBytes);
    const result = data && latin1(data);
    if (num !== undefined) this.decoded.set(num, result ?? null);
    return result;
  }

  /** A font program (a /FontFile2 stream) parsed once per object; undefined when missing, not TrueType, damaged or over MAX_FONT_BYTES. */
  fontProgram(value: PdfValue | undefined): FontProgram | undefined {
    if (!(value instanceof PdfRef)) return undefined;
    const cached = this.programs.get(value.num);
    if (cached !== undefined) return cached ?? undefined;
    const stream = this.stream(value);
    const bytes = stream && this.decodeBytes(stream, MAX_FONT_BYTES);
    let result: FontProgram | undefined;
    if (bytes && bytes.length <= MAX_FONT_BYTES) {
      this.budget.spend(bytes.length);
      result = FontProgram.parse(bytes);
    }
    this.programs.set(value.num, result ?? null);
    return result;
  }

  /** A CMap stream (a font's /ToUnicode, or a composite font's /Encoding), parsed once per object; undefined when missing or unusable. */
  cmap(value: PdfValue | undefined): CMap | undefined {
    if (!(value instanceof PdfRef)) return undefined;
    const cached = this.cmaps.get(value.num);
    if (cached !== undefined) return cached ?? undefined;
    const stream = this.stream(value);
    const text = stream && this.decode(stream, value.num, MAX_CMAP_BYTES);
    let result: CMap | undefined;
    if (text !== undefined && text.length <= MAX_CMAP_BYTES) {
      this.budget.spend(text.length);
      result = parseCMap(text);
    }
    this.cmaps.set(value.num, result ?? null);
    return result;
  }
}

// ---------- PDF fonts ----------

/** Most text of one CMap that is parsed (inflated), mappings kept from it, and codes one bfrange may span. */
const MAX_CMAP_BYTES = 2 * 1024 * 1024;
const MAX_CMAP_ENTRIES = 200_000;
const MAX_CMAP_SPAN = 65_536;
/** Most entries read from an encoding's /Differences array, and from a CID font's /W widths (single widths, and wide ranges). */
const MAX_DIFFERENCES = 1_024;
const MAX_CID_WIDTHS = 65_536;
const MAX_CID_RANGES = 64;

/** The text of each byte in Windows-1252 (WinAnsiEncoding), PDF's common single-byte text encoding. */
const WIN1252 = win1252Decoder.decode(Uint8Array.from({ length: 256 }, (_, i) => i));

/** Glyph names of the printable ASCII characters, in order. */
const ASCII_NAMES = [
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash",
  "zero one two three four five six seven eight nine colon semicolon less equal greater question at",
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].join(" "),
  "bracketleft backslash bracketright asciicircum underscore grave",
  [..."abcdefghijklmnopqrstuvwxyz"].join(" "),
  "braceleft bar braceright asciitilde",
].join(" ");
/** Glyph names of U+00A0–U+00FF, in order. */
const LATIN1_NAMES =
  "space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron " +
  "degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown " +
  "Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis " +
  "Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls " +
  "agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis " +
  "eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis";
/** Glyph names of the Greek letters U+0391–U+03A9 and U+03B1–U+03C9, in order ("." where unassigned); "mu" keeps its Latin-1 meaning. */
const GREEK_CAPITAL_NAMES = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho . Sigma Tau Upsilon Phi Chi Psi Omega";
const GREEK_NAMES = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma1 sigma tau upsilon phi chi psi omega";
/** Glyph names of Windows-1252's bytes 0x80–0x9F, in order ("." where the byte has no character). */
const WIN1252_NAMES =
  "Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE . Zcaron . " +
  ". quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe . zcaron Ydieresis";
/** Glyph names of MacRomanEncoding's bytes 0x80–0xFF, in order. */
const MACROMAN_NAMES =
  "Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave " +
  "ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis " +
  "dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash " +
  "infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash " +
  "questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe " +
  "endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl " +
  "daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex " +
  "apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron";
/** StandardEncoding's bytes above 0xA0 that have a glyph, as "byte name" pairs (its ASCII range is read as Windows-1252). */
const STANDARD_NAMES =
  "A1 exclamdown A2 cent A3 sterling A4 fraction A5 yen A6 florin A7 section A8 currency A9 quotesingle AA quotedblleft AB guillemotleft " +
  "AC guilsinglleft AD guilsinglright AE fi AF fl B1 endash B2 dagger B3 daggerdbl B4 periodcentered B6 paragraph B7 bullet B8 quotesinglbase " +
  "B9 quotedblbase BA quotedblright BB guillemotright BC ellipsis BD perthousand BF questiondown C1 grave C2 acute C3 circumflex C4 tilde " +
  "C5 macron C6 breve C7 dotaccent C8 dieresis CA ring CB cedilla CD hungarumlaut CE ogonek CF caron D0 emdash E1 AE E3 ordfeminine " +
  "E8 Lslash E9 Oslash EA OE EB ordmasculine F1 ae F5 dotlessi F8 lslash F9 oslash FA oe FB germandbls";
/** Other common glyph names: ligatures, typographic marks, accents and the symbols MacRomanEncoding names. */
const OTHER_GLYPHS: Record<string, string> = {
  fi: "\ufb01", fl: "\ufb02", ff: "\ufb00", ffi: "\ufb03", ffl: "\ufb04", fraction: "\u2044", minus: "\u2212", dotlessi: "\u0131", Lslash: "\u0141",
  lslash: "\u0142", caron: "\u02c7", breve: "\u02d8", dotaccent: "\u02d9", ring: "\u02da", ogonek: "\u02db", hungarumlaut: "\u02dd",
  nbspace: "\u00a0", nonbreakingspace: "\u00a0", sfthyphen: "\u00ad", softhyphen: "\u00ad", quotereversed: "\u201b", notequal: "\u2260",
  infinity: "\u221e", lessequal: "\u2264", greaterequal: "\u2265", partialdiff: "\u2202", summation: "\u2211", product: "\u220f", pi: "\u03c0",
  integral: "\u222b", Omega: "\u03a9", radical: "\u221a", approxequal: "\u2248", Delta: "\u2206", lozenge: "\u25ca", apple: "\uf8ff",
  arrowleft: "\u2190", arrowup: "\u2191", arrowright: "\u2192", arrowdown: "\u2193",
};

let glyphs: Map<string, string> | undefined;
let macRoman: string[] | undefined;
let standard: string[] | undefined;

/** Glyph name → text, from the lists above (built on first use). */
function glyphList(): Map<string, string> {
  if (glyphs) return glyphs;
  const list = (glyphs = new Map<string, string>());
  const define = (names: string, from: number, source?: string) =>
    names.split(" ").forEach((name, i) => {
      if (name !== "." && !list.has(name)) list.set(name, source ? source[from + i] : String.fromCharCode(from + i));
    });
  define(ASCII_NAMES, 0x20);
  define(LATIN1_NAMES, 0xa0);
  define(WIN1252_NAMES, 0x80, WIN1252);
  for (const [name, text] of Object.entries(OTHER_GLYPHS)) list.set(name, text);
  define(GREEK_CAPITAL_NAMES, 0x391);
  define(GREEK_NAMES, 0x3b1);
  return list;
}

/**
 * The text of a glyph name: the Adobe Glyph List subset above, uniXXXX (several in a row for
 * ligatures), uXXXX[XX], variants like "a.sc" and ligatures like "f_f_i"; undefined for names
 * that say nothing about the character (g12, cid7, glyph3, index9, …).
 */
function glyphText(name: string): string | undefined {
  const known = glyphList().get(name);
  if (known !== undefined) return known;
  const m = /^(?:uni((?:[0-9A-Fa-f]{4})+)|u([0-9A-Fa-f]{4,6}))$/.exec(name);
  if (m?.[1]) {
    let out = "";
    for (let i = 0; i < m[1].length; i += 4) out += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return out;
  }
  if (m?.[2]) {
    const code = parseInt(m[2], 16);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : undefined;
  }
  const dot = name.indexOf(".");
  if (dot > 0) return glyphText(name.slice(0, dot));
  if (name.includes("_")) {
    const parts = name.split("_").map((part) => (part ? glyphText(part) : undefined));
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
  }
  return undefined;
}

/** The text of each byte in MacRomanEncoding or StandardEncoding; undefined for WinAnsiEncoding (Windows-1252) and unknown names. */
function baseEncoding(name: string | undefined): string[] | undefined {
  if (name === "MacRomanEncoding") {
    if (!macRoman) {
      macRoman = Array.from(WIN1252);
      MACROMAN_NAMES.split(" ").forEach((glyph, i) => (macRoman![0x80 + i] = glyphText(glyph) ?? ""));
    }
    return macRoman;
  }
  if (name === "StandardEncoding") {
    if (!standard) {
      standard = Array.from(WIN1252);
      const pairs = STANDARD_NAMES.split(" ");
      for (let i = 0; i < pairs.length; i += 2) standard[parseInt(pairs[i], 16)] = glyphText(pairs[i + 1]) ?? "";
    }
    return standard;
  }
  return undefined;
}

/**
 * The text of each byte under a simple font's /Encoding: a base encoding's table, with the glyph
 * names of a /Differences array applied on top; undefined when Windows-1252 (the fast path) is right.
 */
function encodingTable(file: PdfFile, encoding: PdfValue | PdfStream | undefined): string[] | undefined {
  if (!isDict(encoding)) return baseEncoding(nameOf(encoding));
  const base = baseEncoding(nameOf(file.get(encoding.get("BaseEncoding"))));
  const differences = file.array(encoding.get("Differences"));
  if (!differences?.length) return base;
  const table = Array.from(base ?? WIN1252);
  let code = 0;
  let changed = false;
  for (const item of differences.slice(0, MAX_DIFFERENCES)) {
    if (typeof item === "number") code = Math.trunc(item);
    else if (item instanceof PdfName) {
      const text = glyphText(item.name);
      if (text !== undefined && code >= 0 && code < 256 && table[code] !== text) {
        table[code] = text;
        changed = true;
      }
      code++;
    }
  }
  return changed || base ? table : undefined;
}

/** A CMap's codespace (ranges by code length in bytes, index 1–4, as lo, hi, lo, hi, …) and its code → text mappings. */
interface CMap {
  codespace: number[][];
  map: Map<number, string>;
}

/**
 * The UTF-16BE text of a CMap destination string whose hex digits sit at [start, end), with the
 * given value and digit count. <0000> is what some producers write for glyphs without a character
 * (it means "none", not a NUL).
 */
function cmapText(s: string, value: number, digits: number, start: number, end: number): string {
  if (digits === 0 || (digits <= 4 && value === 0)) return "";
  if (digits <= 4) return String.fromCharCode(digits % 2 ? value * 16 : value);
  const hex = s.slice(start, end).replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16));
  return out;
}

/** Hex digit values by character code (-1 for other characters). */
const HEX_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i++) HEX_VALUE["0123456789ABCDEF".charCodeAt(i)] = HEX_VALUE["0123456789abcdef".charCodeAt(i)] = i;

/** The sections of a CMap that matter here. */
const enum CMapSection {
  Other,
  Codespace,
  Char,
  Range,
}

/**
 * Parses a CMap (PostScript-like text): codespacerange, bfchar and bfrange sections, the latter
 * as "<lo> <hi> <dst>" (dst's last code unit counts up) or "<lo> <hi> [<dst> …]"; destinations are
 * UTF-16BE. Bounded by MAX_CMAP_BYTES of text and MAX_CMAP_ENTRIES mappings; ranges with lo > hi
 * or over MAX_CMAP_SPAN codes are skipped. Damaged input never throws: what was read so far is kept.
 * Hand-written scanning (no regular expressions, no per-token allocation): large CMaps are hostile.
 */
function parseCMap(s: string): CMap {
  const codespace: number[][] = [[], [], [], [], []];
  const map = new Map<number, string>();
  const n = Math.min(s.length, MAX_CMAP_BYTES);
  let entries = 0;
  let section = CMapSection.Other;
  // Up to three pending hex operands of the entry being read: value (of the first 8 digits), digit count and, for destinations, where the digits are.
  let k = 0;
  let v0 = 0, d0 = 0; // prettier-ignore
  let v1 = 0, d1 = 0, s1 = 0, e1 = 0; // prettier-ignore
  let v2 = 0, d2 = 0, s2 = 0, e2 = 0; // prettier-ignore
  let array: string[] | undefined;
  const addRange = (lo: number, hi: number, dst: string | string[]) => {
    if (hi < lo || hi - lo >= MAX_CMAP_SPAN) return;
    const last = Math.min(hi, lo + (MAX_CMAP_ENTRIES - entries) - 1);
    if (Array.isArray(dst)) {
      for (let c = lo, i = 0; c <= last && i < dst.length; c++, i++) map.set(c, dst[i]);
    } else if (!dst) {
      for (let c = lo; c <= last; c++) map.set(c, "");
    } else {
      const head = dst.slice(0, -1);
      const unit = dst.charCodeAt(dst.length - 1);
      for (let c = lo, i = 0; c <= last; c++, i++) map.set(c, head ? head + String.fromCharCode(unit + i) : String.fromCharCode(unit + i));
    }
    entries += last - lo + 1;
  };
  let pos = 0;
  while (pos < n && entries < MAX_CMAP_ENTRIES) {
    const c = s.charCodeAt(pos);
    if (c <= 32) {
      pos++;
    } else if (c === 60 /* < */) {
      if (s.charCodeAt(pos + 1) === 60) {
        pos += 2;
        continue;
      }
      let value = 0;
      let count = 0;
      let i = pos + 1;
      for (; i < n; i++) {
        const d = s.charCodeAt(i);
        const v = d < 128 ? HEX_VALUE[d] : -1;
        if (v < 0) {
          if (d === 62 /* > */) break;
          continue;
        }
        if (count < 8) value = value * 16 + v;
        count++;
      }
      const start = pos + 1;
      pos = i + 1;
      if (array) {
        array.push(cmapText(s, value, count, start, i));
        continue;
      }
      if (k === 0) {
        v0 = value;
        d0 = count;
      } else if (k === 1) {
        v1 = value;
        d1 = count;
        s1 = start;
        e1 = i;
      } else {
        v2 = value;
        d2 = count;
        s2 = start;
        e2 = i;
      }
      k++;
      // Codes with an odd number of digits end in an implied 0, like PDF hex strings.
      if (section === CMapSection.Char) {
        if (k === 2) {
          if (d0 > 0 && d0 <= 8) {
            map.set(d0 % 2 ? v0 * 16 : v0, cmapText(s, v1, d1, s1, e1));
            entries++;
          }
          k = 0;
        }
      } else if (section === CMapSection.Range) {
        if (k === 3) {
          if (d0 > 0 && d0 <= 8 && d1 <= 8) addRange(d0 % 2 ? v0 * 16 : v0, d1 % 2 ? v1 * 16 : v1, cmapText(s, v2, d2, s2, e2));
          k = 0;
        }
      } else if (section === CMapSection.Codespace) {
        if (k === 2) {
          const bytes = Math.ceil(d0 / 2);
          if (bytes >= 1 && bytes <= 4 && d1 <= 8) codespace[bytes].push(d0 % 2 ? v0 * 16 : v0, d1 % 2 ? v1 * 16 : v1);
          k = 0;
        }
      } else k = 0;
    } else if (c === 91 /* [ */) {
      if (section === CMapSection.Range && k === 2) array = [];
      pos++;
    } else if (c === 93 /* ] */) {
      if (array && d0 > 0 && d0 <= 8 && d1 <= 8) addRange(d0 % 2 ? v0 * 16 : v0, d1 % 2 ? v1 * 16 : v1, array);
      array = undefined;
      k = 0;
      pos++;
    } else if (c === 47 /* / */) {
      PDF_NAME.lastIndex = pos;
      const name = pdfName(PDF_NAME.exec(s)![1]);
      pos = PDF_NAME.lastIndex;
      if (array) array.push(glyphText(name) ?? "");
      else if (section === CMapSection.Char && k === 1) {
        if (d0 > 0 && d0 <= 8) {
          map.set(d0 % 2 ? v0 * 16 : v0, glyphText(name) ?? "");
          entries++;
        }
        k = 0;
      }
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let i = pos + 1;
      while (i < n && ((s.charCodeAt(i) >= 65 && s.charCodeAt(i) <= 90) || (s.charCodeAt(i) >= 97 && s.charCodeAt(i) <= 122))) i++;
      const word = s.slice(pos, i);
      pos = i;
      if (word.startsWith("begin")) {
        const name = word.slice(5);
        section = name === "bfchar" ? CMapSection.Char : name === "bfrange" ? CMapSection.Range : name === "codespacerange" ? CMapSection.Codespace : CMapSection.Other;
      } else if (word.startsWith("end")) section = CMapSection.Other;
      else continue;
      array = undefined;
      k = 0;
    } else if (c === 40 /* ( */) {
      readLiteral(s, pos);
      pos = literalEnd;
    } else if (c === 37 /* % */) {
      while (pos < n && s.charCodeAt(pos) !== 10 && s.charCodeAt(pos) !== 13) pos++;
    } else pos++;
  }
  return { codespace, map };
}

/** Most bytes of an embedded font program that are read, and most glyphs, cmap groups and characters taken from one. */
const MAX_FONT_BYTES = 1024 * 1024;
const MAX_GLYPHS = 65_536;
const MAX_CMAP_GROUPS = 10_000;
const MAX_FONT_CHARS = 200_000;

/** The four-character tag of a table in a font program. */
const tagAt = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/**
 * What an embedded TrueType program says about its glyphs: the character of each glyph id, from
 * the font's cmap (a format 4 or 12 subtable, Unicode platforms preferred; the first character
 * mapped to a glyph wins), and for a glyph that is just another glyph drawn elsewhere (a composite
 * with one component, as .case and similar variants often are), that glyph's character. Every
 * read is bounds-checked; a damaged font gives what could be read.
 */
class FontProgram {
  private readonly texts = new Map<number, string>();
  private glyf?: { view: DataView; glyf: number; glyfEnd: number; loca: number; locaEnd: number; long: boolean; count: number };

  /** The program, or undefined when it isn't TrueType (CFF and collections aren't read) or has no usable cmap. */
  static parse(bytes: Uint8Array): FontProgram | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
      const program = new FontProgram();
      return program.read(view) ? program : undefined;
    } catch {
      return undefined; // past the end of a damaged font
    }
  }

  get size() {
    return this.texts.size;
  }

  /** The text of a glyph, by id; undefined when the font says nothing about it. */
  text(gid: number, depth = 0): string | undefined {
    const known = this.texts.get(gid);
    if (known !== undefined) return known || undefined;
    let text = "";
    if (depth < 2) {
      const base = this.component(gid);
      if (base !== undefined && base !== gid) text = this.text(base, depth + 1) ?? "";
    }
    if (this.texts.size < 2 * MAX_GLYPHS) this.texts.set(gid, text);
    return text || undefined;
  }

  private read(view: DataView): boolean {
    const tag = view.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x74727565 /* "true" */) return false;
    const numTables = Math.min(view.getUint16(4), 64);
    const tables = new Map<string, { at: number; end: number }>();
    for (let i = 0; i < numTables; i++) {
      const record = 12 + i * 16;
      const at = view.getUint32(record + 8);
      const end = at + view.getUint32(record + 12);
      if (end <= view.byteLength) tables.set(tagAt(view, record), { at, end });
    }
    const cmap = tables.get("cmap");
    if (!cmap) return false;
    // The subtable to read: Unicode (platform 0, or 3 with encoding 1 or 10) in format 12 (full) or 4 (BMP).
    let best: { at: number; score: number } | undefined;
    const subtables = Math.min(view.getUint16(cmap.at + 2), 64);
    for (let i = 0; i < subtables; i++) {
      const record = cmap.at + 4 + i * 8;
      const platform = view.getUint16(record);
      const encoding = view.getUint16(record + 2);
      const at = cmap.at + view.getUint32(record + 4);
      if (at + 4 > cmap.end) continue;
      const format = view.getUint16(at);
      if (format !== 4 && format !== 12) continue;
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      const score = (format === 12 ? 2 : 1) + (unicode ? 2 : 0);
      if (!best || score > best.score) best = { at, score };
    }
    if (!best) return false;
    if (view.getUint16(best.at) === 4) this.readFormat4(view, best.at, cmap.end);
    else this.readFormat12(view, best.at, cmap.end);
    const head = tables.get("head");
    const maxp = tables.get("maxp");
    const loca = tables.get("loca");
    const glyf = tables.get("glyf");
    if (head && maxp && loca && glyf) {
      this.glyf = { view, glyf: glyf.at, glyfEnd: glyf.end, loca: loca.at, locaEnd: loca.end, long: view.getInt16(head.at + 50) === 1, count: Math.min(view.getUint16(maxp.at + 4), MAX_GLYPHS) };
    }
    return this.texts.size > 0;
  }

  private map(code: number, gid: number) {
    if (gid === 0 || gid >= MAX_GLYPHS || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || this.texts.has(gid)) return;
    this.texts.set(gid, String.fromCodePoint(code));
  }

  private readFormat4(view: DataView, at: number, end: number) {
    const segments = view.getUint16(at + 6) >> 1;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    if (rangeOffsets + segments * 2 > end) return;
    let chars = 0;
    for (let i = 0; i < segments && chars < MAX_FONT_CHARS; i++) {
      const last = view.getUint16(ends + i * 2);
      const first = view.getUint16(starts + i * 2);
      const delta = view.getInt16(deltas + i * 2);
      const rangeOffset = view.getUint16(rangeOffsets + i * 2);
      for (let code = first; code <= last && code !== 0xffff && chars < MAX_FONT_CHARS; code++, chars++) {
        let gid: number;
        if (rangeOffset === 0) gid = (code + delta) & 0xffff;
        else {
          const glyphAt = rangeOffsets + i * 2 + rangeOffset + (code - first) * 2;
          if (glyphAt + 2 > end) break;
          gid = view.getUint16(glyphAt);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        this.map(code, gid);
      }
    }
  }

  private readFormat12(view: DataView, at: number, end: number) {
    const groups = Math.min(view.getUint32(at + 12), MAX_CMAP_GROUPS);
    if (at + 16 + groups * 12 > end) return;
    let chars = 0;
    for (let i = 0; i < groups && chars < MAX_FONT_CHARS; i++) {
      const group = at + 16 + i * 12;
      const first = view.getUint32(group);
      const last = view.getUint32(group + 4);
      const gid = view.getUint32(group + 8);
      for (let code = first; code <= last && chars < MAX_FONT_CHARS; code++, chars++) {
        if (gid + (code - first) >= MAX_GLYPHS) break;
        this.map(code, gid + (code - first));
      }
    }
  }

  /** The one glyph a composite glyph is made of (unscaled or not), or undefined for simple glyphs and other composites. */
  private component(gid: number): number | undefined {
    const g = this.glyf;
    if (!g || gid + 1 >= g.count) return undefined;
    try {
      const { view, long } = g;
      const start = g.glyf + (long ? view.getUint32(g.loca + gid * 4) : view.getUint16(g.loca + gid * 2) * 2);
      const stop = g.glyf + (long ? view.getUint32(g.loca + gid * 4 + 4) : view.getUint16(g.loca + gid * 2 + 2) * 2);
      if (stop - start < 14 || stop > g.glyfEnd || view.getInt16(start) >= 0) return undefined;
      const flags = view.getUint16(start + 10);
      return flags & 0x20 /* more components */ ? undefined : view.getUint16(start + 12);
    } catch {
      return undefined;
    }
  }
}

/**
 * What text extraction needs from a font: how a string's bytes split into character codes, the
 * text of each code, and glyph widths (in 1/1000 em) for placing runs.
 */
interface PdfFont {
  /** A composite (Type0) font: codes are two bytes, or what `codespace` says. */
  composite: boolean;
  /** Composite fonts: codespace ranges by code length in bytes (index 1–4), when codes aren't simply two bytes. */
  codespace?: number[][];
  /** The shortest code length in `codespace`, used for bytes that match no range. */
  shortest?: number;
  /** Composite fonts: the text of each code, from the ToUnicode CMap; codes it lacks give nothing. */
  map?: Map<number, string>;
  /** `map` as an array by code, when the codes are compact enough for one (then `map` isn't consulted). */
  texts?: (string | undefined)[];
  /** Composite fonts with an embedded TrueType program: the text of a code's glyph by the program's own cmap, for codes the CMap lacks (or maps to nothing). */
  glyph?: (code: number) => string | undefined;
  /**
   * Composite fonts without a ToUnicode CMap: codes are UTF-16BE ("utf16", the Uni*-UCS2/UTF16
   * encodings), or unknown but kept as bytes like before ("bytes", Identity orderings; the
   * readability check then rejects the result); otherwise (another ordering) nothing comes out.
   */
  raw?: "utf16" | "bytes";
  /** Simple fonts: the text of each byte, when the encoding isn't WinAnsi (Windows-1252) or a ToUnicode CMap says more. */
  table?: string[];
  /** Simple fonts: /Widths from /FirstChar, and the width of codes outside them. */
  first: number;
  widths: number[];
  missing: number;
  /**
   * Composite fonts: widths by CID (/W as single widths, in `table` by CID when the CIDs are compact
   * (NaN where unset) else in `widths`, and as ranges first, last, width, …) and the default (/DW);
   * CID = code for Identity encodings.
   */
  cid?: { widths: Map<number, number>; table?: Float64Array; ranges: number[]; dw: number; identity: boolean };
  /** False when widths are guessed (fonts without /Widths, e.g. the standard 14), so run ends are estimates. */
  exact: boolean;
}

const DEFAULT_FONT: PdfFont = { composite: false, first: 0, widths: [], missing: 500, exact: false };

/** The font a content stream's Tf names, through the (inherited) /Resources /Font dictionary; one decoder per font object. */
function fontOf(ctx: ContentContext, resources: PdfDict | undefined, name: string): PdfFont {
  const file = ctx.file;
  const entry = file?.dict(resources?.get("Font"))?.get(name);
  const key = entry instanceof PdfRef ? entry.num : isDict(entry) ? entry : undefined;
  if (!file || key === undefined) return DEFAULT_FONT;
  let font = ctx.fonts.get(key);
  if (!font) {
    const dict = file.dict(entry);
    font = dict ? loadFont(file, dict) : DEFAULT_FONT;
    ctx.fonts.set(key, font);
  }
  return font;
}

/** Reads a font dictionary; a damaged font never fails the page (its text comes out as before: bytes as Windows-1252). */
function loadFont(file: PdfFile, dict: PdfDict): PdfFont {
  const composite = nameOf(dict.get("Subtype")) === "Type0";
  try {
    return composite ? loadCompositeFont(file, dict) : loadSimpleFont(file, dict);
  } catch {
    return composite ? { ...DEFAULT_FONT, composite: true, raw: "bytes" } : DEFAULT_FONT;
  }
}

function loadCompositeFont(file: PdfFile, dict: PdfDict): PdfFont {
  const descendant = file.dict(file.array(dict.get("DescendantFonts"))?.[0]);
  const encoding = file.get(dict.get("Encoding"));
  const encodingName = nameOf(encoding) ?? (isStream(encoding) ? "" : "Identity-H");
  const identity = encodingName === "Identity-H" || encodingName === "Identity-V";
  const toUnicode = file.cmap(dict.get("ToUnicode"));
  const font: PdfFont = { ...DEFAULT_FONT, composite: true, map: toUnicode?.map };
  if (toUnicode?.map.size) {
    const max = compactMax(toUnicode.map.keys(), toUnicode.map.size);
    if (max >= 0) {
      font.texts = new Array<string | undefined>(max + 1);
      for (const [code, text] of toUnicode.map) font.texts[code] = text;
    }
  }
  // Codes are two bytes under the Identity encodings; otherwise the encoding CMap's codespace says, or the ToUnicode CMap's.
  const codespace = identity ? undefined : isStream(encoding) ? file.cmap(dict.get("Encoding"))?.codespace : toUnicode?.codespace;
  if (codespace?.some((ranges) => ranges.length)) {
    font.codespace = codespace;
    font.shortest = codespace.findIndex((ranges) => ranges.length);
  }
  // An embedded TrueType program's cmap names the glyphs' characters: for codes the CMap lacks, or every code when there is no CMap.
  const fontFile = file.dict(descendant?.get("FontDescriptor"))?.get("FontFile2");
  if (identity && fontFile instanceof PdfRef) {
    const cidToGid = file.get(descendant?.get("CIDToGIDMap"));
    const gidOf = isStream(cidToGid) ? file.decodeBytes(cidToGid, 2 * MAX_GLYPHS) : undefined;
    let program: FontProgram | null | undefined = null; // null: not read yet
    font.glyph = (code) => {
      if (program === null) program = file.fontProgram(fontFile);
      if (!program) return undefined;
      const gid = gidOf ? (2 * code + 1 < gidOf.length ? gidOf[2 * code] * 256 + gidOf[2 * code + 1] : 0) : code;
      return gid ? program.text(gid) : undefined;
    };
    if (!toUnicode && !file.fontProgram(fontFile)?.size) font.glyph = undefined;
  }
  if (!toUnicode && !font.glyph) {
    const ordering = file.get(file.dict(descendant?.get("CIDSystemInfo"))?.get("Ordering"));
    if (/^Uni\w+-(UCS2|UTF16)-[HV]$/.test(encodingName)) font.raw = "utf16";
    else if (!(ordering instanceof PdfString) || ordering.bytes === "Identity") font.raw = "bytes";
  }
  // Glyph widths by CID: /W holds "c [w1 w2 …]" and "cfirst clast w" entries; /DW is the width of the rest.
  const dw = file.get(descendant?.get("DW"));
  const w = file.array(descendant?.get("W"));
  const cid: NonNullable<PdfFont["cid"]> = { widths: new Map(), ranges: [], dw: typeof dw === "number" && dw >= 0 ? dw : 1000, identity };
  for (let i = 0; w && i < w.length && cid.widths.size < MAX_CID_WIDTHS; ) {
    const first = w[i];
    const next = file.get(w[i + 1]);
    if (typeof first !== "number") break;
    if (Array.isArray(next)) {
      next.slice(0, MAX_CID_WIDTHS - cid.widths.size).forEach((width, k) => typeof width === "number" && cid.widths.set(first + k, width));
      i += 2;
    } else if (typeof next === "number") {
      const width = w[i + 2];
      if (typeof width !== "number") break;
      if (next - first < 1024) for (let c = first; c <= next && cid.widths.size < MAX_CID_WIDTHS; c++) cid.widths.set(c, width);
      else if (cid.ranges.length < 3 * MAX_CID_RANGES) cid.ranges.push(first, next, width);
      i += 3;
    } else break;
  }
  const max = cid.widths.size ? compactMax(cid.widths.keys(), cid.widths.size) : -1;
  if (max >= 0) {
    cid.table = new Float64Array(max + 1).fill(NaN);
    for (const [c, width] of cid.widths) cid.table[c] = width;
  }
  font.cid = cid;
  font.exact = identity && (cid.widths.size > 0 || cid.ranges.length > 0 || typeof dw === "number");
  return font;
}

/** The largest of `size` integer keys when an array by key would be reasonably full (else -1): a lookup table beats a Map in the hot loop. */
function compactMax(keys: Iterable<number>, size: number): number {
  let max = -1;
  for (const key of keys) {
    if (!(key >= 0 && key <= 0xffff && Number.isInteger(key))) return -1;
    if (key > max) max = key;
  }
  return max < 4 * size + 1024 ? max : -1;
}

function loadSimpleFont(file: PdfFile, dict: PdfDict): PdfFont {
  let widths = file.array(dict.get("Widths"))?.map((w) => (typeof w === "number" ? w : 0)) ?? [];
  // Type 3 glyph widths are in glyph space, which /FontMatrix maps to text space.
  const matrix = nameOf(dict.get("Subtype")) === "Type3" ? toMatrix(file.get(dict.get("FontMatrix"))) : undefined;
  if (matrix) widths = widths.map((w) => w * matrix[0] * 1000);
  const first = dict.get("FirstChar");
  const missing = file.dict(dict.get("FontDescriptor"))?.get("MissingWidth");
  // A ToUnicode CMap says what the codes mean best; the encoding fills in the codes it lacks.
  const toUnicode = file.cmap(dict.get("ToUnicode"));
  let table = encodingTable(file, file.get(dict.get("Encoding")));
  if (toUnicode?.map.size) {
    table = Array.from(table ?? WIN1252);
    for (const [code, text] of toUnicode.map) if (code >= 0 && code < 256) table[code] = text;
  }
  return {
    composite: false,
    table,
    first: typeof first === "number" ? first : 0,
    widths,
    missing: typeof missing === "number" && missing > 0 ? missing : widths.length ? 0 : 500,
    exact: widths.length > 0,
  };
}

/** The width of a CID font's glyph (1/1000 em). */
function cidWidth(cid: PdfFont["cid"], code: number): number {
  if (!cid) return 1000;
  if (!cid.identity) return cid.dw;
  const table = cid.table;
  if (table) {
    const width = code < table.length ? table[code] : NaN;
    if (width === width) return width;
  } else {
    const width = cid.widths.get(code);
    if (width !== undefined) return width;
  }
  const ranges = cid.ranges;
  for (let k = 0; k < ranges.length; k += 3) if (code >= ranges[k] && code <= ranges[k + 1]) return ranges[k + 2];
  return cid.dw;
}

/** A shown string decoded: its text, the sum of its glyph widths (1/1000 em), its number of codes, and of single-byte spaces (which word spacing applies to). */
interface TextRun {
  text: string;
  width: number;
  count: number;
  spaces: number;
}

/** The result of decodeRun: one object, filled in for each call (its caller reads it at once). */
const RUN: TextRun = { text: "", width: 0, count: 0, spaces: 0 };
/** The code units of the run being decoded. */
const UNITS: number[] = [];

/** Decodes a shown string through its font: Windows-1252 for ordinary simple fonts (no copying), else code by code. */
function decodeRun(font: PdfFont, raw: string): TextRun {
  let width = 0;
  let spaces = 0;
  let text = "";
  if (!font.composite) {
    const { table } = font;
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      if (code === 32) spaces++;
      const w = font.widths[code - font.first];
      width += w === undefined || w <= 0 ? (code === 32 ? 250 : font.missing || 500) : w;
      if (table) text += table[code];
    }
    RUN.text = table ? text : win1252(raw);
    RUN.width = width;
    RUN.count = raw.length;
    RUN.spaces = spaces;
    return RUN;
  }
  const { codespace, map, texts, glyph, cid } = font;
  const table = cid?.table;
  const utf16 = font.raw === "utf16";
  let count = 0;
  let units = 0;
  for (let i = 0; i < raw.length; count++) {
    let code = 0;
    let bytes = 0;
    if (!codespace) {
      code = raw.charCodeAt(i) * 256 + (raw.charCodeAt(i + 1) || 0);
      bytes = 2;
    } else {
      let value = 0;
      for (let n = 1; n <= 4 && i + n <= raw.length && !bytes; n++) {
        value = value * 256 + raw.charCodeAt(i + n - 1);
        const ranges = codespace[n];
        for (let k = 0; k < ranges.length; k += 2) {
          if (value >= ranges[k] && value <= ranges[k + 1]) {
            code = value;
            bytes = n;
            break;
          }
        }
      }
      if (!bytes) {
        // No range matches: the shortest code length, as readers do.
        bytes = font.shortest ?? 1;
        for (let n = 0; n < bytes; n++) code = code * 256 + (raw.charCodeAt(i + n) || 0);
      }
    }
    i += bytes;
    if (bytes === 1 && code === 32) spaces++;
    // The code's text, collected as UTF-16 code units (one flat string per run, instead of a concatenation per glyph).
    if (utf16) {
      if (bytes > 2) UNITS[units++] = code >>> 16;
      UNITS[units++] = code & 0xffff;
    } else {
      let t = texts ? (code < texts.length ? texts[code] : undefined) : map?.get(code);
      if (!t && glyph) t = glyph(code);
      if (t !== undefined) {
        if (t.length === 1) UNITS[units++] = t.charCodeAt(0);
        else for (let k = 0; k < t.length; k++) UNITS[units++] = t.charCodeAt(k);
      }
    }
    if (units >= STRING_CHUNK) {
      UNITS.length = units;
      text += String.fromCharCode.apply(null, UNITS);
      units = 0;
    }
    if (table !== undefined && code < table.length) {
      const w = table[code];
      width += w === w ? w : cidWidth(cid, code);
    } else width += cidWidth(cid, code);
  }
  if (units === 1) text += String.fromCharCode(UNITS[0]);
  else if (units) {
    UNITS.length = units;
    text += String.fromCharCode.apply(null, UNITS);
  }
  RUN.text = font.raw === "bytes" ? win1252(raw) : text;
  RUN.width = width;
  RUN.count = count;
  RUN.spaces = spaces;
  return RUN;
}

// ---------- PDF text layout ----------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n: first m, then n (PDF's row-vector convention). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function toMatrix(value: PdfValue | PdfStream | undefined): Matrix | undefined {
  return Array.isArray(value) && value.length === 6 && value.every((v) => typeof v === "number") ? (value as Matrix) : undefined;
}

/**
 * Collects a page's text runs as lines. A run starts a new line only when the baseline moves by
 * more than a fraction of the font size, and a blank line when it moves more than 1.5 line spacings
 * (a paragraph gap). Runs on the same line are joined directly when adjacent (Word writes each
 * formatting run separately), with a space after a gap, or with a tab after a wide gap (columns).
 * Where glyph widths are only guessed, a run placed further right on the line counts as a new word.
 */
class PdfTextWriter {
  private readonly parts: string[] = [];
  length = 0;
  private lastChar = "";
  /** The previous run on the page (when `hasLast`): its line (across), where it starts and ends along it, its direction and size. */
  private hasLast = false;
  private lastAcross = 0;
  private lastAlong = 0;
  private lastAlongEnd = 0;
  private lastDx = 0;
  private lastDy = 0;
  private lastSize = 0;
  private spacing?: number;
  /** A line break the content asked for explicitly (T* with no leading set). */
  breakLine = false;

  constructor(readonly limit: number) {}

  get full() {
    return this.length >= this.limit;
  }

  private add(s: string) {
    this.parts.push(s);
    this.length += s.length;
    this.lastChar = s[s.length - 1];
  }

  /**
   * Places `text`, drawn from (x0, y0) to (x1, y1) along the direction (dx, dy) at font size `size`.
   * `exact` says the end point comes from real glyph widths; `moved` that the run was positioned
   * by itself (Td, Tm, …) rather than following the previous one.
   */
  place(text: string, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number, size: number, exact: boolean, moved: boolean) {
    if (!text) return;
    const along = x0 * dx + y0 * dy;
    const across = y0 * dx - x0 * dy;
    if (this.hasLast) {
      const h = Math.max(size, this.lastSize, 1);
      const sameDirection = this.lastDx * dx + this.lastDy * dy > 0.99;
      const down = this.lastAcross - across;
      if (!sameDirection || Math.abs(down) > 0.4 * h || this.breakLine) {
        const spacing = this.spacing ?? 1.2 * h;
        const blank = sameDirection && Math.abs(down) > 1.5 * spacing;
        if (sameDirection && !blank && down >= 0.8 * h) this.spacing = Math.min(this.spacing ?? down, down);
        if (this.lastChar !== "\n") this.add(blank ? "\n\n" : "\n");
        else if (blank && !this.parts.at(-1)?.endsWith("\n\n")) this.add("\n");
      } else if (this.lastChar !== "\n" && !isSpaceChar(text.charCodeAt(0)) && !isSpaceChar(this.lastChar.charCodeAt(0))) {
        const gap = along - this.lastAlongEnd;
        if (gap > 2 * h) this.add("\t");
        else if (gap > 0.2 * h || gap < -3 * h || (!exact && moved && along > this.lastAlong + 0.5 * h)) this.add(" ");
      }
    }
    this.breakLine = false;
    this.add(text);
    this.hasLast = true;
    this.lastAcross = across;
    this.lastAlong = along;
    this.lastAlongEnd = x1 * dx + y1 * dy;
    this.lastDx = dx;
    this.lastDy = dy;
    this.lastSize = size;
  }

  /** Starts a new line (between separately read content, e.g. annotations after the page). */
  newline() {
    if (this.length && this.lastChar !== "\n") this.add("\n");
    this.hasLast = false;
  }

  text(): string {
    return tidyLines(this.parts.join(""));
  }
}

/** True for the characters JavaScript's \s matches (white space), by character code. */
function isSpaceChar(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** True for the bytes that end a PDF name or keyword: white space and the delimiters ( ) < > [ ] { } / %. */
function isPdfDelimiter(c: number): boolean {
  return c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
}

/** The end of an inline image's data. */
const INLINE_IMAGE_END = /\sEI(?=\s|$)/g;
/** Deepest q (save state) nesting and Form XObject nesting followed. */
const MAX_STATE_DEPTH = 64;
const MAX_FORM_DEPTH = 8;
/** Numeric operands kept for an operator (the last six matter); a power of two. */
const MAX_NUMBERS = 32;
/** Elements of an array operand (a TJ array) that are kept. */
const MAX_ARRAY_ELEMENTS = 65_536;

interface TextState {
  ctm: Matrix;
  font: PdfFont;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
  leading: number;
  rise: number;
}

/** What content streams need while being read: the file (for fonts and forms), output and guards. */
interface ContentContext {
  file?: PdfFile;
  writer: PdfTextWriter;
  budget: Budget;
  /** Forms already drawn on this page (each is read once per page), and forms being drawn (recursion). */
  formsOnPage: Set<number>;
  formsActive: Set<number>;
  /** Fonts already read, by object number (or the dictionary itself, for fonts written into the resources). */
  fonts: Map<number | PdfDict, PdfFont>;
}

/**
 * Reads the text a content stream draws (Tj, TJ, ', ") with its position, following the text and
 * transformation matrices, and the Form XObjects it draws with Do (at the point of use).
 *
 * This is the reader's hot loop (a dense page has tens of thousands of tokens), so it scans the
 * stream by character code without regular expressions or a token object, keeps the text matrices
 * as scalars that advance in place, and keeps operands in a few slots: the last numbers (a ring)
 * and the last string, name or array, which is all an operator reads.
 */
function runContent(s: string, ctx: ContentContext, resources: PdfDict | undefined, initial: TextState, formDepth = 0): void {
  const { writer, budget } = ctx;
  if (budget.partBytes <= 0) {
    budget.cut(FILE_TOO_LARGE);
    return;
  }
  budget.spend(s.length);
  if (budget.tokens <= 0) {
    budget.cut(PDF_TOO_COMPLEX);
    return;
  }
  let state: TextState = { ...initial };
  const saved: TextState[] = [];
  // The text matrix (a b c d e f) and the text line matrix: arrays, so the closures below share them without boxing each value.
  const tm = [1, 0, 0, 1, 0, 0];
  const tlm = [1, 0, 0, 1, 0, 0];
  let moved = true;
  const nums: number[] = [];
  let numCount = 0;
  let str: string | undefined;
  let name: string | undefined;
  /** The elements of the array being read (reused: the first `arrayLength` matter). */
  const array: (string | number)[] = [];
  let arrayLength = 0;
  let inArray = false;
  /** What the last operand was: 1 a number, 2 a string, 3 a name, 4 an array (0 none). */
  let lastKind = 0;
  /** The bytes of a hex string being read. */
  const bytes: number[] = [];
  /** The font the last Tf named (fonts are mostly set again and again). */
  let tfName: string | undefined;
  let tfFont = DEFAULT_FONT;
  const num = (i: number) => (i <= numCount ? nums[(numCount - i) & (MAX_NUMBERS - 1)] : 0);
  const moveLine = (tx: number, ty: number) => {
    tlm[4] = tx * tlm[0] + ty * tlm[2] + tlm[4];
    tlm[5] = tx * tlm[1] + ty * tlm[3] + tlm[5];
    for (let i = 0; i < 6; i++) tm[i] = tlm[i];
    moved = true;
  };
  const nextLine = () => {
    if (state.leading) moveLine(0, -state.leading);
    else writer.breakLine = true;
  };
  const show = (raw: string) => {
    const size = state.size || 12;
    const run = decodeRun(state.font, raw);
    const ctm = state.ctm;
    const ta = tm[0], tb = tm[1], tc = tm[2], td = tm[3]; // prettier-ignore
    let te = tm[4];
    let tf = tm[5];
    // The run's start in device space, and the text matrix's axes there (the text direction and the up direction).
    const x0 = te * ctm[0] + tf * ctm[2] + ctm[4];
    const y0 = te * ctm[1] + tf * ctm[3] + ctm[5];
    const ax = ta * ctm[0] + tb * ctm[2];
    const ay = ta * ctm[1] + tb * ctm[3];
    const ux = tc * ctm[0] + td * ctm[2];
    const uy = tc * ctm[1] + td * ctm[3];
    // The text position advances by the glyph widths plus character and word spacing, scaled horizontally.
    const advance = ((run.width / 1000) * size + run.count * state.charSpacing + run.spaces * state.wordSpacing) * state.scale;
    te = tm[4] = advance * ta + te;
    tf = tm[5] = advance * tb + tf;
    const x1 = te * ctm[0] + tf * ctm[2] + ctm[4];
    const y1 = te * ctm[1] + tf * ctm[3] + ctm[5];
    // Unrotated text (nearly always) needs no square roots: the axes' lengths are the magnitudes of their one component.
    const length = (ay === 0 ? Math.abs(ax) : Math.hypot(ax, ay)) || 1;
    const up = (ux === 0 ? Math.abs(uy) : Math.hypot(ux, uy)) || 1;
    writer.place(run.text, x0, y0, x1, y1, ax / length, ay / length, size * up, state.font.exact, moved);
    moved = false;
  };
  const n = s.length;
  let pos = 0;
  let nextGt = -1;
  let nextCr = -1;
  let tokens = budget.tokens;
  while (pos < n) {
    const c = s.charCodeAt(pos);
    if (c <= 32) {
      pos++;
      continue;
    }
    if (--tokens <= 0) {
      budget.tokens = 0;
      budget.cut(PDF_TOO_COMPLEX);
      return;
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      // A number: [+-]?digits[.digits] or [+-]?.digits; the digits over a power of ten round exactly as Number() does.
      let p = pos;
      let negative = false;
      if (c === 43) p++;
      else if (c === 45) {
        negative = true;
        p++;
      }
      let value = 0;
      let digits = 0;
      let scale = 1;
      let dot = false;
      for (; p < n; p++) {
        const d = s.charCodeAt(p);
        if (d >= 48 && d <= 57) {
          value = value * 10 + (d - 48);
          digits++;
          if (dot) scale *= 10;
        } else if (d === 46 && !dot) dot = true;
        else break;
      }
      if (!digits) {
        pos++; // a lone sign or dot
        continue;
      }
      const number = digits > 15 ? Number(s.slice(pos, p)) : negative ? -value / scale : value / scale;
      pos = p;
      if (inArray) {
        if (arrayLength < MAX_ARRAY_ELEMENTS) array[arrayLength++] = number;
      } else {
        nums[numCount & (MAX_NUMBERS - 1)] = number;
        numCount++;
        lastKind = 1;
      }
    } else if (c === 40 /* ( */) {
      const literal = readLiteral(s, pos);
      pos = literalEnd;
      if (inArray) {
        if (arrayLength < MAX_ARRAY_ELEMENTS) array[arrayLength++] = literal;
      } else {
        str = literal;
        lastKind = 2;
      }
    } else if (c === 47 /* / */) {
      let p = pos + 1;
      while (p < n && !isPdfDelimiter(s.charCodeAt(p))) p++;
      name = s.slice(pos + 1, p);
      lastKind = 3;
      pos = p;
    } else if (c === 60 /* < */) {
      if (s.charCodeAt(pos + 1) === 60) {
        pos += 2; // a dictionary (an inline image's or marked content's); its entries are skipped as operands
        continue;
      }
      // The next ">" is looked for once per stretch of the stream, so a million "<" without one don't cost a search each.
      if (nextGt <= pos) {
        const found = s.indexOf(">", pos + 1);
        nextGt = found < 0 ? n : found;
      }
      const end = nextGt;
      if (end >= n) {
        pos++;
        continue;
      }
      // A hex string: two digits per byte, white space allowed, an odd last digit padded with 0.
      let out = "";
      let count = 0;
      let p = pos + 1;
      // Pairs of digits, as long as they come without white space (nearly always).
      for (; p + 1 < end; p += 2) {
        const d1 = s.charCodeAt(p);
        const d2 = s.charCodeAt(p + 1);
        const v1 = d1 < 128 ? HEX_VALUE[d1] : -1;
        const v2 = d2 < 128 ? HEX_VALUE[d2] : -1;
        if (v1 < 0 || v2 < 0) break;
        bytes[count++] = v1 * 16 + v2;
        if (count === STRING_CHUNK) {
          bytes.length = count;
          out += String.fromCharCode.apply(null, bytes);
          count = 0;
        }
      }
      let high = -1;
      for (; p < end; p++) {
        const d = s.charCodeAt(p);
        const v = d < 128 ? HEX_VALUE[d] : -1;
        if (v < 0) continue;
        if (high < 0) high = v;
        else {
          bytes[count++] = high * 16 + v;
          high = -1;
        }
        if (count === STRING_CHUNK) {
          bytes.length = count;
          out += String.fromCharCode.apply(null, bytes);
          count = 0;
        }
      }
      if (high >= 0) bytes[count++] = high * 16;
      if (count) {
        bytes.length = count;
        out += String.fromCharCode.apply(null, bytes);
      }
      pos = end + 1;
      if (inArray) {
        if (arrayLength < MAX_ARRAY_ELEMENTS) array[arrayLength++] = out;
      } else {
        str = out;
        lastKind = 2;
      }
    } else if (c === 91 /* [ */) {
      arrayLength = 0;
      inArray = true;
      pos++;
    } else if (c === 93 /* ] */) {
      if (inArray) {
        inArray = false;
        lastKind = 4;
      }
      pos++;
    } else if (c === 37 /* % */) {
      // A comment runs to the end of its line.
      const lf = s.indexOf("\n", pos);
      if (nextCr <= pos) {
        const found = s.indexOf("\r", pos);
        nextCr = found < 0 ? n : found;
      }
      pos = Math.min(lf < 0 ? n : lf, nextCr);
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39 || c === 34 || c === 42) {
      let p = pos + 1;
      for (; p < n; p++) {
        const d = s.charCodeAt(p);
        if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 39 || d === 34 || d === 42)) break;
      }
      const op = s.slice(pos, p);
      pos = p;
      if (writer.full) {
        budget.tokens = tokens;
        return;
      }
      switch (op) {
        case "Tj":
          if (lastKind === 2 && str !== undefined) show(str);
          break;
        case "TJ":
          if (lastKind === 4) {
            for (let i = 0; i < arrayLength; i++) {
              const part = array[i];
              if (typeof part === "string") show(part);
              else {
                const adjust = (-part / 1000) * (state.size || 12) * state.scale;
                tm[4] = adjust * tm[0] + tm[4];
                tm[5] = adjust * tm[1] + tm[5];
              }
            }
          }
          break;
        case "Td":
          moveLine(num(2), num(1));
          break;
        case "TD":
          state.leading = -num(1);
          moveLine(num(2), num(1));
          break;
        case "Tm":
          for (let i = 0; i < 6; i++) tm[i] = tlm[i] = num(6 - i);
          moved = true;
          break;
        case "T*":
          nextLine();
          break;
        case "'":
          nextLine();
          if (lastKind === 2 && str !== undefined) show(str);
          break;
        case '"':
          state.wordSpacing = num(2);
          state.charSpacing = num(1);
          nextLine();
          if (lastKind === 2 && str !== undefined) show(str);
          break;
        case "Tf":
          state.size = num(1);
          if (name !== tfName) {
            tfName = name;
            tfFont = name !== undefined ? fontOf(ctx, resources, name) : DEFAULT_FONT;
          }
          state.font = tfFont;
          break;
        case "BT":
          for (let i = 0; i < 6; i++) tm[i] = tlm[i] = IDENTITY[i];
          moved = true;
          break;
        case "q":
          if (saved.length < MAX_STATE_DEPTH) saved.push({ ...state });
          break;
        case "Q":
          state = saved.pop() ?? state;
          break;
        case "cm":
          state.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], state.ctm);
          break;
        case "Tc":
          state.charSpacing = num(1);
          break;
        case "Tw":
          state.wordSpacing = num(1);
          break;
        case "Tz":
          state.scale = num(1) / 100;
          break;
        case "TL":
          state.leading = num(1);
          break;
        case "Ts":
          state.rise = num(1);
          break;
        case "ID": {
          // Inline image data can contain anything; skip to its "EI".
          INLINE_IMAGE_END.lastIndex = pos;
          const end = INLINE_IMAGE_END.exec(s);
          pos = end ? end.index + end[0].length : n;
          break;
        }
        case "Do":
          if (lastKind === 3 && name !== undefined) {
            budget.tokens = tokens;
            drawForm(name, ctx, resources, state, formDepth);
            tokens = budget.tokens;
          }
          break;
      }
      numCount = 0;
      str = undefined;
      name = undefined;
      lastKind = 0;
    } else pos++; // ) > { } and stray bytes
  }
  budget.tokens = tokens;
}

/** Reads a Form XObject drawn with Do, where it is drawn; each form once per page, never recursively. */
function drawForm(name: string, ctx: ContentContext, resources: PdfDict | undefined, state: TextState, depth: number) {
  const file = ctx.file;
  const ref = file?.dict(resources?.get("XObject"))?.get(name);
  if (!file || !(ref instanceof PdfRef) || depth >= MAX_FORM_DEPTH) return;
  if (ctx.formsOnPage.has(ref.num) || ctx.formsActive.has(ref.num)) return;
  const form = file.stream(ref);
  if (!form || nameOf(form.dict.get("Subtype")) !== "Form") return;
  ctx.formsOnPage.add(ref.num);
  const content = file.decode(form, ref.num);
  if (content === undefined) return;
  ctx.formsActive.add(ref.num);
  const matrix = toMatrix(file.get(form.dict.get("Matrix"))) ?? IDENTITY;
  runContent(content, ctx, file.dict(form.dict.get("Resources")) ?? resources, { ...state, ctm: multiply(matrix, state.ctm) }, depth + 1);
  ctx.formsActive.delete(ref.num);
}

const initialState = (): TextState => ({ ctm: IDENTITY, font: DEFAULT_FONT, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0 });

// ---------- PDF reading ----------

/** Characters of real text (letters, digits, punctuation, underscores of form lines, common symbols). */
const READABLE = /[\p{L}\p{N}.,;:'"!?()\-–—\/$%&@#*+=€£¥°§•…’“”_|<>[\]{}~^©®™±×÷]+/gu;
/** The ASCII characters sorted the same way, by code: 1 readable, 2 white space, 0 other. */
const ASCII_READABLE = Uint8Array.from({ length: 128 }, (_, c) => (isSpaceChar(c) ? 2 : new RegExp(READABLE.source, "u").test(String.fromCharCode(c)) ? 1 : 0));

/**
 * True when extracted text is mostly words, not the gibberish produced by fonts with custom
 * encodings: over 90% of its non-space characters are READABLE (and there are at least 20).
 * ASCII is counted by table; the rest goes through the regular expressions.
 */
function looksReadable(text: string): boolean {
  let readable = 0;
  let other = 0;
  let foreign = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      const kind = ASCII_READABLE[c];
      if (kind === 1) readable++;
      else if (kind === 0) other++;
    } else {
      const start = i;
      while (i + 1 < text.length && text.charCodeAt(i + 1) >= 128) i++;
      foreign += text.slice(start, i + 1);
    }
  }
  if (foreign) {
    const compact = foreign.replace(/\s+/g, "");
    const rest = compact.replace(READABLE, "").length;
    other += rest;
    readable += compact.length - rest;
  }
  const total = readable + other;
  return total >= 20 && readable / total > 0.9;
}

/** Streams that never hold page text: images, fonts, cross-reference and object streams, metadata, embedded files, color data. */
const NOT_TEXT_STREAM =
  /\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType|XML)\b|\/Type\s*\/(XRef|ObjStm|Metadata|EmbeddedFile|CMap)\b|\/(DCT|JPX|CCITTFax|JBIG2)Decode|\/Length[123]\b|\/(FunctionType|ShadingType)\b/;

/** How far before "stream" a stream's dictionary may start. */
const DICT_WINDOW = 4096;

/** Ends each line without trailing white space, keeps at most one blank line in a row, and trims the whole (one pass). */
function tidyLines(text: string): string {
  const parts: string[] = [];
  let newlines = 0;
  const n = text.length;
  for (let pos = 0; pos <= n; ) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = n;
    let stop = end;
    while (stop > pos && isSpaceChar(text.charCodeAt(stop - 1))) stop--;
    let start = pos;
    if (!parts.length) while (start < stop && isSpaceChar(text.charCodeAt(start))) start++;
    if (stop > start) {
      if (parts.length) parts.push(newlines > 1 ? "\n\n" : "\n");
      parts.push(start === 0 && stop === n ? text : text.slice(start, stop));
      newlines = 0;
    }
    newlines++;
    pos = end + 1;
  }
  return parts.join("");
}

/** Most page-tree nodes visited, and the deepest nesting followed. */
const MAX_PAGE_NODES = 20_000;
const MAX_TREE_DEPTH = 64;
/** Most annotations per page whose appearance (e.g. a filled-in form field) is read. */
const MAX_ANNOTATIONS = 500;

interface PdfPage {
  dict: PdfDict;
  resources?: PdfDict;
}

/**
 * The pages in reading order: Catalog → /Pages → /Kids, depth first, with /Resources inherited
 * from parent nodes. Finishes with "damaged" when the tree has missing or broken parts, and with
 * "too many" past MAX_PAGE_NODES nodes; repeated and cyclic nodes are skipped.
 */
function* pageTree(file: PdfFile): Generator<PdfPage, "complete" | "damaged" | "too many"> {
  const stack: { kids: PdfValue[]; next: number; resources?: PdfDict }[] = [{ kids: [file.root!.get("Pages") ?? null], next: 0 }];
  const visited = new Set<number>();
  let nodes = 0;
  while (stack.length) {
    const level = stack.at(-1)!;
    if (level.next >= level.kids.length) {
      stack.pop();
      continue;
    }
    const kid = level.kids[level.next++];
    if (!(kid instanceof PdfRef)) return "damaged";
    if (visited.has(kid.num)) continue;
    visited.add(kid.num);
    if (++nodes > MAX_PAGE_NODES) return "too many";
    const node = file.dict(kid);
    if (!node) return "damaged";
    const resources = file.dict(node.get("Resources")) ?? level.resources;
    const type = nameOf(node.get("Type"));
    if (type === "Pages" || (type !== "Page" && node.has("Kids"))) {
      const kids = file.array(node.get("Kids"));
      if (!kids || stack.length >= MAX_TREE_DEPTH) return "damaged";
      stack.push({ kids, next: 0, resources });
    } else if (type === "Page" || node.has("Contents")) yield { dict: node, resources };
    else return "damaged";
  }
  return "complete";
}

/** A page's content streams, decoded and joined; undefined when one is missing (a damaged file). */
function pageContent(file: PdfFile, page: PdfPage): string | undefined {
  const contents = page.dict.get("Contents");
  if (contents === undefined || contents === null) return "";
  const resolved = file.get(contents);
  const refs = isStream(resolved) ? [contents] : Array.isArray(resolved) ? resolved : undefined;
  if (!refs) return undefined;
  const parts: string[] = [];
  for (const ref of refs) {
    const stream = file.stream(ref);
    if (!stream) return undefined;
    // A stream that can't be decoded (another filter, or too large) is left out, not treated as damage; each is decoded once per file.
    parts.push(file.decode(stream, ref instanceof PdfRef ? ref.num : undefined) ?? "");
  }
  return parts.join("\n");
}

/** Text drawn by a page's annotations, such as filled-in form fields (their appearance streams). */
function readAnnotations(file: PdfFile, page: PdfPage, ctx: ContentContext) {
  const annotations = file.array(page.dict.get("Annots"))?.slice(0, MAX_ANNOTATIONS) ?? [];
  for (const ref of annotations) {
    const annotation = file.dict(ref);
    const flags = annotation?.get("F");
    if (!annotation || (typeof flags === "number" && flags & (2 | 32))) continue; // Hidden or NoView
    // Only a single appearance; per-state ones (check boxes, radio buttons) show no text.
    const appearanceRef = file.dict(annotation.get("AP"))?.get("N");
    const appearance = file.stream(appearanceRef);
    const rect = file.array(annotation.get("Rect"));
    if (!appearance || !rect || rect.length !== 4 || !rect.every((v) => typeof v === "number")) continue;
    const num = appearanceRef instanceof PdfRef ? appearanceRef.num : undefined;
    if (num !== undefined && ctx.formsOnPage.has(num)) continue;
    if (num !== undefined) ctx.formsOnPage.add(num);
    const content = file.decode(appearance, num);
    if (!content) continue;
    const bbox = file.array(appearance.dict.get("BBox"));
    const [bx, by] = bbox?.length === 4 && typeof bbox[0] === "number" && typeof bbox[1] === "number" ? [bbox[0], bbox[1]] : [0, 0];
    const matrix = toMatrix(file.get(appearance.dict.get("Matrix"))) ?? IDENTITY;
    const [x, y] = [Math.min(rect[0] as number, rect[2] as number), Math.min(rect[1] as number, rect[3] as number)];
    ctx.writer.newline();
    runContent(content, ctx, file.dict(appearance.dict.get("Resources")) ?? page.resources, {
      ...initialState(),
      ctm: multiply(matrix, [1, 0, 0, 1, x - bx, y - by]),
    });
  }
}

const pageMarker = (n: number) => `--- Page ${n} ---\n`;

/** Pages with their markers; runs of pages without text become one line ("--- Pages 4–9: no text ---"). */
function withPageMarkers(pages: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    if (pages[i]) {
      out.push(`${pageMarker(i + 1)}${pages[i]}`);
      i++;
      continue;
    }
    let j = i;
    while (j < pages.length && !pages[j]) j++;
    out.push(j - i === 1 ? `--- Page ${i + 1}: no text ---` : `--- Pages ${i + 1}–${j}: no text ---`);
    i = j;
  }
  return out.join("\n\n");
}

/**
 * Reads pages in the order of the page tree, separated by "--- Page N ---" when there are several
 * (the markers count toward the budget). Returns undefined when the tree can't be used, so the
 * caller reads the file in order instead.
 */
function readPageTree(file: PdfFile, budget: Budget): ReadResult | undefined {
  const tree = pageTree(file);
  const count = file.get(file.dict(file.root!.get("Pages"))?.get("Count"));
  const pages: string[] = [];
  const fonts = new Map<number | PdfDict, PdfFont>();
  let multi = typeof count === "number" && count > 1;
  let total = 0;
  let stopped = false;
  let step = tree.next();
  while (!step.done) {
    if (total >= budget.chars) {
      stopped = true;
      break;
    }
    const content = pageContent(file, step.value);
    if (content === undefined) return undefined;
    if (!content && !step.value.dict.has("Annots")) {
      pages.push(""); // nothing drawn: no text to place
      step = tree.next();
      continue;
    }
    if (pages.length === 1 && !multi) {
      multi = true;
      total += pageMarker(1).length;
    }
    const marker = multi ? pageMarker(pages.length + 1).length : 0;
    const writer = new PdfTextWriter(Math.max(1, budget.chars - total - marker));
    const ctx: ContentContext = { file, writer, budget, formsOnPage: new Set(), formsActive: new Set(), fonts };
    runContent(content, ctx, step.value.resources, initialState());
    if (!writer.full) readAnnotations(file, step.value, ctx);
    const text = writer.text();
    pages.push(text);
    if (text) total += marker + text.length + 2;
    if (writer.full) {
      stopped = true;
      break;
    }
    step = tree.next();
  }
  if (step.done && step.value === "damaged") return undefined;
  if (step.done && step.value === "too many") budget.cut("This PDF has too many pages to read here, so only the first ones are shown.");
  const plain = pages.filter(Boolean).join("\n\n");
  // No text at all on any page: read the file in order instead, in case it is drawn some other way.
  if (!plain) return undefined;
  if (!looksReadable(plain)) return { text: "" };
  return budget.result(multi || pages.length > 1 ? withPageMarkers(pages) : plain, stopped);
}

/** Reads every stream that looks like page content in file order: for PDFs whose page tree can't be used. */
function readInFileOrder(bytes: Uint8Array, budget: Budget): ReadResult | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  let total = 0;
  let stopped = false;
  let pos = 0;
  let previousEnd = 0;
  for (;;) {
    const at = buf.indexOf("stream", pos);
    if (at < 0) break;
    pos = at + 6;
    if (at >= 3 && latin1(buf.subarray(at - 3, at)) === "end") continue;
    let start = at + 6;
    if (buf[start] === 13) start++;
    if (buf[start] !== 10) continue;
    start++;
    const end = buf.indexOf("endstream", start);
    if (end < 0) break;
    // The stream's dictionary: from its "N 0 obj" (looking back a bounded distance) to "stream".
    const head = latin1(buf.subarray(Math.max(previousEnd, at - DICT_WINDOW), at));
    const dict = head.slice(Math.max(0, head.lastIndexOf("obj")));
    pos = previousEnd = end + 9;
    if (NOT_TEXT_STREAM.test(dict)) continue;
    if (total >= budget.chars) {
      stopped = true;
      break;
    }
    let data: Uint8Array = buf.subarray(start, end);
    if (data.at(-1) === 10) data = data.subarray(0, -1);
    if (data.at(-1) === 13) data = data.subarray(0, -1);
    if (/\/FlateDecode/.test(dict)) {
      if (budget.partBytes <= 0) {
        budget.cut(FILE_TOO_LARGE);
        break;
      }
      try {
        data = inflate(data, "deflate", budget.partBytes);
        budget.spend(data.length);
      } catch (err) {
        // A stream that unpacks to more than MAX_PART_BYTES is skipped (and noted); damaged ones just skipped.
        if (isOverLimit(err)) budget.cut(PDF_PART_TOO_LARGE);
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    const content = latin1(data);
    if (!/\bBT\b/.test(content) || !/T[jJ]|'|"/.test(content)) continue;
    const writer = new PdfTextWriter(budget.chars - total + 1);
    runContent(content, { writer, budget, formsOnPage: new Set(), formsActive: new Set(), fonts: new Map() }, undefined, initialState());
    const text = writer.text();
    if (text) {
      parts.push(text);
      total += text.length + 2;
    }
  }
  const text = tidyLines(parts.join("\n\n"));
  return looksReadable(text) ? budget.result(text, stopped || total > budget.chars) : undefined;
}

/**
 * Best-effort text extraction for PDFs with a text layer: fonts with standard encodings, and
 * embedded fonts with ToUnicode CMaps (most generated statements, receipts and letters), in
 * reading order: pages as the page tree orders them, lines from text positions, form XObjects
 * where they are drawn. Stops once `maxChars` are collected. Returns undefined when nothing
 * readable comes out, e.g. for scanned pages or fonts whose codes can't be mapped to characters.
 * PDFs whose page tree can't be used (encrypted, damaged) are read in file order.
 */
export async function readPdf(bytes: Uint8Array, opts: ReadOptions = {}): Promise<ReadResult | undefined> {
  const budget = new Budget(opts.maxChars);
  const file = PdfFile.open(bytes, budget);
  const fromTree = file && readPageTree(file, budget);
  if (fromTree) return fromTree.text ? fromTree : undefined;
  return readInFileOrder(bytes, new Budget(opts.maxChars));
}

/** The text of a PDF as one string (with a note when it is incomplete), or undefined if none is readable. */
export async function pdfText(bytes: Uint8Array, opts: ReadOptions = {}): Promise<string | undefined> {
  const result = await readPdf(bytes, opts);
  return result && withNote(result);
}
