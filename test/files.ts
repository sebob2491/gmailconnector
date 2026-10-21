/** Builds small but real PDF / ZIP-based Office files for tests. */
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

export interface ZipFile {
  name: string;
  data: Buffer;
  /** 8 = deflate (default), 0 = stored. */
  method?: 0 | 8;
  /** Overrides the uncompressed size recorded in the archive (to fake a damaged or malicious file). */
  declaredSize?: number;
}

/** A ZIP archive with the given entries, as used by .docx/.xlsx/.pptx. */
export function zipOf(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 8;
    const packed = method === 8 ? deflateRawSync(file.data) : file.data;
    const size = file.declaredSize ?? file.data.length;
    const nameBytes = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A minimal ZIP archive (deflate-compressed entries) of text files. */
export function zip(files: Record<string, string>): Buffer {
  return zipOf(Object.entries(files).map(([name, content]) => ({ name, data: Buffer.from(content, "utf8") })));
}

/** A PDF made of the given stream objects, in order, without a usable page tree (its catalog points at a stream). */
export function pdfOf(streams: { dict: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let n = 1;
  parts.push(Buffer.from(`${n++} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`, "latin1"));
  for (const { dict, data } of streams) {
    parts.push(Buffer.from(`${n++} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
  }
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

interface PdfObject {
  body: string;
  data?: Buffer;
}

const pdfObject = (num: number, { body, data }: PdfObject) =>
  data
    ? Buffer.concat([
        Buffer.from(`${num} 0 obj\n<< ${body} /Length ${data.length} >>\nstream\n`, "latin1"),
        data,
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ])
    : Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, "latin1");

/** "3 0 R" for each object number (given one by one, or as arrays). */
export const refs = (...nums: (number | number[])[]) =>
  nums
    .flat()
    .map((n) => `${n} 0 R`)
    .join(" ");

/**
 * Builds a PDF object by object, for page trees, object streams and incremental updates. An
 * object is PDF text (e.g. "<< /Type /Page … >>"), or a stream when it has data; a stream's body
 * lists its dictionary entries without "<<" and ">>" (/Length is added).
 */
export class PdfBuilder {
  private readonly objects = new Map<number, PdfObject>();
  private next = 1;

  add(body: string, data?: Buffer): number {
    const num = this.next++;
    this.objects.set(num, { body, data });
    return num;
  }

  /** An object number to fill in later with set(). */
  reserve(): number {
    return this.add("null");
  }

  set(num: number, body: string, data?: Buffer) {
    this.objects.set(num, { body, data });
  }

  /** A page content stream, compressed with FlateDecode. */
  content(text: string): number {
    return this.add("/Filter /FlateDecode", deflateSync(Buffer.from(text, "latin1")));
  }

  /** A CMap stream (a font's /ToUnicode, or a composite font's /Encoding), compressed. */
  cmap(text: string): number {
    return this.add("/Filter /FlateDecode", deflateSync(Buffer.from(text, "latin1")));
  }

  /**
   * A composite (Type0) font with a CIDFontType2 descendant, the way producers embed TrueType
   * subsets: Identity-H unless `encoding` says otherwise; `toUnicode` names a CMap object; `w` is
   * the /W array's content and `dw` the default width; `ordering` is the CIDSystemInfo ordering.
   */
  type0Font(opts: { toUnicode?: number; encoding?: string; w?: string; dw?: number; ordering?: string; base?: string; fontFile?: Buffer; cidToGid?: Buffer } = {}): number {
    const base = opts.base ?? "Inter-Regular";
    const fontFile = opts.fontFile && this.add(`/Filter /FlateDecode /Length1 ${opts.fontFile.length}`, deflateSync(opts.fontFile));
    const descriptor = this.add(
      `<< /Type /FontDescriptor /FontName /${base} /Flags 4 /FontBBox [-700 -300 2500 1100] /ItalicAngle 0 /Ascent 969 /Descent -241 /CapHeight 727 /StemV 39` +
        `${fontFile === undefined ? "" : ` /FontFile2 ${refs(fontFile)}`} >>`,
    );
    const cidToGid = opts.cidToGid ? refs(this.add("/Filter /FlateDecode", deflateSync(opts.cidToGid))) : "/Identity";
    const descendant = this.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /FontDescriptor ${refs(descriptor)} /CIDToGIDMap ${cidToGid}` +
        ` /CIDSystemInfo << /Registry (Adobe) /Ordering (${opts.ordering ?? "Identity"}) /Supplement 0 >>` +
        `${opts.dw === undefined ? "" : ` /DW ${opts.dw}`}${opts.w === undefined ? "" : ` /W [${opts.w}]`} >>`,
    );
    return this.add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding ${opts.encoding ?? "/Identity-H"} /DescendantFonts [${refs(descendant)}]` +
        `${opts.toUnicode === undefined ? "" : ` /ToUnicode ${refs(opts.toUnicode)}`} >>`,
    );
  }

  /**
   * A simple font: `encoding` is the /Encoding value (a name, or a dictionary with /Differences),
   * `widths` the /Widths array's content starting at `firstChar` (32 by default).
   */
  simpleFont(opts: { subtype?: string; base?: string; encoding?: string; widths?: string; firstChar?: number; toUnicode?: number; extra?: string } = {}): number {
    return this.add(
      `<< /Type /Font /Subtype /${opts.subtype ?? "TrueType"} /BaseFont /${opts.base ?? "Arial"}` +
        `${opts.encoding ? ` /Encoding ${opts.encoding}` : ""}` +
        `${opts.widths === undefined ? "" : ` /FirstChar ${opts.firstChar ?? 32} /Widths [${opts.widths}]`}` +
        `${opts.toUnicode === undefined ? "" : ` /ToUnicode ${refs(opts.toUnicode)}`}${opts.extra ?? ""} >>`,
    );
  }

  /**
   * The file. Objects are written in `order` (the others follow by number); objects listed in
   * `packed` go into one compressed object stream; `xrefStream` writes the trailer as a
   * cross-reference stream (as PDFs with object streams do) instead of a "trailer" dictionary.
   */
  build(root: number, opts: { order?: number[]; packed?: number[]; xrefStream?: boolean } = {}): Buffer {
    const packed = new Set(opts.packed ?? []);
    const nums = [...new Set([...(opts.order ?? []), ...[...this.objects.keys()].sort((a, b) => a - b)])].filter((n) => !packed.has(n));
    const parts = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1"), ...nums.map((n) => pdfObject(n, this.objects.get(n)!))];
    let size = this.next;
    if (packed.size) {
      let header = "";
      let bodies = "";
      for (const n of packed) {
        header += `${n} ${bodies.length} `;
        bodies += `${this.objects.get(n)!.body}\n`;
      }
      const data = deflateSync(Buffer.from(header + bodies, "latin1"));
      parts.push(pdfObject(size++, { body: `/Type /ObjStm /N ${packed.size} /First ${header.length} /Filter /FlateDecode`, data }));
    }
    if (opts.xrefStream) {
      parts.push(pdfObject(size, { body: `/Type /XRef /Size ${size + 1} /Root ${root} 0 R /W [1 2 1]`, data: Buffer.alloc(0) }));
      parts.push(Buffer.from("startxref\n0\n%%EOF\n", "latin1"));
    } else parts.push(Buffer.from(`trailer\n<< /Size ${size} /Root ${root} 0 R >>\nstartxref\n0\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}

/** Appends an incremental update to a PDF: new versions of objects, then a new trailer. */
export function pdfUpdate(file: Buffer, root: number, objects: ({ num: number } & PdfObject)[], extraTrailer = ""): Buffer {
  return Buffer.concat([
    file,
    ...objects.map((o) => pdfObject(o.num, o)),
    Buffer.from(`trailer\n<< /Root ${root} 0 R${extraTrailer} >>\nstartxref\n0\n%%EOF\n`, "latin1"),
  ]);
}

/**
 * A minimal TrueType font program: a cmap mapping code points to glyph ids (format 4 for the BMP,
 * and format 12 when a code point lies beyond it), `composites` naming glyphs drawn as another
 * glyph (as .case variants often are), and the tables a reader needs to find those; `tables`
 * leaves some out. Enough to look glyphs up, not to render them.
 */
export function ttf(opts: { cmap: Record<number, number>; composites?: Record<number, number>; numGlyphs?: number; tables?: string[] }): Buffer {
  const codes = Object.keys(opts.cmap).map(Number).sort((a, b) => a - b);
  const composites = opts.composites ?? {};
  const numGlyphs = opts.numGlyphs ?? Math.max(0, ...codes.map((c) => opts.cmap[c]), ...Object.keys(composites).map(Number), ...Object.values(composites)) + 1;
  const be16 = (values: number[]) => Buffer.from(values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff]));
  const be32 = (values: number[]) => Buffer.from(values.flatMap((v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]));
  // cmap: format 4 over the BMP code points (one segment each, plus the final 0xFFFF one), format 12 over all when needed.
  const bmp = codes.filter((c) => c <= 0xffff);
  const segments = bmp.length + 1;
  const format4 = Buffer.concat([
    be16([4, 16 + segments * 8, 0, segments * 2, 0, 0, 0]),
    be16([...bmp, 0xffff]),
    be16([0]),
    be16([...bmp, 0xffff]),
    be16([...bmp.map((c) => (opts.cmap[c] - c) & 0xffff), 1]),
    be16(Array(segments).fill(0)),
  ]);
  const wide = codes.some((c) => c > 0xffff);
  const format12 = wide ? Buffer.concat([be16([12, 0]), be32([16 + codes.length * 12, 0, codes.length]), ...codes.map((c) => be32([c, c, opts.cmap[c]]))]) : Buffer.alloc(0);
  const records = wide ? 2 : 1;
  const cmap = Buffer.concat([be16([0, records]), be16([3, 1]), be32([4 + records * 8]), ...(wide ? [be16([3, 10]), be32([4 + records * 8 + format4.length])] : []), format4, format12]);
  // glyf and loca (long offsets): composites are one component each; other glyphs are empty.
  const glyphs: Buffer[] = [];
  const loca: number[] = [0];
  for (let g = 0; g < numGlyphs; g++) {
    const base = composites[g];
    const data = base === undefined ? Buffer.alloc(0) : Buffer.concat([be16([0xffff, 0, 0, 0, 0, 0x0003, base, 0, 120])]);
    glyphs.push(data);
    loca.push(loca[g] + data.length);
  }
  const head = Buffer.alloc(54);
  head.writeInt16BE(1, 50); // long loca offsets
  const maxp = Buffer.concat([be32([0x00005000]), be16([numGlyphs])]);
  const tables: [string, Buffer][] = [["cmap", cmap], ["glyf", Buffer.concat(glyphs)], ["head", head], ["loca", be32(loca)], ["maxp", maxp]];
  const kept = tables.filter(([tag]) => !opts.tables || opts.tables.includes(tag));
  let offset = 12 + kept.length * 16;
  const directory: Buffer[] = [be32([0x00010000]), be16([kept.length, 0, 0, 0])];
  const bodies: Buffer[] = [];
  for (const [tag, data] of kept) {
    directory.push(Buffer.from(tag, "latin1"), be32([0, offset, data.length]));
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([...directory, ...bodies]);
}

/** A 4-digit hex code, as CMaps write them. */
export const hex4 = (code: number) => code.toString(16).toUpperCase().padStart(4, "0");

/** A hex string of character codes, each `bytes` wide, as content streams show text in composite fonts. */
export const hexString = (codes: number[], bytes = 2) => `<${codes.map((code) => code.toString(16).toUpperCase().padStart(2 * bytes, "0")).join("")}>`;

/**
 * A ToUnicode CMap as producers write them: `codespace` ranges (<0000> <FFFF> by default), `bfchar`
 * [src, dst] pairs and `bfrange` [lo, hi, dst] entries whose dst is one hex string (counting up) or
 * an array of them, all as hex digits; `junk` is written where the mappings go, before them.
 */
export function cmapOf(opts: { codespace?: [string, string][]; bfchar?: [string, string][]; bfrange?: [string, string, string | string[]][]; junk?: string }): string {
  const lines = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
  ];
  const codespace = opts.codespace ?? [["0000", "FFFF"]];
  lines.push(`${codespace.length} begincodespacerange`);
  for (const [lo, hi] of codespace) lines.push(`<${lo}> <${hi}>`);
  lines.push("endcodespacerange");
  if (opts.junk) lines.push(opts.junk);
  if (opts.bfchar?.length) {
    lines.push(`${opts.bfchar.length} beginbfchar`);
    for (const [src, dst] of opts.bfchar) lines.push(`<${src}> <${dst}>`);
    lines.push("endbfchar");
  }
  if (opts.bfrange?.length) {
    lines.push(`${opts.bfrange.length} beginbfrange`);
    for (const [lo, hi, dst] of opts.bfrange) lines.push(`<${lo}> <${hi}> ${Array.isArray(dst) ? `[${dst.map((d) => `<${d}>`).join(" ")}]` : `<${dst}>`}`);
    lines.push("endbfrange");
  }
  lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
  return lines.join("\n");
}

/**
 * A PDF whose pages (in a real page tree) draw the given content streams; `extraStreams` are other,
 * unreferenced objects; `fonts` adds fonts to the builder and names them in every page's /Resources.
 */
export function pdf(pages: string[], extraStreams: { dict: string; data: Buffer }[] = [], fonts?: (b: PdfBuilder) => Record<string, number>): Buffer {
  const b = new PdfBuilder();
  const catalog = b.reserve();
  const tree = b.reserve();
  for (const extra of extraStreams) b.add(extra.dict, extra.data);
  const resources = fonts ? ` /Resources << /Font << ${fontResources(fonts(b))} >> >>` : "";
  const kids = pages.map((content) => b.add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${refs(b.content(content))}${resources} >>`));
  b.set(catalog, `<< /Type /Catalog /Pages ${refs(tree)} >>`);
  b.set(tree, `<< /Type /Pages /Kids [${refs(kids)}] /Count ${kids.length} >>`);
  return b.build(catalog);
}

/** The entries of a /Font resource dictionary: "/F1 5 0 R /F2 9 0 R". */
export const fontResources = (fonts: Record<string, number>) =>
  Object.entries(fonts)
    .map(([name, num]) => `/${name} ${refs(num)}`)
    .join(" ");

/** A Word document whose body is the given WordprocessingML. */
export const docxOf = (body: string) =>
  zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
  });

export const docx = (paragraphs: string[]) =>
  docxOf(paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join(""));

export const xlsx = (rows: (string | number)[][]) => {
  const strings: string[] = [];
  const cell = (v: string | number, ref: string) => {
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    strings.push(v);
    return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
  };
  const sheet = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, String.fromCharCode(65 + c) + (r + 1))).join("")}</row>`)
    .join("");
  return zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
  });
};

