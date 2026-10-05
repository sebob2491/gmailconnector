/** Builds small but real PDF / ZIP-based Office files for tests. */
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

/** A minimal ZIP archive (deflate-compressed entries), as used by .docx/.xlsx/.pptx. */
export function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A PDF whose pages draw the given content streams (compressed with FlateDecode). */
export function pdf(pages: string[], extraStreams: { dict: string; data: Buffer }[] = []): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let n = 1;
  const obj = (dict: string, data: Buffer) => {
    parts.push(Buffer.from(`${n++} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
  };
  parts.push(Buffer.from(`${n++} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`, "latin1"));
  for (const extra of extraStreams) obj(extra.dict, extra.data);
  for (const content of pages) obj("/Filter /FlateDecode", deflateSync(Buffer.from(content, "latin1")));
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

export const docx = (paragraphs: string[]) =>
  zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs
      .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  });

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
