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
import { decodeEntities, htmlToText } from "./mime.js";

export type AttachmentKind = "text" | "image" | "pdf" | "office" | "binary";

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-csv|ics|rtf|javascript|x-yaml|yaml|sql|x-sh))|\+(json|xml)$/i;
const TEXT_EXTENSIONS = /\.(txt|csv|tsv|json|xml|ics|vcf|md|log|ya?ml|html?|eml|rtf|sql|ini|cfg|conf)$/i;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Recognizes a file from its leading bytes when the declared type is generic or missing. */
export function sniffType(bytes: Uint8Array, mimeType: string, filename: string): string {
  const lower = mimeType.toLowerCase();
  if (lower && lower !== "application/octet-stream" && lower !== "binary/octet-stream") return lower;
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (head.startsWith("%PDF")) return "application/pdf";
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  const byExt: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
  };
  if (ext && byExt[ext]) return byExt[ext];
  return lower || "application/octet-stream";
}

export function kindOf(mimeType: string, filename: string): AttachmentKind {
  const type = mimeType.toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (/officedocument\.(wordprocessingml|spreadsheetml|presentationml)/.test(type)) return "office";
  if (TEXT_TYPES.test(type) || type === "message/rfc822" || TEXT_EXTENSIONS.test(filename)) return "text";
  return "binary";
}

/** Decodes text bytes, honoring a UTF-8/UTF-16 byte-order mark; HTML is converted to readable text. */
export function decodeTextFile(bytes: Uint8Array, mimeType: string, filename: string): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  else text = new TextDecoder("utf-8").decode(bytes);
  if (/html/i.test(mimeType) || /\.html?$/i.test(filename)) return htmlToText(text);
  return text.replace(/^﻿/, "");
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
  return Math.min(MAX_PART_BYTES, Math.max(1024 * 1024, chars * 40));
}

function xmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ""));
}

const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/**
 * Reads an entry's XML for `parse`, unpacking more of it while the text falls short of the budget.
 * Returns the parsed text and whether the entry was only partly read.
 */
function readGrowing(bytes: Uint8Array, entry: ZipEntry, budget: Budget, chars: number, parse: (xml: string) => string) {
  for (let want = firstReadBytes(chars); ; want *= 4) {
    const { xml, cut } = readEntry(bytes, entry, budget, want);
    const text = parse(xml);
    if (!cut || text.length >= chars || want >= MAX_PART_BYTES || budget.partBytes <= 0) {
      if (cut && text.length < chars) budget.cut(PART_TOO_LARGE);
      return text;
    }
  }
}

/** Extracts the text of a Word, Excel or PowerPoint (Office Open XML) file, stopping once `maxChars` are collected. */
export async function readOffice(bytes: Uint8Array, opts: ReadOptions = {}): Promise<ReadResult> {
  const budget = new Budget(opts.maxChars);
  const entries = zipEntries(bytes);
  const find = (name: string) => entries.find((e) => e.name === name);
  const read = (entry: ZipEntry) => readEntry(bytes, entry, budget).xml;

  const doc = find("word/document.xml");
  if (doc) {
    const text = readGrowing(bytes, doc, budget, budget.chars, (xml) =>
      xmlText(
        xml
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<w:br[^>]*\/>/g, "\n")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<\/w:tc>/g, "\t"),
      ).trim(),
    );
    return budget.result(text, text.length >= budget.chars);
  }

  const parts: string[] = [];
  let length = 0;
  const add = (part: string) => {
    parts.push(part);
    length += part.length + 2;
    return length >= budget.chars;
  };
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => byNumber(a.name, b.name));
  if (slides.length) {
    for (const [i, slide] of slides.entries()) {
      const text = `--- Slide ${i + 1} ---\n${xmlText(read(slide).replace(/<\/a:p>/g, "\n")).trim()}`;
      if (add(text)) return budget.result(parts.join("\n\n"), i < slides.length - 1);
    }
    return budget.result(parts.join("\n\n"), false);
  }

  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => byNumber(a.name, b.name));
  if (sheets.length) {
    const sharedEntry = find("xl/sharedStrings.xml");
    const shared = sharedEntry ? [...read(sharedEntry).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1])) : [];
    const workbookEntry = find("xl/workbook.xml");
    const names = workbookEntry
      ? [...read(workbookEntry).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]))
      : [];
    for (const [i, sheet] of sheets.entries()) {
      const text = readGrowing(bytes, sheet, budget, budget.chars - length, (xml) => {
        const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
          [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map(([, attrs, inner = ""]) => {
              const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
              const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
              if (type === "s" && value !== undefined) return shared[Number(value)] ?? "";
              if (type === "inlineStr") return xmlText(inner);
              return value !== undefined ? decodeEntities(value) : "";
            })
            .join("\t"),
        );
        return `--- Sheet: ${names[i] ?? i + 1} ---\n${rows.join("\n")}`;
      });
      if (add(text)) return budget.result(parts.join("\n\n"), true);
    }
    return budget.result(parts.join("\n\n"), false);
  }
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
