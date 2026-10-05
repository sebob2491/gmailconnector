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
  // A character takes at most 4 bytes; HTML markup can take many more bytes per character of text.
  const maxBytes = html ? budget.chars * 50 : budget.chars * 4 + 4;
  const partial = bytes.length > maxBytes;
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
/** Most bytes all parts of one file may unpack to together, which also bounds the CPU spent. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Large parts compressed more than this are decompression bombs; real documents stay far below it. */
const MAX_RATIO = 500;

const PART_TOO_LARGE = "Part of this file is too large to read here, so only its beginning is shown.";
const PDF_PART_TOO_LARGE = "Part of this PDF is too large to read here and was skipped.";
const FILE_TOO_LARGE = "This file is too large to read here in full, so only its beginning is shown.";
const TEXT_TOO_LONG = `The text is longer than ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters, so only the beginning is shown.`;

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
  if (entry.size > MAX_PART_BYTES && entry.size / Math.max(1, packed.length) > MAX_RATIO) {
    throw new FileTooLargeError(
      "This file unpacks to far more data than its size suggests (a damaged file or a decompression bomb), so it wasn't read.",
    );
  }
  if (entry.size <= limit) {
    try {
      return done(inflate(packed, "deflate-raw", limit), false);
    } catch (err) {
      if (!isOverLimit(err)) throw err;
      throw new FileTooLargeError("This file unpacks to more data than it declares (a damaged file or a decompression bomb), so it wasn't read.");
    }
  }
  // Inflate only the share of the compressed data that should unpack to `limit` bytes.
  let take = Math.max(1024, Math.floor(packed.length * (limit / entry.size) * 0.9));
  for (let attempt = 0; attempt < 3; attempt++, take = Math.floor(take / 4)) {
    try {
      return done(inflate(packed.subarray(0, take), "deflate-raw", limit), true);
    } catch (err) {
      if (!isOverLimit(err)) throw err;
    }
  }
  throw new FileTooLargeError("This file unpacks to far more data than its size suggests (a damaged file or a decompression bomb), so it wasn't read.");
}

/** How many bytes of XML to unpack first for `chars` characters of text (more is read when it falls short). */
function firstReadBytes(chars: number): number {
  return Math.min(MAX_PART_BYTES, Math.max(256 * 1024, chars * 16));
}

// ---------- XML ----------

const XML_ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|(amp|lt|gt|quot|apos));/g;
const XML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes XML's five named entities and numeric character references. */
function decodeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(XML_ENTITY, (match: string, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return XML_NAMED[name];
    const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

/** An element tag; `name` is the local name, without any namespace prefix (`x:row` and `row` are both "row"). */
interface XmlTag {
  name: string;
  close: boolean;
  empty: boolean;
  attrs: string;
}

/**
 * One tag. Attributes must start with white space or "/", and their quoted values may contain ">".
 * Every part starts with a different character, so a failed match never backtracks more than linearly.
 */
const XML_TAG = /<(\/?)([^\s/>!?<"'=]+)((?:[\s/](?:[^<>"']|"[^"]*"|'[^']*')*)?)>/y;

/**
 * Walks XML in one pass: `onTag` gets each element tag and `onText` each run of character data
 * (decoded). Either returns true to stop. Malformed markup ends the walk. Linear time.
 */
function walkXml(xml: string, onTag: (tag: XmlTag) => boolean | void, onText: (text: string) => boolean | void): void {
  const n = xml.length;
  let pos = 0;
  while (pos < n) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos && onText(decodeXml(xml.slice(pos, textEnd)))) return;
    if (lt < 0) return;
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
    const c = xml.charCodeAt(lt + 1);
    if (c === 33 /* <!DOCTYPE */ || c === 63 /* <?xml */) {
      const end = xml.indexOf(">", lt);
      if (end < 0) return;
      pos = end + 1;
      continue;
    }
    XML_TAG.lastIndex = lt;
    const m = XML_TAG.exec(xml);
    if (!m) return;
    const qname = m[2];
    if (onTag({ name: qname.slice(qname.indexOf(":") + 1), close: m[1] === "/", empty: m[3].endsWith("/"), attrs: m[3] })) return;
    pos = lt + m[0].length;
  }
}

