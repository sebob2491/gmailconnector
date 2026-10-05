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

/** A PDF made of the given stream objects, in order. */
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

/** A PDF whose pages draw the given content streams (compressed with FlateDecode). */
export function pdf(pages: string[], extraStreams: { dict: string; data: Buffer }[] = []): Buffer {
  return pdfOf([...extraStreams, ...pages.map((content) => ({ dict: "/Filter /FlateDecode", data: deflateSync(Buffer.from(content, "latin1")) }))]);
}

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
