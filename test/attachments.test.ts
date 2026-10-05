import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { attachmentCharset, attachmentText } from "../src/format.js";
import { attachmentResult, decodeTextFile, FileTooLargeError, kindOf, officeText, pdfText, readOffice, readPdf, readTextFile, sniffType } from "../src/attachments.js";
import { docx, docxOf, pdf, PdfBuilder, pdfOf, pdfUpdate, png, pptx, refs, xlsx, xlsxOf, zip, zipOf } from "./files.js";

test("PDF text comes out with line breaks and word spacing", async () => {
  const file = pdf([
    "BT /F1 12 Tf 72 720 Td (Pay statement for Sebastian) Tj 0 -14 Td (Net pay: $1,234.56) Tj T* [(Hello)-250(World)] TJ ET",
    "BT /F1 12 Tf 72 720 Td (Caf\\351 \\(page two\\)) Tj ET",
  ]);
  assert.equal(await pdfText(file), "--- Page 1 ---\nPay statement for Sebastian\nNet pay: $1,234.56\nHello World\n\n--- Page 2 ---\nCafé (page two)");
});

test("PDF images and other binary streams are skipped", async () => {
  const file = pdf(["BT 72 720 Td (Only this text should appear here) Tj ET"], [
    { dict: "/Subtype /Image /Filter /DCTDecode", data: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x42]) },
  ]);
  assert.equal(await pdfText(file), "Only this text should appear here");
});

test("PDFs whose fonts use custom encodings report no text instead of gibberish", async () => {
  const file = pdf(["BT /F1 12 Tf 72 720 Td <0003000400050006000700080009000A000B000C000D000E000F00100011> Tj ET"]);
  assert.equal(await pdfText(file), undefined);
});

test("Word, Excel and PowerPoint text", async () => {
  assert.equal(await officeText(docx(["Dear Sebastian,", "Your offer letter &amp; start date."])), "Dear Sebastian,\nYour offer letter & start date.");
  assert.equal(
    await officeText(xlsx([["Item", "Cost"], ["Coffee", 4.5], ["Rent", 1200]])),
    "--- Sheet: Budget & Plan ---\nItem\tCost\nCoffee\t4.5\nRent\t1200",
  );
  assert.equal(await officeText(pptx([["Q3 Review"], ["Revenue up", "Costs down"]])), "--- Slide 1 ---\nQ3 Review\n\n--- Slide 2 ---\nRevenue up\nCosts down");
  await assert.rejects(officeText(Buffer.from("not a zip")), /not a ZIP/);
});