export const pptx = (slides: string[][]) =>
  zip(
    Object.fromEntries(
      slides.map((lines, i) => [
        `ppt/slides/slide${i + 1}.xml`,
        `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`,
      ]),
    ),
  );

/** A 1x1 transparent PNG. */
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * An Excel workbook laid out like Excel writes it: workbook relationships, optional shared strings
 * and styles. Sheets give their <sheetData> content; chart sheets have none.
 */
export function xlsxOf(opts: {
  sheets: { name: string; data?: string; chart?: boolean; state?: string }[];
  shared?: string[];
  styles?: string;
  prefix?: string;
  date1904?: boolean;
}): Buffer {
  const x = opts.prefix ? `${opts.prefix}:` : "";
  const ns = opts.prefix ? `xmlns:${opts.prefix}` : "xmlns";
  const files: Record<string, string> = {
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  };
  const rels: string[] = [];
  const sheets = opts.sheets.map((sheet, i) => {
    const id = `rId${i + 1}`;
    const target = sheet.chart ? `chartsheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`;
    rels.push(`<Relationship Id="${id}" Type="${REL}/${sheet.chart ? "chartsheet" : "worksheet"}" Target="${target}"/>`);
    files[`xl/${target}`] = sheet.chart
      ? "<chartsheet/>"
      : `<${x}worksheet ${ns}="main"><${x}sheetData>${sheet.data ?? ""}</${x}sheetData></${x}worksheet>`;
    return `<${x}sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="${id}"/>`;
  });
  if (opts.shared) {
    rels.push(`<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
    files["xl/sharedStrings.xml"] = `<${x}sst ${ns}="main">${opts.shared.map((s) => (s === "" ? `<${x}si/>` : `<${x}si>${s}</${x}si>`)).join("")}</${x}sst>`;
  }
  if (opts.styles) {
    rels.push(`<Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/>`);
    files["xl/styles.xml"] = `<styleSheet>${opts.styles}</styleSheet>`;
  }
  files["xl/workbook.xml"] =
    `<${x}workbook ${ns}="main" xmlns:r="${REL}">${opts.date1904 ? `<${x}workbookPr date1904="1"/>` : ""}<${x}sheets>${sheets.join("")}</${x}sheets></${x}workbook>`;
  files["xl/_rels/workbook.xml.rels"] = `<Relationships>${rels.join("")}</Relationships>`;
  return zip(files);
}