const attrPatterns = new Map<string, RegExp>();

/** An attribute's decoded value, by local name (any namespace prefix, or none). */
function attr(attrs: string, name: string): string | undefined {
  let re = attrPatterns.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, re);
  }
  const m = re.exec(attrs);
  return m ? decodeXml(m[1] ?? m[2]) : undefined;
}

/** The relationship id (`r:id`) of an element; unlike `attr`, it needs a prefix, so a plain `id` doesn't match. */
function relId(attrs: string): string | undefined {
  const m = /(?:^|\s)[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  return m ? decodeXml(m[1] ?? m[2]) : undefined;
}

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
        if (tag.name !== "Relationship" || tag.close || attr(tag.attrs, "TargetMode") === "External") return;
        const id = attr(tag.attrs, "Id");
        const target = attr(tag.attrs, "Target");
        if (id && target) out.set(id, { target: resolvePath(folderOf(path), target), type: attr(tag.attrs, "Type") ?? "" });
      },
      () => {},
    );
    return out;
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

/** Sorts part names like "slide10.xml" after "slide2.xml". */
const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

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
  const put = (s: string) => {
    const cell = cells.at(-1);
    if (cell) cell.parts.push(s);
    else sink.add(s);
  };
  walkXml(
    xml,
    ({ name, close, empty, attrs }) => {
      if (name === "Fallback" || name === "del" || name === "moveFrom") {
        if (!empty) hidden += close ? -1 : 1;
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
          if (!close) rows.push([]);
          else put(`${(rows.pop() ?? []).join("\t").replace(/\t+$/, "")}\n`);
          break;
        case "tc":
          if (empty) break;
          if (!close) cells.push({ parts: [], span: 1 });
          else {
            const cell = cells.pop();
            const text = (cell?.parts.join("") ?? "").replace(/\s+/g, " ").trim();
            const row = rows.at(-1);
            if (row) row.push(text, ...Array<string>(Math.max(0, (cell?.span ?? 1) - 1)).fill(""));
            else put(text);
          }
          break;
        case "gridSpan": {
          const cell = cells.at(-1);
          if (cell) cell.span = Math.min(64, Math.max(1, Number(attr(attrs, "val")) || 1));
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

/** Built-in number formats that show dates or times (ids 27-36 and 50-58 are East Asian date formats). */
function builtinDateKind(id: number): DateKind | undefined {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 31) || id === 36 || (id >= 50 && id <= 54) || id === 57 || id === 58) return "date";
  if ((id >= 18 && id <= 21) || (id >= 32 && id <= 35) || id === 45 || id === 47 || id === 55 || id === 56) return "time";
  if (id === 22) return "datetime";
  if (id === 46) return "duration";
  return undefined;
}

/** Whether a custom number format shows a date, a time, both, or an elapsed duration ([h]:mm). */
function formatDateKind(code: string): DateKind | undefined {
  const f = code
    .split(";")[0]
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  if (/\[[hms]+\]/i.test(f)) return "duration";
  const date = /[yd]/i.test(f) || /m{3,}/i.test(f);
  const time = /[hs]/i.test(f) || /am\/pm|a\/p/i.test(f);
  return date && time ? "datetime" : date ? "date" : time ? "time" : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Shows an Excel serial date/time number as ISO-style text; returns undefined when it isn't a plausible date. */
function formatSerial(serial: number, kind: DateKind, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return undefined;
  const seconds = Math.round(serial * 86400);
  if (kind === "duration") {
    return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  }
  // Day 1 is 1900-01-01, and Excel counts a 1900-02-29 that never was (day 60).
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + seconds * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return kind === "date" ? date : kind === "time" ? time : `${date} ${time}`;
}

/** "C12" → 2 (zero-based column), or undefined. */
function columnIndex(ref: string | undefined): number | undefined {
  const letters = ref && /^[A-Za-z]{1,3}/.exec(ref)?.[0];
  if (!letters) return undefined;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Cells further right than this are put right after the previous cell instead of padding the row with tabs. */
const MAX_COLUMN_GAP = 200;
/** Up to this many missing rows become blank lines; longer gaps get one line saying so. */
const MAX_BLANK_ROWS = 10;

interface SheetContext {
  shared(index: number): string | undefined;
  dateKinds: (DateKind | undefined)[];
  date1904: boolean;
}

/** Cell text as Excel shows it (dates formatted, booleans as TRUE/FALSE), on one line. */
function cellText(type: string | undefined, value: string, inline: string, style: number, ctx: SheetContext): string {
  let text: string;
  if (type === "s") text = value.trim() === "" ? "" : (ctx.shared(Number(value)) ?? "");
  else if (type === "inlineStr") text = inline;
  else if (type === "b") text = value.trim() === "1" ? "TRUE" : value.trim() === "0" ? "FALSE" : value;
  else if (type === "str" || type === "e" || type === "d") text = value;
  else {
    const n = Number(value);
    const kind = ctx.dateKinds[style];
    text = value.trim() === "" || Number.isNaN(n) ? value : ((kind && formatSerial(n, kind, ctx.date1904)) ?? String(Number(n.toPrecision(15))));
  }
  return text.replace(/[\t\r\n]+/g, " ");
}

/** A worksheet as tab-separated rows, each cell in its column (Excel leaves empty cells out of the file). */
function sheetText(xml: string, limit: number, ctx: SheetContext): Parsed {
  const sink = new TextSink(limit);
  let lastRow = 0;
  let row = 0;
  let cells: string[] = [];
  let nextColumn = 0;
  let cell: { column: number; type?: string; style: number; value: string; inline: string[] } | undefined;
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  const flushRow = () => {
    const gap = row - lastRow - 1;
    if (gap > MAX_BLANK_ROWS) sink.add(`(rows ${lastRow + 1}–${row - 1} are empty)\n`);
    else if (gap > 0) sink.add("\n".repeat(gap));
    sink.add(`${Array.from(cells, (c) => c ?? "").join("\t").replace(/\t+$/, "")}\n`);
    lastRow = row;
  };
  walkXml(
    xml,
    ({ name, close, empty, attrs }) => {
      switch (name) {
        case "row":
          if (close) flushRow();
          else {
            row = Number(attr(attrs, "r")) || row + 1;
            cells = [];
            nextColumn = 0;
            if (empty) flushRow();
          }
          break;
        case "c":
          if (close) {
            if (cell) {
              cells[cell.column] = cellText(cell.type, cell.value, cell.inline.join(""), cell.style, ctx);
              nextColumn = cell.column + 1;
            }
            cell = undefined;
          } else {
            const column = columnIndex(attr(attrs, "r"));
            const at = column !== undefined && column >= nextColumn && column - nextColumn <= MAX_COLUMN_GAP ? column : nextColumn;
            if (empty) nextColumn = at + 1;
            else cell = { column: at, type: attr(attrs, "t"), style: Number(attr(attrs, "s") ?? 0), value: "", inline: [] };
          }
          break;
        case "v":
          inValue = !close && !empty;
          break;
        case "is":
          inInline = !close && !empty;
          break;
        case "t":
          inText = !close && !empty;
          break;
        case "rPh":
          if (!empty) phonetic += close ? -1 : 1;
          break;
      }
      return sink.full;
    },
    (text) => {
      if (!cell) return;
      if (inValue) cell.value += text;
      else if (inInline && inText && !phonetic) cell.inline.push(text);
    },
  );
  return { text: sink.parts.join("").replace(/\n+$/, ""), full: sink.full };
}

/** The shared strings table, without phonetic guides (<rPh>, e.g. Japanese furigana). */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  let inText = false;
  let phonetic = 0;
  walkXml(
    xml,
    ({ name, close, empty }) => {
      if (name === "si") {
        if (empty) out.push("");
        else if (close) {
          out.push(current?.join("") ?? "");
          current = undefined;
        } else current = [];
      } else if (name === "t") inText = !close && !empty;
      else if (name === "rPh" && !empty) phonetic += close ? -1 : 1;
    },
    (text) => {
      if (current && inText && !phonetic) current.push(text);
    },
  );
  return out;
}

/** Which cell styles (by index) show dates or times. */
function dateStyles(xml: string): (DateKind | undefined)[] {
  const custom = new Map<number, DateKind | undefined>();
  const kinds: (DateKind | undefined)[] = [];
  let inCellXfs = false;
  walkXml(
    xml,
    ({ name, close, empty, attrs }) => {
      if (name === "numFmt" && !close) custom.set(Number(attr(attrs, "numFmtId")), formatDateKind(attr(attrs, "formatCode") ?? ""));
      else if (name === "cellXfs" && !empty) inCellXfs = !close;
      else if (name === "xf" && inCellXfs && !close) {
        const id = Number(attr(attrs, "numFmtId") ?? 0);
        kinds.push(custom.has(id) ? custom.get(id) : builtinDateKind(id));
      }
    },
    () => {},
  );
  return kinds;
}

function readWorkbook(pkg: Package, workbookPath: string): ReadResult {
  const { budget } = pkg;
  const rels = pkg.rels(workbookPath);
  const relOfType = (type: string) => [...rels.values()].find((r) => r.type.endsWith(`/${type}`))?.target;
  const listed: { name: string; rel?: { target: string; type: string } }[] = [];
  let date1904 = false;
  walkXml(
    pkg.read(workbookPath)?.xml ?? "",
    ({ name, close, attrs }) => {
      if (close) return;
      if (name === "workbookPr") date1904 = /^(1|true)$/i.test(attr(attrs, "date1904") ?? "");
      if (name !== "sheet") return;
      const state = attr(attrs, "state");
      const label = `${attr(attrs, "name") ?? listed.length + 1}${state && state !== "visible" ? " (hidden)" : ""}`;
      listed.push({ name: label, rel: rels.get(relId(attrs) ?? "") });
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
  let shared: string[] = [];
  let sharedWant = 128 * 1024;
  let sharedCut = true;
  const loadShared = () => {
    const part = pkg.read(sharedPath, (sharedWant *= 2));
    shared = part ? sharedStrings(part.xml) : [];
    sharedCut = Boolean(part?.cut);
  };
  const stylesXml = pkg.read(relOfType("styles") ?? "xl/styles.xml")?.xml;
  const ctx: SheetContext = {
    shared(index) {
      // The table is read only as far as needed; read more of it when a cell points further.
      while (index >= shared.length && sharedCut && sharedWant < MAX_PART_BYTES && budget.partBytes > 0) loadShared();
      if (index >= shared.length && sharedCut) budget.cut(PART_TOO_LARGE);
      return shared[index];
    },
    dateKinds: stylesXml ? dateStyles(stylesXml) : [],
    date1904,
  };
  loadShared();

  const parts: string[] = [];
  let length = 0;
  for (const [i, sheet] of sheets.entries()) {
    const { text, full } = pkg.parseGrowing(sheet.path, budget.chars - length, (xml, max) => sheetText(xml, max, ctx));
    const part = `--- Sheet: ${sheet.name} ---\n${text}`;
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
    ({ name, close, attrs }) => {
      const rel = name === "sldId" && !close ? rels.get(relId(attrs) ?? "") : undefined;
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
  return /[^\x00-\x7f]/.test(raw) ? win1252Decoder.decode(Buffer.from(raw, "latin1")) : raw;
}

const LITERAL_SPECIAL = /[\\()]/g;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/** Reads a literal string starting at `start` (the "("): its bytes (one per character) and the index after ")". */
function readLiteral(s: string, start: number): { value: string; end: number } {
  let depth = 1;
  let out = "";
  let pos = start + 1;
  LITERAL_SPECIAL.lastIndex = pos;
  for (let m = LITERAL_SPECIAL.exec(s); m; m = LITERAL_SPECIAL.exec(s)) {
    out += s.slice(pos, m.index);
    const ch = m[0];
    let next = m.index + 1;
    if (ch === "\\") {
      const e = s[next];
      if (e in ESCAPES) {
        out += ESCAPES[e];
        next++;
      } else if (e >= "0" && e <= "7") {
        let oct = "";
        while (oct.length < 3 && s[next] >= "0" && s[next] <= "7") oct += s[next++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else if (e === "\r") next += s[next + 1] === "\n" ? 2 : 1; // line continuation
      else if (e === "\n") next++;
      else if (e !== undefined) {
        out += e;
        next++;
      }
    } else if (ch === "(") {
      depth++;
      out += ch;
    } else if (--depth === 0) {
      return { value: out, end: next };
    } else out += ch;
    pos = next;
    LITERAL_SPECIAL.lastIndex = next;
  }
  return { value: out + s.slice(pos), end: s.length };
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

const pdfName = (raw: string) => (raw.includes("#") ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw);

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
    p.pos = literal.end;
    return new PdfString(literal.value);
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

/** Most objects a PDF may have for its page tree to be used (larger ones are read in file order). */
const MAX_PDF_OBJECTS = 200_000;
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
class PdfFile {
  /** Object number → offset just after its "obj" keyword. */
  private readonly top = new Map<number, number>();
  /** Objects packed in object streams: number → the stream's object number and its index there. */
  private readonly packed = new Map<number, { stream: number; index: number }>();
  private readonly objectStreams = new Map<number, { text: string; first: number; offsets: number[] }>();
  private readonly cache = new Map<number, PdfValue | PdfStream | null>();
  private readonly decoded = new Map<number, string | null>();
  private resolving = 0;
  root?: PdfDict;

  private constructor(
    readonly buf: PdfBytes,
    readonly budget: Budget,
  ) {}

  /** Indexes a PDF's objects; undefined when its page tree can't be used (no trailer, encrypted, too big). */
  static open(bytes: Uint8Array, budget: Budget): PdfFile | undefined {
    const buf = bufferOf(bytes);
    const file = new PdfFile(buf, budget);
    const objectStreams: { num: number; at: number }[] = [];
    let trailer: { at: number; dict: PdfDict } | undefined;
    let pos = 0;
    for (;;) {
      const at = buf.indexOf("obj", pos);
      if (at < 0) break;
      pos = at + 3;
      if (at >= 3 && buf[at - 1] === 0x64 && buf[at - 2] === 0x6e && buf[at - 3] === 0x65) continue; // endobj
      if (isRegularByte(buf[at + 3])) continue;
      const num = headerNumber(buf, at);
      if (num === undefined) continue;
      if (file.top.size >= MAX_PDF_OBJECTS && !file.top.has(num)) return undefined;
      file.top.set(num, pos);
      // A stream's data can hold anything (even "1 0 obj"), so continue after it.
      const body = file.bodyOf(pos);
      if (body.streamAt >= 0) {
        const dict = parsePdfValue(latin1(buf.subarray(pos, body.streamAt)), { pos: 0 });
        if (isDict(dict)) {
          const type = nameOf(dict.get("Type"));
          if (type === "ObjStm") objectStreams.push({ num, at });
          if (type === "XRef" && (!trailer || at > trailer.at)) trailer = { at, dict };
        }
        const end = buf.indexOf("endstream", body.streamAt + 6);
        pos = end < 0 ? buf.length : end + 9;
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

  /** Where an object's body ends ("endobj"), and where its "stream" keyword is (-1 if it has none). */
  private bodyOf(pos: number): { end: number; streamAt: number } {
    const endobj = this.buf.indexOf("endobj", pos);
    const end = endobj < 0 ? Math.min(this.buf.length, pos + MAX_OBJECT_BYTES) : endobj;
    const stream = this.buf.subarray(pos, Math.min(end, pos + MAX_OBJECT_BYTES)).indexOf("stream", 0);
    return { end, streamAt: stream < 0 ? -1 : pos + stream };
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
      if ((this.top.get(member) ?? -1) < at) this.packed.set(member, { stream: num, index: i });
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
      const at = this.top.get(num);
      if (member) {
        const holder = this.objectStreams.get(member.stream)!;
        const start = holder.first + holder.offsets[member.index];
        const end = member.index + 1 < holder.offsets.length ? holder.first + holder.offsets[member.index + 1] : holder.text.length;
        result = parsePdfValue(holder.text.slice(start, end), { pos: 0 });
      } else if (at !== undefined) {
        const body = this.bodyOf(at);
        const value = parsePdfValue(latin1(this.buf.subarray(at, body.streamAt >= 0 ? body.streamAt : Math.min(body.end, at + MAX_OBJECT_BYTES))), { pos: 0 });
        result = body.streamAt >= 0 && isDict(value) ? this.streamAt(value, body.streamAt) : value;
      }
    } finally {
      this.resolving--;
    }
    this.cache.set(num, result ?? null);
    return result;
  }

  private streamAt(dict: PdfDict, keyword: number): PdfStream {
    let start = keyword + 6;
    if (this.buf[start] === 13) start++;
    if (this.buf[start] === 10) start++;
    const length = this.get(dict.get("Length"));
    let end = typeof length === "number" && length >= 0 ? start + length : -1;
    // Trust /Length only when "endstream" follows it.
    if (end < 0 || end > this.buf.length || !latin1(this.buf.subarray(end, end + 32)).includes("endstream")) {
      const found = this.buf.indexOf("endstream", start);
      end = found < 0 ? this.buf.length : found;
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
   * A stream's decoded content (one character per byte), within the file's unpacking budget;
   * undefined for filters other than Flate, damaged data or a stream too large to unpack.
   */
  decode(stream: PdfStream, num?: number): string | undefined {
    if (num !== undefined && this.decoded.has(num)) return this.decoded.get(num) ?? undefined;
    const filters = [this.get(stream.dict.get("Filter"))].flat().map((f) => nameOf(f as PdfValue));
    let data: Uint8Array = this.buf.subarray(stream.start, stream.end);
    let result: string | undefined;
    if (filters.every((f) => f === undefined || f === "FlateDecode" || f === "Fl") && filters.length <= 2) {
      try {
        for (const filter of filters) {
          if (!filter) continue;
          if (this.budget.partBytes <= 0) throw new RangeError("budget");
          data = inflate(data, "deflate", this.budget.partBytes);
          this.budget.spend(data.length);
        }
        result = latin1(data);
      } catch (err) {
        if (isOverLimit(err)) this.budget.cut(this.budget.partBytes <= 0 ? FILE_TOO_LARGE : PDF_PART_TOO_LARGE);
      }
    }
    if (num !== undefined) this.decoded.set(num, result ?? null);
    return result;
  }
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

/** What text placement needs from a font: glyph widths (in 1/1000 em) and whether codes are two bytes. */
interface FontMetrics {
  first: number;
  widths: number[];
  missing: number;
  twoByte: boolean;
  /** False when widths are guessed (fonts without /Widths, e.g. the standard 14), so run ends are estimates. */
  exact: boolean;
}

const DEFAULT_FONT: FontMetrics = { first: 0, widths: [], missing: 500, twoByte: false, exact: false };

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
  private last?: { across: number; along: number; alongEnd: number; dx: number; dy: number; size: number };
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
    const last = this.last;
    if (last) {
      const h = Math.max(size, last.size, 1);
      const sameDirection = last.dx * dx + last.dy * dy > 0.99;
      const down = last.across - across;
      if (!sameDirection || Math.abs(down) > 0.4 * h || this.breakLine) {
        const spacing = this.spacing ?? 1.2 * h;
        const blank = sameDirection && Math.abs(down) > 1.5 * spacing;
        if (sameDirection && !blank && down >= 0.8 * h) this.spacing = Math.min(this.spacing ?? down, down);
        if (this.lastChar !== "\n") this.add(blank ? "\n\n" : "\n");
        else if (blank && !this.parts.at(-1)?.endsWith("\n\n")) this.add("\n");
      } else if (this.lastChar !== "\n" && !/^\s/.test(text) && !/\s/.test(this.lastChar)) {
        const gap = along - last.alongEnd;
        if (gap > 2 * h) this.add("\t");
        else if (gap > 0.2 * h || gap < -3 * h || (!exact && moved && along > last.along + 0.5 * h)) this.add(" ");
      }
    }
    this.breakLine = false;
    this.add(text);
    this.last = { across, along, alongEnd: x1 * dx + y1 * dy, dx, dy, size };
  }

  /** Starts a new line (between separately read content, e.g. annotations after the page). */
  newline() {
    if (this.length && this.lastChar !== "\n") this.add("\n");
    this.last = undefined;
  }

  text(): string {
    return tidyLines(this.parts.join(""));
  }
}

/** One token of a content stream: whitespace, comment, string start, array bracket, number, name or operator. */
const TOKEN = /\s+|%[^\r\n]*|\(|<<|>>|<[0-9A-Fa-f\s]*>|\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)|\/[^\s\/\[\]()<>{}%]*|[A-Za-z'"*]+|[^]/y;
/** The end of an inline image's data. */
const INLINE_IMAGE_END = /\sEI(?=\s|$)/g;
/** Deepest q (save state) nesting and Form XObject nesting followed. */
const MAX_STATE_DEPTH = 64;
const MAX_FORM_DEPTH = 8;

interface TextState {
  ctm: Matrix;
  font: FontMetrics;
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
  fonts: Map<PdfDict, FontMetrics>;
}

function fontMetrics(ctx: ContentContext, resources: PdfDict | undefined, name: string): FontMetrics {
  const file = ctx.file;
  const font = file?.dict(file.dict(resources?.get("Font"))?.get(name));
  if (!file || !font) return DEFAULT_FONT;
  let metrics = ctx.fonts.get(font);
  if (!metrics) {
    const widths = file.array(font.get("Widths"))?.map((w) => (typeof w === "number" ? w : 0)) ?? [];
    const first = font.get("FirstChar");
    const missing = file.dict(font.get("FontDescriptor"))?.get("MissingWidth");
    metrics = {
      first: typeof first === "number" ? first : 0,
      widths,
      missing: typeof missing === "number" && missing > 0 ? missing : widths.length ? 0 : 500,
      twoByte: nameOf(font.get("Subtype")) === "Type0",
      exact: widths.length > 0,
    };
    ctx.fonts.set(font, metrics);
  }
  return metrics;
}

/** How far a string advances the text position, in text space units (glyph widths plus character and word spacing). */
function advanceOf(state: TextState, raw: string): number {
  const { font } = state;
  const size = state.size || 12;
  let width = 0;
  let spaces = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 32) spaces++;
    if (font.twoByte) continue;
    const w = font.widths[code - font.first];
    width += w === undefined || w <= 0 ? (code === 32 ? 250 : font.missing || 500) : w;
  }
  if (font.twoByte) width = (raw.length / 2) * 1000;
  return ((width / 1000) * size + raw.length * state.charSpacing + spaces * state.wordSpacing) * state.scale;
}

/**
 * Reads the text a content stream draws (Tj, TJ, ', ") with its position, following the text and
 * transformation matrices, and the Form XObjects it draws with Do (at the point of use).
 */
function runContent(s: string, ctx: ContentContext, resources: PdfDict | undefined, initial: TextState, formDepth = 0): void {
  const { writer, budget } = ctx;
  if (budget.partBytes <= 0) {
    budget.cut(FILE_TOO_LARGE);
    return;
  }
  budget.spend(s.length);
  let state: TextState = { ...initial };
  const saved: TextState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let moved = true;
  const operands: (string | number | PdfName | (string | number)[])[] = [];
  let array: (string | number)[] | undefined;
  const push = (v: string | number) => (array ? array.push(v) : operands.push(v));
  const num = (i: number) => {
    const v = operands[operands.length - i];
    return typeof v === "number" ? v : 0;
  };
  const moveLine = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    moved = true;
  };
  const nextLine = () => {
    if (state.leading) moveLine(0, -state.leading);
    else writer.breakLine = true;
  };
  const show = (raw: string) => {
    const size = state.size || 12;
    const m = multiply(tm, state.ctm);
    tm = multiply([1, 0, 0, 1, advanceOf(state, raw), 0], tm);
    const end = multiply(tm, state.ctm);
    const length = Math.hypot(m[0], m[1]) || 1;
    writer.place(win1252(raw), m[4], m[5], end[4], end[5], m[0] / length, m[1] / length, size * (Math.hypot(m[2], m[3]) || 1), state.font.exact, moved);
    moved = false;
  };
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length && !writer.full) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m) break;
    const tok = m[0];
    const c = tok.charCodeAt(0);
    if (tok === "(") {
      const literal = readLiteral(s, at);
      push(literal.value);
      TOKEN.lastIndex = literal.end;
    } else if (c === 60 /* < */ && tok !== "<<") push(hexBytes(tok.slice(1, -1)));
    else if (tok === "[") array = [];
    else if (tok === "]") {
      if (array) operands.push(array);
      array = undefined;
    } else if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) push(Number(tok));
    else if (c === 47 /* / */) operands.push(new PdfName(tok.slice(1)));
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39 || c === 34 || c === 42) {
      const last = operands[operands.length - 1];
      switch (tok) {
        case "q":
          if (saved.length < MAX_STATE_DEPTH) saved.push({ ...state });
          break;
        case "Q":
          state = saved.pop() ?? state;
          break;
        case "cm":
          state.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], state.ctm);
          break;
        case "BT":
          tm = tlm = IDENTITY;
          moved = true;
          break;
        case "Tf": {
          const font = operands[operands.length - 2];
          state.size = num(1);
          state.font = font instanceof PdfName ? fontMetrics(ctx, resources, font.name) : DEFAULT_FONT;
          break;
        }
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
        case "Td":
          moveLine(num(2), num(1));
          break;
        case "TD":
          state.leading = -num(1);
          moveLine(num(2), num(1));
          break;
        case "Tm":
          tm = tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
          moved = true;
          break;
        case "T*":
          nextLine();
          break;
        case "Tj":
          if (typeof last === "string") show(last);
          break;
        case "'":
          nextLine();
          if (typeof last === "string") show(last);
          break;
        case '"':
          state.wordSpacing = num(3);
          state.charSpacing = num(2);
          nextLine();
          if (typeof last === "string") show(last);
          break;
        case "TJ":
          if (Array.isArray(last)) {
            for (const part of last) {
              if (typeof part === "string") show(part);
              else tm = multiply([1, 0, 0, 1, (-part / 1000) * (state.size || 12) * state.scale, 0], tm);
            }
          }
          break;
        case "ID": {
          // Inline image data can contain anything; skip to its "EI".
          INLINE_IMAGE_END.lastIndex = TOKEN.lastIndex;
          const end = INLINE_IMAGE_END.exec(s);
          TOKEN.lastIndex = end ? end.index + end[0].length : s.length;
          break;
        }
        case "Do":
          if (last instanceof PdfName) drawForm(last.name, ctx, resources, state, formDepth);
          break;
      }
      operands.length = 0;
    }
  }
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

/** True when extracted text is mostly words, not the gibberish produced by fonts with custom encodings. */
function looksReadable(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 20) return false;
  const other = compact.replace(READABLE, "").length;
  return (compact.length - other) / compact.length > 0.9;
}

/** Streams that never hold page text: images, fonts, cross-reference and object streams, metadata, embedded files, color data. */
const NOT_TEXT_STREAM =
  /\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType|XML)\b|\/Type\s*\/(XRef|ObjStm|Metadata|EmbeddedFile|CMap)\b|\/(DCT|JPX|CCITTFax|JBIG2)Decode|\/Length[123]\b|\/(FunctionType|ShadingType)\b/;

/** How far before "stream" a stream's dictionary may start. */
const DICT_WINDOW = 4096;

/** Ends each line without trailing spaces and keeps at most one blank line in a row (linear time). */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    // A stream that can't be decoded (another filter, or too large) is left out, not treated as damage.
    parts.push(file.decode(stream) ?? "");
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
  const fonts = new Map<PdfDict, FontMetrics>();
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
 * Best-effort text extraction for PDFs whose fonts use standard encodings (most generated
 * statements, receipts and letters), in reading order: pages as the page tree orders them, lines
 * from text positions, form XObjects where they are drawn. Stops once `maxChars` are collected.
 * Returns undefined when nothing readable comes out, e.g. for scanned pages or fonts with custom
 * glyph encodings. PDFs whose page tree can't be used (encrypted, damaged) are read in file order.
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