test("file types are recognized from content when Gmail says octet-stream", () => {
  assert.equal(sniffType(pdf([]), "application/octet-stream", "x.bin"), "application/pdf");
  assert.equal(sniffType(png, "", "image"), "image/png");
  assert.equal(
    sniffType(docx(["x"]), "application/octet-stream", "letter.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(kindOf("text/csv", "a.csv"), "text");
  assert.equal(kindOf("application/octet-stream", "notes.txt"), "text");
  assert.equal(kindOf("text/calendar", "invite.ics"), "text");
  assert.equal(kindOf("application/zip", "a.zip"), "binary");
});

test("text files: UTF-16, BOMs and HTML", () => {
  assert.equal(decodeTextFile(Buffer.from("﻿name,amount", "utf8"), "text/csv", "a.csv"), "name,amount");
  assert.equal(decodeTextFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hé", "utf16le")]), "text/plain", "a.txt"), "hé");
  assert.equal(decodeTextFile(Buffer.from("<p>Hello <b>there</b></p>"), "text/html", "page.html"), "Hello there");
});

// ---------- size limits and budgets ----------

/** Runs an async call; returns its result (or error) and the CPU milliseconds it used (wall time varies with load). */
async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const start = process.cpuUsage();
  const ms = () => {
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  try {
    const value = await fn();
    return { value, ms: ms() };
  } catch (error) {
    return { error, ms: ms() };
  }
}

/** `count` Word paragraphs, each different so the XML compresses like a real document. */
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i}: the quick brown fox ${i * 7919} jumps.</w:t></w:r></w:p>`).join("");

test("decompression bombs fail fast with a clear error instead of exhausting memory", async () => {
  const bomb = Buffer.alloc(64 * 1024 * 1024, "a");
  // Honest sizes: refused from the compression ratio alone, without inflating anything.
  const honest = await timed(() => readOffice(zipOf([{ name: "word/document.xml", data: bomb }])));
  assert.ok(honest.error instanceof FileTooLargeError, String(honest.error));
  assert.match((honest.error as Error).message, /decompression bomb/);
  // A header that lies about the size: inflating stops at the part limit.
  const lying = await timed(() => readOffice(zipOf([{ name: "word/document.xml", data: bomb, declaredSize: 2000 }])));
  assert.ok(lying.error instanceof FileTooLargeError, String(lying.error));
  // A PDF stream that unpacks to 64 MB is skipped; the rest of the PDF is still read.
  const b = new PdfBuilder();
  const text = b.content("BT 72 700 Td (Readable statement text for the account holder.) Tj ET");
  const huge = b.add("/Filter /FlateDecode", deflateSync(Buffer.alloc(64 * 1024 * 1024, " ")));
  const page = b.add(`<< /Type /Page /Contents [${refs(text, huge)}] >>`);
  const pdfBomb = b.build(b.add(`<< /Type /Catalog /Pages ${refs(b.add(`<< /Type /Pages /Kids [${refs(page)}] /Count 1 >>`))} >>`));
  const read = await timed(() => readPdf(pdfBomb));
  assert.equal(read.value?.text, "Readable statement text for the account holder.");
  assert.match(read.value?.incomplete ?? "", /too large/);
  for (const r of [honest, lying, read]) assert.ok(r.ms < 200, `took ${r.ms.toFixed(0)} ms`);
});

test("readers stop once they have maxChars of text", async () => {
  // A 13 MB document.xml: only the first part is unpacked for 20,000 characters.
  const big = docxOf(paragraphs(200_000));
  const some = await timed(() => readOffice(big, { maxChars: 20_000 }));
  assert.ok(some.value!.text.length >= 20_000);
  assert.equal(some.value!.more, true);
  assert.equal(some.value!.incomplete, undefined);
  assert.ok(some.ms < 200, `took ${some.ms.toFixed(0)} ms`);
  // Asking for everything still stops at the size limits, and says so.
  const all = await readOffice(big, { maxChars: 0 });
  assert.match(all.incomplete ?? "", /only (its|the) beginning is shown/);
  assert.equal(all.more, undefined);

  const pages = Array.from({ length: 50 }, (_, p) =>
    Array.from({ length: 50 }, (_, l) => `BT /F1 10 Tf 72 ${700 - l * 12} Td (Line ${l} of page ${p}: lorem ipsum dolor sit amet) Tj ET`).join("\n"),
  );
  const file = pdf(pages);
  const first = await readPdf(file, { maxChars: 20_000 });
  assert.equal(first!.more, true);
  assert.match(first!.text, /of page 0:/);
  assert.doesNotMatch(first!.text, /of page 49:/);
  const whole = await readPdf(file, { maxChars: 0 });
  assert.match(whole!.text, /Line 49 of page 49:/);
  assert.equal(whole!.more, undefined);
  assert.equal(whole!.incomplete, undefined);
});

test("PDF pages after large images are read", async () => {
  const photo = { dict: "/Subtype /Image /Filter /DCTDecode", data: randomBytes(4.5 * 1024 * 1024) };
  const file = pdfOf([
    { dict: "/Filter /FlateDecode", data: deflateSync(Buffer.from("BT 72 720 Td (Page one: summary of the contract terms.) Tj ET")) },
    photo,
    { dict: "/Filter /FlateDecode", data: deflateSync(Buffer.from("BT 72 720 Td (Page two: the termination fee is 50000 dollars.) Tj ET")) },
  ]);
  assert.equal((await readPdf(file))!.text, "Page one: summary of the contract terms.\n\nPage two: the termination fee is 50000 dollars.");
});

test("embedded font programs are not read as page text", async () => {
  // Font data can contain "BT" and "Tj" by chance; before, that garbage made readable PDFs unreadable.
  const fontData = Buffer.from(`\x00\x01BT (\x8f\x02\x03\x9a\x9b\x00\x01\x7f\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b) Tj ET\x00\xff`.repeat(50), "latin1");
  const file = pdf(["BT 72 700 Td (This is the real body text of the letter, nothing else.) Tj ET"], [
    { dict: `/Length1 ${fontData.length} /Filter /FlateDecode`, data: deflateSync(fontData) },
    { dict: "/Subtype /Type1C /Filter /FlateDecode", data: deflateSync(fontData) },
  ]);
  assert.equal((await readPdf(file))!.text, "This is the real body text of the letter, nothing else.");
});

test("hostile PDFs are read in linear time", async () => {
  const cases = {
    "a million spaces in one string": pdf([`BT (${"word ".repeat(10)}) Tj (${" ".repeat(1_000_000)}) Tj (end of the line here) Tj ET`]),
    "20,000 streams without objects": Buffer.from(`%PDF-1.4\n${"stream\nx\nendstream\n".repeat(20_000)}`, "latin1"),
  };
  for (const [name, file] of Object.entries(cases)) {
    const r = await timed(() => readPdf(file));
    assert.ok(r.ms < 200, `${name}: ${r.ms.toFixed(0)} ms`);
  }
});

// ---------- spreadsheets ----------

test("spreadsheet cells keep their columns and rows, including gaps", async () => {
  const file = xlsxOf({
    shared: ["<t>Name</t>", "<t>Phone</t>", "<t>Email</t>", "<t>Ann</t>", "<t>ann@x.com</t>"],
    sheets: [
      {
        name: "People",
        // Excel leaves empty cells out: B2 is missing, row 3 is missing, row 4 starts at column B.
        data:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row>' +
          '<row r="4"><c r="B4" s="2"/><c r="C4"><v>7</v></c></row>' +
          '<row r="40"><c r="A40" t="inlineStr"><is><t>Total</t></is></c></row>',
      },
    ],
  });
  assert.equal(
    await officeText(file),
    "--- Sheet: People ---\nName\tPhone\tEmail\nAnn\t\tann@x.com\n\n\t\t7\n(rows 5–39 are empty)\nTotal",
  );
});

test("spreadsheet values look like they do in Excel", async () => {
  const file = xlsxOf({
    styles:
      '<numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
      '<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/><xf numFmtId="46"/></cellXfs>',
    sheets: [
      {
        name: "Values",
        data:
          '<row r="1"><c r="A1" s="1"><v>45566</v></c><c r="B1" s="2"><v>45566.5625</v></c><c r="C1" s="3"><v>1234.5</v></c>' +
          '<c r="D1" s="4"><v>0.75</v></c><c r="E1" s="5"><v>1.5</v></c><c r="F1"><v>0.30000000000000004</v></c>' +
          '<c r="G1" t="b"><v>1</v></c><c r="H1" t="b"><v>0</v></c><c r="I1" t="e"><v>#DIV/0!</v></c>' +
          '<c r="J1" t="str"><f>A1&amp;"x"</f><v>a &amp; b</v></c></row>',
      },
    ],
  });
  assert.equal(
    await officeText(file),
    "--- Sheet: Values ---\n2024-10-01\t2024-10-01 13:30\t1234.5\t18:00\t36:00:00\t0.3\tTRUE\tFALSE\t#DIV/0!\ta & b",
  );
  // Workbooks using the 1904 date system.
  const mac = xlsxOf({ date1904: true, styles: '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>', sheets: [{ name: "S", data: '<row r="1"><c r="A1" s="1"><v>0</v></c></row>' }] });
  assert.equal(await officeText(mac), "--- Sheet: S ---\n1904-01-01");
});

test("spreadsheet sheets are named through the workbook's relationships", async () => {
  const file = xlsxOf({
    shared: ['<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>', "", '<r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> rest</t></r>'],
    sheets: [
      { name: "Data", data: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' },
      { name: "Chart1", chart: true },
      { name: "Summary", data: '<row r="1"><c r="A1" t="inlineStr"><is><t>summary</t></is></c></row>' },
      { name: "Old &amp; hidden", state: "hidden", data: '<row r="1"><c r="A1"><v>1</v></c></row>' },
    ],
  });
  // Phonetic guides are left out, empty shared strings keep later ones in place, chart sheets are skipped.
  assert.equal(
    await officeText(file),
    "--- Sheet: Data ---\n東京\t\tBold rest\n\n--- Sheet: Summary ---\nsummary\n\n--- Sheet: Old & hidden (hidden) ---\n1",
  );
  // Files that put a namespace prefix on every element (e.g. from the Open XML SDK).
  const prefixed = xlsxOf({
    prefix: "x",
    shared: ["<x:t>Total</x:t>"],
    sheets: [{ name: "Report", data: '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>42</x:v></x:c></x:row>' }],
  });
  assert.equal(await officeText(prefixed), "--- Sheet: Report ---\nTotal\t42");
});

test("big spreadsheets stop after maxChars, mid-sheet", async () => {
  const rows = Array.from({ length: 50_000 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>Customer ${r}</t></is></c><c r="B${r + 1}"><v>${r * 7.25}</v></c></row>`);
  const file = xlsxOf({ sheets: [{ name: "Big", data: rows.join("") }, { name: "Next", data: "" }] });
  const r = await timed(() => readOffice(file, { maxChars: 20_000 }));
  assert.equal(r.value!.more, true);
  assert.ok(r.value!.text.length >= 20_000 && r.value!.text.length < 21_000, String(r.value!.text.length));
  assert.ok(r.ms < 200, `took ${r.ms.toFixed(0)} ms`);
});

