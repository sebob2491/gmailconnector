/**
 * Turns attachment bytes into something Claude can read: text for documents (including Word,
 * Excel, PowerPoint and many PDFs), or an image. Runs in Node and Cloudflare Workers (node:zlib is
 * available there via nodejs_compat; it is ~25x cheaper than DecompressionStream for many small streams).
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

// ---------- decompression ----------

function inflate(data: Uint8Array, format: "deflate" | "deflate-raw"): Uint8Array {
  // finishFlush tolerates streams with trailing bytes or a missing end marker, common in PDFs.
  const opts = { finishFlush: 2 /* Z_SYNC_FLUSH */ };
  return format === "deflate" ? inflateSync(data, opts) : inflateRawSync(data, opts);
}

// ---------- ZIP (the container format of .docx/.xlsx/.pptx) ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
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
      localOffset: view.getUint32(pos + 42, true),
      name: new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength)),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipRead(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  const raw = entry.method === 8 ? inflate(data, "deflate-raw") : data;
  return new TextDecoder().decode(raw);
}

function xmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ""));
}

const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/** Extracts the text of a Word, Excel or PowerPoint (Office Open XML) file. */
export async function officeText(bytes: Uint8Array): Promise<string> {
  const entries = zipEntries(bytes);
  const find = (name: string) => entries.find((e) => e.name === name);
  const read = (entry: ZipEntry) => zipRead(bytes, entry);

  const doc = find("word/document.xml");
  if (doc) {
    const xml = await read(doc);
    return xmlText(
      xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<\/w:tc>/g, "\t"),
    ).trim();
  }

  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => byNumber(a.name, b.name));
  if (slides.length) {
    const parts: string[] = [];
    for (const [i, slide] of slides.entries()) {
      const xml = await read(slide);
      parts.push(`--- Slide ${i + 1} ---\n${xmlText(xml.replace(/<\/a:p>/g, "\n")).trim()}`);
    }
    return parts.join("\n\n");
  }

  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => byNumber(a.name, b.name));
  if (sheets.length) {
    const sharedEntry = find("xl/sharedStrings.xml");
    const shared = sharedEntry
      ? [...(await read(sharedEntry)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]))
      : [];
    const workbookEntry = find("xl/workbook.xml");
    const names = workbookEntry
      ? [...(await read(workbookEntry)).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]))
      : [];
    const parts: string[] = [];
    for (const [i, sheet] of sheets.entries()) {
      const xml = await read(sheet);
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
      parts.push(`--- Sheet: ${names[i] ?? i + 1} ---\n${rows.join("\n")}`);
    }
    return parts.join("\n\n");
  }
  throw new Error("not a Word, Excel or PowerPoint file");
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

/** Pulls the text drawn by a page content stream (Tj, TJ, ', " operators, with line breaks). */
function contentText(s: string): string {
  let out = "";
  const operands: (string | number | (string | number)[])[] = [];
  let array: (string | number)[] | undefined;
  const push = (v: string | number) => (array ? array.push(v) : operands.push(v));
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
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
  const good = compact.match(/[\p{L}\p{N}.,;:'"!?()\-–—\/$%&@#*+=€£¥°§•…’“”]/gu)?.length ?? 0;
  return good / compact.length > 0.9;
}

const PDF_SCAN_LIMIT = 4 * 1024 * 1024;
const PDF_TEXT_LIMIT = 200_000;

/**
 * Best-effort text extraction for PDFs whose fonts use standard encodings (most generated
 * statements, receipts and letters). Returns undefined when nothing readable comes out, e.g. for
 * scanned pages or fonts with custom glyph encodings.
 */
export async function pdfText(bytes: Uint8Array): Promise<string | undefined> {
  const s = Buffer.from(bytes.subarray(0, PDF_SCAN_LIMIT)).toString("latin1");
  const parts: string[] = [];
  let total = 0;
  const streamRe = /stream\r?\n/g;
  for (let m = streamRe.exec(s); m && total < PDF_TEXT_LIMIT; m = streamRe.exec(s)) {
    if (s.slice(Math.max(0, m.index - 3), m.index) === "end") continue;
    const dictStart = s.lastIndexOf("obj", m.index);
    const dict = s.slice(dictStart < 0 ? Math.max(0, m.index - 600) : dictStart, m.index);
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    streamRe.lastIndex = end + 9;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(XRef|ObjStm|XObject)|\/(DCT|JPX|CCITTFax|JBIG2)Decode/.test(dict)) continue;
    let data = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ""), "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = Buffer.from(inflate(data, "deflate"));
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    const content = data.toString("latin1");
    if (!/\bBT\b/.test(content) || !/T[jJ]|'|"/.test(content)) continue;
    const text = contentText(content).trim();
    if (text) {
      parts.push(text);
      total += text.length;
    }
  }
  const text = parts.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return looksReadable(text) ? text : undefined;
}
