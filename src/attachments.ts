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
import { htmlToText } from "./mime.js";

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

/** Charsets that mean "UTF-8 if it is valid": senders often label Windows-1252 text as one of these. */
const UTF8_LIKE = new Set(["utf-8", "utf8", "us-ascii", "ascii", "unicode-1-1-utf-8"]);

/**
 * Decodes text bytes: a byte-order mark wins, then a declared charset (the attachment's Content-Type,
 * or an HTML <meta>), then UTF-8 if the bytes are valid UTF-8, else Windows-1252 (what Excel and
 * Windows programs write). `partial` says the bytes are cut off, so a split last character is fine.
 */
function decodeText(bytes: Uint8Array, declared: string | undefined, html: boolean, partial: boolean): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  let charset = declared?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!charset && html) {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
    charset = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  if (charset && !UTF8_LIKE.has(charset)) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown charset name: guess below.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
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
  return budget.result(text, partial || text.length > budget.chars);
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

/** Literal and hex PDF strings, decoded as Windows-1252 (PDF's common single-byte text encoding). */
const win1252Decoder = new TextDecoder("windows-1252");
const win1252 = {
  /** Plain ASCII needs no decoding, which skips a costly round trip for most strings. */
  decode: (bytes: Buffer) => (/[^\x00-\x7f]/.test(bytes.toString("latin1")) ? win1252Decoder.decode(bytes) : bytes.toString("latin1")),
};

const LITERAL_SPECIAL = /[\\()]/g;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/** Reads a (literal) string starting at `start` (the "("), returning its text and the index after ")". */
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
      return { value: win1252.decode(Buffer.from(out, "latin1")), end: next };
    } else out += ch;
    pos = next;
    LITERAL_SPECIAL.lastIndex = next;
  }
  return { value: win1252.decode(Buffer.from(out + s.slice(pos), "latin1")), end: s.length };
}

/** One token of a content stream: whitespace, comment, string start, array bracket, number, name or operator. */
const TOKEN = /\s+|%[^\r\n]*|\(|<<|>>|<[0-9A-Fa-f\s]*>|\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)|\/[^\s\/\[\]()<>{}%]*|[A-Za-z'"*]+|[^]/y;

/** Pulls the text drawn by a page content stream (Tj, TJ, ', " operators, with line breaks), up to about `limit` characters. */
function contentText(s: string, limit = Infinity): string {
  let out = "";
  const operands: (string | number | (string | number)[])[] = [];
  let array: (string | number)[] | undefined;
  const push = (v: string | number) => (array ? array.push(v) : operands.push(v));
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length && out.length < limit) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m) break;
    const tok = m[0];
    const c = tok.charCodeAt(0);
    if (tok === "(") {
      const lit = readLiteral(s, at);
      push(lit.value);
      TOKEN.lastIndex = lit.end;
    } else if (c === 60 /* < */ && tok !== "<<") {
      const hex = tok.slice(1, -1).replace(/\s+/g, "");
      push(win1252.decode(Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex")));
    } else if (tok === "[") array = [];
    else if (tok === "]") {
      if (array) operands.push(array);
      array = undefined;
    } else if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) push(Number(tok));
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39 || c === 34 || c === 42) {
      const op = tok;
      const last = operands[operands.length - 1];
      if (op === "Tj") {
        if (typeof last === "string") out += last;
      } else if (op === "TJ") {
        if (Array.isArray(last)) {
          for (const part of last) {
            if (typeof part === "string") out += part;
            else if (part < -180 && !out.endsWith(" ")) out += " ";
          }
        }
      } else if (op === "'" || op === '"') {
        newline();
        if (typeof last === "string") out += last;
      } else if (op === "T*" || op === "ET" || op === "Tm") newline();
      else if (op === "Td" || op === "TD") {
        const ty = operands[operands.length - 1];
        const tx = operands[operands.length - 2];
        if (typeof ty === "number" && Math.abs(ty) > 0.01) newline();
        else if (typeof tx === "number" && tx > 0 && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      }
      operands.length = 0;
    }
  }
  return out;
}

/** True when extracted text is mostly words, not the gibberish produced by fonts with custom encodings. */
function looksReadable(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 20) return false;
  const good = compact.match(/[\p{L}\p{N}.,;:'"!?()\-–—\/$%&@#*+=€£¥°§•…’“”_|<>[\]{}~^©®™±×÷]/gu)?.length ?? 0;
  return good / compact.length > 0.9;
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

/**
 * Best-effort text extraction for PDFs whose fonts use standard encodings (most generated
 * statements, receipts and letters), stopping once `maxChars` are collected. Returns undefined when
 * nothing readable comes out, e.g. for scanned pages or fonts with custom glyph encodings.
 */
export async function readPdf(bytes: Uint8Array, opts: ReadOptions = {}): Promise<ReadResult | undefined> {
  const budget = new Budget(opts.maxChars);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  let total = 0;
  let stopped = false;
  let pos = 0;
  let previousEnd = 0;
  for (;;) {
    const at = buf.indexOf("stream", pos, "latin1");
    if (at < 0) break;
    pos = at + 6;
    if (at >= 3 && buf.toString("latin1", at - 3, at) === "end") continue;
    let start = at + 6;
    if (buf[start] === 13) start++;
    if (buf[start] !== 10) continue;
    start++;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end < 0) break;
    // The stream's dictionary: from its "N 0 obj" (looking back a bounded distance) to "stream".
    const head = buf.toString("latin1", Math.max(previousEnd, at - DICT_WINDOW), at);
    const dict = head.slice(Math.max(0, head.lastIndexOf("obj")));
    pos = previousEnd = end + 9;
    if (NOT_TEXT_STREAM.test(dict)) continue;
    if (total >= budget.chars) {
      stopped = true;
      break;
    }
    let data: Buffer = buf.subarray(start, end);
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
        if (isOverLimit(err)) budget.cut(PART_TOO_LARGE);
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    const content = data.toString("latin1");
    if (!/\bBT\b/.test(content) || !/T[jJ]|'|"/.test(content)) continue;
    const text = contentText(content, budget.chars - total + 1).trim();
    if (text) {
      parts.push(text);
      total += text.length + 2;
    }
  }
  const text = tidyLines(parts.join("\n\n"));
  return looksReadable(text) ? budget.result(text, stopped || total > budget.chars) : undefined;
}

/** The text of a PDF as one string (with a note when it is incomplete), or undefined if none is readable. */
export async function pdfText(bytes: Uint8Array, opts: ReadOptions = {}): Promise<string | undefined> {
  const result = await readPdf(bytes, opts);
  return result && withNote(result);
}