// ---------- Word and PowerPoint ----------

const wp = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const wcell = (text: string, span = 1) => `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${wp(text)}</w:tc>`;

test("Word tables come out as tab-separated rows", async () => {
  const table =
    `<w:tbl><w:tr>${wcell("Item")}${wcell("Qty")}${wcell("Price")}</w:tr>` +
    `<w:tr>${wcell("Tea")}<w:tc>${wp("2")}${wp("boxes")}</w:tc>${wcell("3.50")}</w:tr>` +
    `<w:tr>${wcell("Total", 2)}${wcell("7.00")}</w:tr></w:tbl>`;
  assert.equal(await officeText(docxOf(`${wp("Before")}${table}${wp("After")}`)), "Before\nItem\tQty\tPrice\nTea\t2 boxes\t3.50\nTotal\t\t7.00\nAfter");
});

test("Word text leaves out fallbacks, deletions, field codes and drawing numbers", async () => {
  const textBox = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wps:txbx><w:txbxContent>${wp(
    "Boxed text",
  )}</w:txbxContent></wps:txbx></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>${wp("Boxed text")}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
  const edits =
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Price is </w:t></w:r>' +
    '<w:del w:id="1" w:author="A"><w:r><w:delText>$100</w:delText></w:r></w:del><w:ins w:id="2" w:author="A"><w:r><w:t>$80</w:t></w:r></w:ins>' +
    '<w:r><w:tab/><w:t>net</w:t><w:br/><w:t>30 days</w:t></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://x.com" </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>our site</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  assert.equal(await officeText(docxOf(textBox + edits)), "Boxed text\n\nPrice is $80\tnet\n30 days\nour site");
});

test("Word's main document is found through the package relationships", async () => {
  const file = zip({
    "_rels/.rels": '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml"/></Relationships>',
    "word/document2.xml": `<w:document><w:body>${wp("From document2")}</w:body></w:document>`,
  });
  assert.equal(await officeText(file), "From document2");
});

test("PowerPoint keeps line breaks and follows the presentation's slide order", async () => {
  const slide = (body: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const file = zip({
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${rel}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    // Slides moved around in PowerPoint keep their file names; the order lives in presentation.xml.
    "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="${rel}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${rel}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide('<a:p><a:r><a:t>Quarterly</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:r><a:t>Results</a:t></a:r></a:p>'),
    "ppt/slides/slide2.xml": slide('<a:p><a:pPr><a:tabLst><a:tab pos="914400" algn="l"/></a:tabLst></a:pPr><a:r><a:t>Agenda</a:t></a:r></a:p>'),
  });
  assert.equal(await officeText(file), "--- Slide 1 ---\nAgenda\n\n--- Slide 2 ---\nQuarterly\nResults");
});

test("attachment text keeps its spaces and tabs", () => {
  const yaml = "﻿server:\n  port: 80\n  hosts:\n    - a\u0000\nname\t\tamount\n";
  assert.equal(attachmentText(yaml), "server:\n  port: 80\n  hosts:\n    - a\nname\t\tamount\n");
});

// ---------- text files and types ----------

test("text attachments decode by byte-order mark, declared charset, or a Windows-1252 guess", () => {
  // Excel's "CSV" on Windows writes Windows-1252; it is not valid UTF-8, so that is the guess.
  const csv = Buffer.from([...Buffer.from("Name;Stadt;Betrag\nJ\xfcrgen;K\xf6ln;12,50 ", "latin1"), 0x80]);
  assert.equal(decodeTextFile(csv, "text/csv", "export.csv"), "Name;Stadt;Betrag\nJürgen;Köln;12,50 €");
  // A declared charset is used (here from the attachment's Content-Type).
  assert.equal(decodeTextFile(Buffer.from([0x93, 0x8c, 0x8b, 0x9e]), "text/plain", "memo.txt", "Shift_JIS"), "東京");
  assert.equal(decodeTextFile(Buffer.from("\x1b$B$3$s$K$A$O\x1b(B", "latin1"), "text/plain", "jp.txt", '"iso-2022-jp"'), "こんにちは");
  // HTML can declare it in a <meta> tag.
  const html = Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>\xcf\xf0\xe8\xe2\xe5\xf2</p></body></html>', "latin1");
  assert.equal(decodeTextFile(html, "text/html", "page.html"), "Привет");
  // Valid UTF-8 stays UTF-8, even when labeled US-ASCII.
  assert.equal(decodeTextFile(Buffer.from("Café ✓"), "text/plain", "a.txt", "us-ascii"), "Café ✓");
  assert.equal(decodeTextFile(Buffer.from("﻿BOM first"), "text/plain", "a.txt", "windows-1252"), "BOM first");
});

test("long text attachments are decoded only as far as needed", () => {
  const big = Buffer.from("line of text ✓\n".repeat(200_000));
  const some = readTextFile(big, "text/plain", "log.txt", { maxChars: 20_000 });
  assert.equal(some.more, true);
  assert.ok(some.text.length >= 20_000 && some.text.length <= 80_004);
  assert.equal(readTextFile(big, "text/plain", "log.txt", { maxChars: 0 }).more, undefined);
  // A file decoded in full isn't "more": the caller knows exactly how much it leaves out.
  const small = readTextFile(Buffer.from("a,b\n1,2"), "text/csv", "notes.csv", { maxChars: 3 });
  assert.deepEqual(small, { text: "a,b\n1,2" });
  assert.match(attachmentResult(small, 3).truncated!, /4 more characters not shown/);
});

test("file types: content signatures win, odd type names are understood", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  assert.equal(sniffType(jpeg, "image/jpg", "photo.jpg"), "image/jpeg");
  assert.equal(sniffType(Buffer.from("not really"), "image/pjpeg", "photo.jpg"), "image/jpeg");
  assert.equal(sniffType(png, "image/jpeg", "misnamed.jpg"), "image/png");
  assert.equal(sniffType(pdf([]), "application/x-download", "statement"), "application/pdf");
  assert.equal(sniffType(Buffer.from("%PDF-1.7"), "application/force-download", "invoice.pdf"), "application/pdf");
  assert.equal(sniffType(docx(["x"]), "application/zip", "letter.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(kindOf(sniffType(docx(["x"]), "application/octet-stream", "budget.xlsm"), "budget.xlsm"), "office");
  assert.equal(sniffType(Buffer.from("a,b"), "application/download", "data.bin"), "application/download");
  // Only exact text types count: x-sh is shell, but not x-sharedlib or x-shockwave-flash.
  assert.equal(kindOf("application/x-sh", "run.sh"), "text");
  assert.equal(kindOf("application/x-sharedlib", "libfoo.so"), "binary");
  assert.equal(kindOf("application/x-shockwave-flash", "a.swf"), "binary");
});

test("the charset of an attachment comes from its part's Content-Type", () => {
  const payload = {
    partId: "",
    mimeType: "multipart/mixed",
    parts: [
      { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }] },
      { partId: "1", mimeType: "text/csv", filename: "x.csv", headers: [{ name: "Content-Type", value: 'text/csv; charset="windows-1252"; name="x.csv"' }] },
    ],
  };
  assert.equal(attachmentCharset(payload, "1"), "windows-1252");
  assert.equal(attachmentCharset(payload, "2"), undefined);
});

test("get_attachment's note says whether a larger maxChars would show more", () => {
  const long = "x".repeat(30_000);
  // The reader stopped at maxChars: asking for more helps.
  assert.match(attachmentResult({ text: long, more: true }, 20_000).truncated!, /only the first 20,000 characters.*larger maxChars/);
  // Everything was read: the count is exact and maxChars: 0 shows all of it.
  assert.match(attachmentResult({ text: long }, 20_000).truncated!, /10,000 more characters not shown\. Call again with maxChars: 0 for all of it/);
  // A size limit cut the file: maxChars can't help, so it isn't suggested.
  const cut = attachmentResult({ text: "beginning", incomplete: "This file is too large to read here in full, so only its beginning is shown." }, 0);
  assert.equal(cut.text, "beginning");
  assert.doesNotMatch(cut.truncated!, /maxChars/);
  assert.match(cut.truncated!, /too large.*viewUrl/);
  // Nothing missing, nothing said; text keeps its tabs and indentation.
  assert.deepEqual(attachmentResult({ text: "a\t\tb\n    c" }, 20_000), { text: "a\t\tb\n    c" });
});

// ---------- PDF reading order ----------

/** A catalog and page tree over pages made by `page(builder)`, written in the builder's object order. */
function pageTree(b: PdfBuilder, pages: number[], extra = ""): number {
  const tree = b.add(`<< /Type /Pages /Kids [${refs(pages)}] /Count ${pages.length}${extra} >>`);
  return b.add(`<< /Type /Catalog /Pages ${refs(tree)} >>`);
}

const textPage = (b: PdfBuilder, text: string, resources = "") =>
  b.add(`<< /Type /Page /Contents ${refs(b.content(`BT /F1 12 Tf 72 700 Td (${text}) Tj ET`))}${resources} >>`);

test("PDF pages come out in page-tree order, with page markers", async () => {
  const b = new PdfBuilder();
  // Written to the file as Page C, Page A, Page B; the tree (in a nested Pages node) says A, B, C.
  const c = textPage(b, "Third page: closing remarks and signature.");
  const a = textPage(b, "First page: summary of the agreement terms.");
  const bp = textPage(b, "Second page: payment schedule and amounts.");
  const inner = b.add(`<< /Type /Pages /Kids [${refs(bp, c)}] /Count 2 >>`);
  const tree = b.add(`<< /Type /Pages /Kids [${refs(a, inner)}] /Count 3 >>`);
  const file = b.build(b.add(`<< /Type /Catalog /Pages ${refs(tree)} >>`));
  assert.equal(
    (await readPdf(file))!.text,
    "--- Page 1 ---\nFirst page: summary of the agreement terms.\n\n--- Page 2 ---\nSecond page: payment schedule and amounts.\n\n--- Page 3 ---\nThird page: closing remarks and signature.",
  );
  // Page markers count toward maxChars.
  const first = await readPdf(file, { maxChars: 50 });
  assert.equal(first!.more, true);
  assert.doesNotMatch(first!.text, /Second page/);
});

test("pages without text are listed together, so page numbers stay right", async () => {
  const b = new PdfBuilder();
  const pages = [textPage(b, "First page, with the cover letter text.")];
  for (let i = 0; i < 4; i++) pages.push(b.add("<< /Type /Page >>"));
  pages.push(textPage(b, "Page six has text again, after four scanned ones."), b.add("<< /Type /Page >>"));
  assert.equal(
    (await readPdf(b.build(pageTree(b, pages))))!.text,
    "--- Page 1 ---\nFirst page, with the cover letter text.\n\n--- Pages 2–5: no text ---\n\n--- Page 6 ---\nPage six has text again, after four scanned ones.\n\n--- Page 7: no text ---",
  );
});

test("PDF objects packed in object streams are found", async () => {
  const b = new PdfBuilder();
  const one = textPage(b, "Packed page one: the invoice number is 4471.");
  const two = textPage(b, "Packed page two: payment due within 30 days.");
  const root = pageTree(b, [one, two]);
  const tree = root - 1;
  // Catalog, page tree and page dictionaries live in an object stream; the trailer is a cross-reference stream.
  const file = b.build(root, { packed: [one, two, tree, root], xrefStream: true });
  assert.equal(
    (await readPdf(file))!.text,
    "--- Page 1 ---\nPacked page one: the invoice number is 4471.\n\n--- Page 2 ---\nPacked page two: payment due within 30 days.",
  );
});

test("after an incremental update only the latest version of a page is read", async () => {
  const b = new PdfBuilder();
  const one = textPage(b, "Offer letter: the position is Senior Analyst.");
  const two = textPage(b, "Salary: 90000 dollars per year (draft).");
  const root = pageTree(b, [one, two]);
  const original = b.build(root);
  // The update replaces page two's content stream (object two - 1) with a new version.
  const updated = pdfUpdate(original, root, [
    { num: two - 1, body: "/Filter /FlateDecode", data: deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Salary: 95000 dollars per year (final).) Tj ET")) },
  ]);
  const text = (await readPdf(updated))!.text;
  assert.match(text, /95000 dollars per year \(final\)/);
  assert.doesNotMatch(text, /90000|draft/);
});

test("form XObjects are read where they are drawn, once, and never recursively", async () => {
  const b = new PdfBuilder();
  const form = b.reserve();
  const self = `/Resources << /XObject << /Fm1 ${refs(form)} >> >>`;
  // The form draws itself again (a cycle), which must not loop.
  b.set(form, `/Type /XObject /Subtype /Form /BBox [0 0 612 792] ${self} /Filter /FlateDecode`, deflateSync(Buffer.from("BT /F1 12 Tf 72 680 Td (Text from the form: account 12-3456.) Tj ET /Fm1 Do")));
  const content = b.content("BT /F1 12 Tf 72 700 Td (Before the form, on top of the page.) Tj ET /Fm1 Do /Fm1 Do BT /F1 12 Tf 72 660 Td (After the form, further down.) Tj ET");
  const page = b.add(`<< /Type /Page /Contents ${refs(content)} >>`);
  // The page inherits its resources from the page tree node.
  const tree = b.add(`<< /Type /Pages /Kids [${refs(page)}] /Count 1 /Resources << /XObject << /Fm1 ${refs(form)} >> >> >>`);
  const file = b.build(b.add(`<< /Type /Catalog /Pages ${refs(tree)} >>`));
  assert.equal((await readPdf(file))!.text, "Before the form, on top of the page.\nText from the form: account 12-3456.\nAfter the form, further down.");
});

test("PDF lines are rebuilt from text positions (Word writes one text object per run)", async () => {
  const b = new PdfBuilder();
  // A font whose letters are 600/1000 em wide and spaces 300, so runs can be placed end to end.
  const widths = Array.from({ length: 95 }, (_, i) => (i === 0 ? 300 : 600)).join(" ");
  const font = b.add(`<< /Type /Font /Subtype /TrueType /BaseFont /Calibri /FirstChar 32 /LastChar 126 /Widths [${widths}] >>`);
  const width = (s: string) => [...s].reduce((w, ch) => w + (ch === " " ? 0.3 : 0.6), 0) * 11;
  const runs = ["Please pay the ", "full amount", " by Friday."];
  let x = 72;
  const line1 = runs.map((run, i) => {
    const op = `BT /F${(i % 2) + 1} 11 Tf 1 0 0 1 ${x.toFixed(2)} 700 Tm [(${run})] TJ ET`;
    x += width(run);
    return op;
  });
  const content = [
    ...line1,
    "BT /F1 11 Tf 1 0 0 1 72 686.6 Tm [(Thank you.)] TJ ET", // next line
    "BT /F1 11 Tf 1 0 0 1 72 650 Tm [(Total)] TJ ET BT /F1 11 Tf 1 0 0 1 400 650 Tm [($120.00)] TJ ET", // a paragraph gap, then two columns
    "BT /F1 11 Tf 1 0 0 1 72 636.6 Tm [(Ref)] TJ ET BT /F1 11 Tf 1 0 0 1 98 636.6 Tm [(no. 55)] TJ ET", // a small gap: a space
    "BT /F1 11 Tf 1 0 0 1 72 623.2 Tm [(H)] TJ ET BT /F1 8 Tf 1 0 0 1 78.6 627 Tm [(2)] TJ ET BT /F1 11 Tf 1 0 0 1 83.4 623.2 Tm [(O)] TJ ET", // a raised digit stays on its line
  ].join("\n");
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content(content))} /Resources << /Font << /F1 ${refs(font)} /F2 ${refs(font)} >> >> >>`);
  const file = b.build(pageTree(b, [page]));
  assert.equal((await readPdf(file))!.text, "Please pay the full amount by Friday.\nThank you.\n\nTotal\t$120.00\nRef no. 55\nH2O");
  // Standard fonts have no widths in the file: a word placed on its own further right is a new word.
  assert.equal((await readPdf(pdf(["BT /F1 12 Tf 72 700 Td (Hello) Tj 28.3 0 Td (World,) Tj 36 0 Td (again and again.) Tj ET"])))!.text, "Hello World, again and again.");
});

test("filled-in form fields (annotation appearances) are read after the page", async () => {
  const b = new PdfBuilder();
  const appearance = b.add("/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Filter /FlateDecode", deflateSync(Buffer.from("/Tx BMC BT /Helv 10 Tf 2 5 Td (Jane Q. Applicant) Tj ET EMC")));
  const checkbox = b.add("/Type /XObject /Subtype /Form /BBox [0 0 10 10]", Buffer.from("BT /ZaDb 8 Tf (4) Tj ET"));
  const field = b.add(`<< /Type /Annot /Subtype /Widget /Rect [150 690 350 710] /AP << /N ${refs(appearance)} >> >>`);
  const box = b.add(`<< /Type /Annot /Subtype /Widget /Rect [150 670 160 680] /AS /Yes /AP << /N << /Yes ${refs(checkbox)} >> >> >>`);
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 700 Td (Applicant name:) Tj ET"))} /Annots [${refs(field, box)}] >>`);
  assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Applicant name:\nJane Q. Applicant");
});

test("PDFs whose page tree can't be used are read in file order", async () => {
  // A page whose content stream is missing: the tree is damaged.
  const b = new PdfBuilder();
  const missing = textPage(b, "Text of the first page in the file, about the lease.");
  const page = b.add(`<< /Type /Page /Contents ${refs(999)} >>`);
  const damaged = b.build(pageTree(b, [page, missing]));
  assert.equal((await readPdf(damaged))!.text, "Text of the first page in the file, about the lease.");
  // An encrypted PDF's objects can't be read: file order (here the streams happen to be plain).
  const e = new PdfBuilder();
  const p1 = textPage(e, "Encrypted file, second in the tree but first in the file.");
  const p2 = textPage(e, "Encrypted file, first in the tree but second in the file.");
  const root = pageTree(e, [p2, p1]);
  const encrypted = pdfUpdate(e.build(root), root, [], " /Encrypt << /Filter /Standard >>");
  assert.equal(
    (await readPdf(encrypted))!.text,
    "Encrypted file, second in the tree but first in the file.\n\nEncrypted file, first in the tree but second in the file.",
  );
});

test("forms with underscore lines count as readable", async () => {
  const text = (await readPdf(pdf(["BT /F1 12 Tf 72 700 Td (Name: ______________________________) Tj 0 -20 Td (Signature: __________________________) Tj 0 -20 Td (Date: ____________ Amount due: $120.00) Tj ET"])))!.text;
  assert.match(text, /^Name: _+\nSignature: _+\nDate: _+ Amount due: \$120\.00$/);
});

test("crafted page trees and object streams stay fast", async () => {
  const cases: Record<string, Buffer> = {};
  // A page tree nested 5,000 levels deep.
  {
    const b = new PdfBuilder();
    let node = textPage(b, "Deep inside a very deep page tree, still readable.");
    for (let i = 0; i < 5000; i++) node = b.add(`<< /Type /Pages /Kids [${refs(node)}] /Count 1 >>`);
    cases["deep tree"] = b.build(b.add(`<< /Type /Catalog /Pages ${refs(node)} >>`));
  }
  // A tree whose nodes list themselves and each other as kids.
  {
    const b = new PdfBuilder();
    const page = textPage(b, "The only real page in a cyclic page tree.");
    const a = b.reserve();
    const c = b.reserve();
    b.set(a, `<< /Type /Pages /Kids [${refs(a, c, page, a)}] /Count 1 >>`);
    b.set(c, `<< /Type /Pages /Kids [${refs(a, c)}] /Count 1 >>`);
    cases["cyclic tree"] = b.build(b.add(`<< /Type /Catalog /Pages ${refs(a)} >>`));
  }
  // Kids arrays with 200,000 entries: the same page over and over, and pages that don't exist.
  {
    const b = new PdfBuilder();
    const page = textPage(b, "One page listed two hundred thousand times.");
    cases["huge Kids, one page"] = b.build(pageTree(b, Array(200_000).fill(page)));
    const m = new PdfBuilder();
    const real = textPage(m, "A real page before many missing ones, in the file.");
    cases["huge Kids, missing pages"] = m.build(pageTree(m, [real].concat(Array.from({ length: 200_000 }, (_, i) => 10_000 + i))));
  }
  // 20,000 pages, all but the first without text (they are listed as one line).
  {
    const b = new PdfBuilder();
    const pages = [textPage(b, "First of twenty thousand mostly empty pages.")];
    for (let i = 1; i < 20_000; i++) pages.push(b.add("<< /Type /Page >>"));
    cases["20,000 pages"] = b.build(pageTree(b, pages));
  }
  // 3,000 object streams (more than are indexed: read in file order) and 1,500 (indexed).
  for (const count of [3000, 1500]) {
    const b = new PdfBuilder();
    const page = textPage(b, "A page whose file has very many object streams.");
    const parts = [b.build(pageTree(b, [page]))];
    for (let i = 0; i < count; i++) {
      const data = deflateSync(Buffer.from(`${50_000 + i} 0 << /Junk ${i} >>`));
      parts.push(Buffer.from(`${20_000 + i} 0 obj\n<< /Type /ObjStm /N 1 /First 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n"));
    }
    cases[`${count} object streams`] = Buffer.concat(parts);
  }
  for (const [name, file] of Object.entries(cases)) {
    const r = await timed(() => readPdf(file));
    assert.ok(r.ms < 200, `${name}: ${r.ms.toFixed(0)} ms`);
    assert.ok(r.value?.text, `${name}: no text`);
  }
});
