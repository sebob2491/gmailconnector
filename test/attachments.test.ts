import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { attachmentCharset, attachmentText } from "../src/format.js";
import { attachmentResult, decodeTextFile, FileTooLargeError, kindOf, officeText, pdfText, readOffice, readPdf, readTextFile, sniffType } from "../src/attachments.js";
import { assertCpu, assertLinear, cmapOf, docx, docxOf, fontResources, hex4, hexString, pdf, PdfBuilder, pdfOf, pdfUpdate, png, pptx, refs, ttf, xlsx, xlsxOf, zip, zipOf } from "./files.js";

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

// CPU bounds: assertLinear checks that doubling the input at most about doubles the cost (with a
// ratio of 1.5: that the cost doesn't grow at all), assertCpu that a call stays under a ceiling at
// least 10 times its usual cost; both take the best of three runs (see test/files.ts).

/** `count` Word paragraphs, each different so the XML compresses like a real document. */
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i}: the quick brown fox ${i * 7919} jumps.</w:t></w:r></w:p>`).join("");

test("decompression bombs fail fast with a clear error instead of exhausting memory", async () => {
  // Bombs of 32 and 64 MB cost the same: nothing past the limits is unpacked.
  const MB = 1024 * 1024;
  // Honest sizes: refused from the compression ratio alone, without inflating anything.
  const { large: honest } = await assertLinear("honest ZIP bomb", (n) => {
    const file = zipOf([{ name: "word/document.xml", data: Buffer.alloc(n, "a") }]);
    return () => readOffice(file);
  }, 32 * MB, 50, 1.5);
  assert.ok(honest.error instanceof FileTooLargeError, String(honest.error));
  assert.match((honest.error as Error).message, /decompression bomb/);
  // A header that lies about the size: inflating stops at the part limit.
  const { large: lying } = await assertLinear("lying ZIP bomb", (n) => {
    const file = zipOf([{ name: "word/document.xml", data: Buffer.alloc(n, "a"), declaredSize: 2000 }]);
    return () => readOffice(file);
  }, 32 * MB, 100, 1.5);
  assert.ok(lying.error instanceof FileTooLargeError, String(lying.error));
  // A PDF stream that unpacks to 64 MB is skipped; the rest of the PDF is still read.
  const { large: read } = await assertLinear("PDF stream bomb", (n) => {
    const b = new PdfBuilder();
    const text = b.content("BT 72 700 Td (Readable statement text for the account holder.) Tj ET");
    const huge = b.add("/Filter /FlateDecode", deflateSync(Buffer.alloc(n, " ")));
    const page = b.add(`<< /Type /Page /Contents [${refs(text, huge)}] >>`);
    const file = b.build(b.add(`<< /Type /Catalog /Pages ${refs(b.add(`<< /Type /Pages /Kids [${refs(page)}] /Count 1 >>`))} >>`));
    return () => readPdf(file);
  }, 32 * MB, 100, 1.5);
  assert.equal(read.value?.text, "Readable statement text for the account holder.");
  assert.match(read.value?.incomplete ?? "", /too large/);
});

test("readers stop once they have maxChars of text", async () => {
  // A 13 MB document.xml: only the first part is unpacked for 20,000 characters (half the file costs the same).
  const files = new Map<number, Buffer>();
  const { large: some } = await assertLinear("docx cut at maxChars", (n) => {
    const file = docxOf(paragraphs(n));
    files.set(n, file);
    return () => readOffice(file, { maxChars: 20_000 });
  }, 100_000, 50, 1.5);
  const big = files.get(200_000)!;
  assert.ok(some.value!.text.length >= 20_000);
  assert.equal(some.value!.more, true);
  assert.equal(some.value!.incomplete, undefined);
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
  // [the file at size n, n, the CPU ceiling in ms for 2n]
  const cases: Record<string, [(n: number) => Buffer, number, number]> = {
    "a million spaces in one string": [(n) => pdf([`BT (${"word ".repeat(10)}) Tj (${" ".repeat(n)}) Tj (end of the line here) Tj ET`]), 500_000, 200],
    "20,000 streams without objects": [(n) => Buffer.from(`%PDF-1.4\n${"stream\nx\nendstream\n".repeat(n)}`, "latin1"), 10_000, 600],
  };
  for (const [name, [build, n, ceiling]] of Object.entries(cases)) {
    await assertLinear(name, (size) => {
      const file = build(size);
      return () => readPdf(file);
    }, n, ceiling);
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
    "--- Sheet: Values ---\n2024-10-01\t2024-10-01 13:30\t$1,234.50\t18:00\t36:00:00\t0.3\tTRUE\tFALSE\t#DIV/0!\ta & b",
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
  const { large: r } = await assertLinear("xlsx cut at maxChars", (n) => {
    const rows = Array.from({ length: n }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>Customer ${r}</t></is></c><c r="B${r + 1}"><v>${r * 7.25}</v></c></row>`);
    const file = xlsxOf({ sheets: [{ name: "Big", data: rows.join("") }, { name: "Next", data: "" }] });
    return () => readOffice(file, { maxChars: 20_000 });
  }, 25_000, 50);
  assert.equal(r.value!.more, true);
  assert.ok(r.value!.text.length >= 20_000 && r.value!.text.length < 21_000, String(r.value!.text.length));
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

test("filled-in form fields (annotation appearances) are read next to their labels", async () => {
  const b = new PdfBuilder();
  const appearance = b.add("/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Filter /FlateDecode", deflateSync(Buffer.from("/Tx BMC BT /Helv 10 Tf 2 5 Td (Jane Q. Applicant) Tj ET EMC")));
  const checkbox = b.add("/Type /XObject /Subtype /Form /BBox [0 0 10 10]", Buffer.from("BT /ZaDb 8 Tf (4) Tj ET"));
  const field = b.add(`<< /Type /Annot /Subtype /Widget /Rect [150 690 350 710] /AP << /N ${refs(appearance)} >> >>`);
  const box = b.add(`<< /Type /Annot /Subtype /Widget /Rect [150 670 160 680] /AS /Yes /AP << /N << /Yes ${refs(checkbox)} >> >> >>`);
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 700 Td (Applicant name:) Tj ET"))} /Annots [${refs(field, box)}] >>`);
  // The value's baseline (695) is 5 below the label's, but the label's baseline is the only one inside the field's rect.
  assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Applicant name: Jane Q. Applicant");
});

/**
 * A form: labels drawn by the page at the given baselines, each with a text field right after it
 * (a rect 18 high, from 5 below the baseline; the value 1 below it), plus a check box; the
 * annotations listed in another order than the page draws its labels.
 */
function formFile(rows: { label: string; x?: number; y: number; value?: string; width?: number }[], extra = "") {
  const b = new PdfBuilder();
  const content = [`BT /F1 16 Tf 72 740 Td (Application form) Tj ET`];
  const fields: number[] = [];
  for (const { label, x = 72, y, value, width = 150 } of rows) {
    content.push(`BT /F1 12 Tf ${x} ${y} Td (${label}) Tj ET`);
    // The default font's guessed widths: 6 points per character at 12 points.
    const left = x + label.length * 6 + 4;
    if (value !== undefined) fields.push(b.widget([left, y - 5, left + width, y + 13], `BT /Helv 10 Tf 2 4 Td (${value}) Tj ET`));
  }
  const checkbox = b.add("/Type /XObject /Subtype /Form /BBox [0 0 10 10]", Buffer.from("BT /ZaDb 8 Tf (4) Tj ET"));
  fields.push(b.add(`<< /Type /Annot /Subtype /Widget /FT /Btn /Rect [200 618 210 628] /AS /Yes /AP << /N << /Yes ${refs(checkbox)} >> >> >>`));
  const page = b.add(`<< /Type /Page /MediaBox [0 0 612 792] /Contents ${refs(b.content(content.join("\n")))} /Annots [${refs(fields.reverse())}]${extra} >>`);
  return b.build(pageTree(b, [page]));
}

const FORM = [
  { label: "Name:", y: 700, value: "Sebastian" },
  { label: "Date:", y: 680, value: "2024-01-05" },
  { label: "City:", y: 660, value: "Springfield", width: 120 },
  { label: "Zip:", x: 300, y: 660, value: "12345", width: 60 },
  { label: "Subscribe to updates", y: 620 },
  { label: "Amount due:", y: 600, value: "$120.00" },
];

test("form field values land on their labels' lines, after the label, in reading order", async () => {
  // Before, the values followed the page's text, in the order the annotations were listed:
  // "Application form\n\nName:\nDate:\nCity:\tZip:\n\nSubscribe to updates\nAmount due:\n$120.00\n12345\nSpringfield\n2024-01-05\nSebastian".
  assert.equal(
    (await readPdf(formFile(FORM)))!.text,
    "Application form\n\nName: Sebastian\nDate: 2024-01-05\nCity: Springfield\tZip: 12345\n\nSubscribe to updates\nAmount due: $120.00",
  );
  // A field without a label of its own (its own line, at its height), and an empty one.
  const rows = [...FORM.slice(0, 2), { label: "", y: 660, value: "Second address line" }, { label: "Phone:", y: 580, value: "" }];
  assert.equal((await readPdf(formFile(rows)))!.text, "Application form\n\nName: Sebastian\nDate: 2024-01-05\nSecond address line\n\nPhone:");
});

test("form fields between lines, over several lines, and on turned pages", async () => {
  // A field whose rect lies between two lines (crossing neither baseline) is a line of its own between them.
  {
    const b = new PdfBuilder();
    const field = b.widget([150, 674, 400, 690], "BT /Helv 10 Tf 2 5 Td (In between) Tj ET");
    const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 700 Td (The line above) Tj 0 -40 Td (The line below) Tj ET"))} /Annots [${refs(field)}] >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "The line above\nIn between\nThe line below");
  }
  // Boxes that sit on the label's line (their rect starts just above its baseline, as LibreOffice draws them): the values
  // are 6.5 points above the labels' baselines, which still lie within the font size of the rects.
  {
    const b = new PdfBuilder();
    const name = b.widget([110, 702.5, 300, 716.3], "BT /Helv 10 Tf 2 4 Td (Sebastian) Tj ET");
    const date = b.widget([110, 682.5, 300, 696.3], "BT /Helv 10 Tf 2 4 Td (2024-01-05) Tj ET");
    const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 700 Td (Name:) Tj 0 -20 Td (Date:) Tj ET"))} /Annots [${refs(name, date)}] >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Name: Sebastian\nDate: 2024-01-05");
  }
  // A multi-line text field: its first line joins the label's, the others follow that line, before the next label, wherever
  // they are; here a tall box whose label sits on its bottom line.
  {
    const b = new PdfBuilder();
    const field = b.widget([140, 602.5, 400, 660], "BT /Helv 10 Tf 12 TL 2 47 Td (First line of the comment) Tj T* (the second line) Tj ET");
    const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 680 Td (Notes) Tj 0 -80 Td (Comments:) Tj 0 -30 Td (Signature:) Tj ET"))} /Annots [${refs(field)}] >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Notes\n\nComments: First line of the comment\nthe second line\n\nSignature:");
  }
  // A multi-line text field: its first line joins the label's, the others follow, before the next label.
  {
    const b = new PdfBuilder();
    const field = b.widget([140, 450, 400, 510], "BT /Helv 10 Tf 12 TL 2 49 Td (First line of the comment) Tj T* (the second line) Tj T* (and the third.) Tj ET");
    const page = b.add(`<< /Type /Page /Contents ${refs(b.content("BT /F1 12 Tf 72 500 Td (Comments:) Tj 0 -70 Td (Signature:) Tj ET"))} /Annots [${refs(field)}] >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Comments: First line of the comment\nthe second line\nand the third.\n\nSignature:");
  }
  // A page turned with /Rotate 90 whose text runs up the page (drawn rotated), and fields whose appearances are rotated
  // by their /Matrix: read as the upright page.
  {
    const b = new PdfBuilder();
    // Text space (x, y) is page space (612 - y, x).
    const content = "q 0 1 -1 0 612 0 cm BT /F1 12 Tf 72 500 Td (Name:) Tj 0 -20 Td (Date:) Tj ET Q";
    const rotated = { bbox: [0, 0, 150, 18], matrix: [0, 1, -1, 0, 0, 0] };
    const name = b.widget([612 - 513, 106, 612 - 495, 256], "BT /Helv 10 Tf 2 4 Td (Sebastian) Tj ET", rotated);
    const date = b.widget([612 - 493, 106, 612 - 475, 256], "BT /Helv 10 Tf 2 4 Td (2024-01-05) Tj ET", rotated);
    const page = b.add(`<< /Type /Page /MediaBox [0 0 612 792] /Rotate 90 /Contents ${refs(b.content(content))} /Annots [${refs(date, name)}] >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "Name: Sebastian\nDate: 2024-01-05");
  }
});

test("text fields whose appearance shows nothing are read from their values (/V), as LibreOffice writes them", async () => {
  const b = new PdfBuilder();
  // LibreOffice's appearances are empty (it sets /NeedAppearances, so viewers draw the values); its boxes sit on the text line.
  const empty = () => b.add("/Type /XObject /Subtype /Form /BBox [0 0 180 13.8]", Buffer.from("/Tx BMC\nEMC\n"));
  const field = (y: number, entries: string, appearance = refs(empty())) =>
    b.add(`<< /Type /Annot /Subtype /Widget /Rect [110 ${y + 2.5} 290 ${y + 16.3}] ${entries}${appearance ? ` /AP << /N ${appearance} >>` : ""} >>`);
  const utf16 = (text: string) => `<FEFF${hexString([...text].map((c) => c.charCodeAt(0))).slice(1, -1)}>`;
  // A field's entries can come from its parent field (the widget is then one of the field's kids).
  const parent = b.add(`<< /FT /Tx /T (date) /V ${utf16("2024-01-05")} /DA (/Helv 10 Tf 0 g) >>`);
  const shown = b.add("/Type /XObject /Subtype /Form /BBox [0 0 180 13.8]", Buffer.from("BT /Helv 10 Tf 2 4 Td (Shown value) Tj ET"));
  const annots = [
    field(700, `/FT /Tx /T (name) /V ${utf16("Sebastian")} /DA (0 0 0 rg /He 10 Tf)`),
    field(680, `/Parent ${refs(parent)}`),
    field(660, "/FT /Tx /T (pin) /Ff 8192 /V (1234)"), // a password field: left out
    field(640, "/FT /Tx /T (city) /V (Caf\\351) /DA (/Helv 0 Tf)", ""), // no appearance at all; PDFDocEncoding; "auto" size
    field(620, "/FT /Tx /T (shown) /V (stale value)", refs(shown)), // the appearance wins
    b.add(`<< /Type /Annot /Subtype /Widget /Rect [110 562.5 400 606] /FT /Tx /Ff 4096 /V (First line of the comment\\rthe second line) /DA (/Helv 10 Tf) /AP << /N ${refs(empty())} >> >>`),
  ];
  const content = [["Name:", 700], ["Date:", 680], ["PIN:", 660], ["City:", 640], ["Shown:", 620], ["Comments:", 560]].map(([label, y]) => `BT /F1 12 Tf 72 ${y} Td (${label}) Tj ET`);
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content(content.join("\n")))} /Annots [${refs(annots)}] >>`);
  assert.equal(
    (await readPdf(b.build(pageTree(b, [page]))))!.text,
    "Name: Sebastian\nDate: 2024-01-05\nPIN:\nCity: Café\nShown: Shown value\n\nComments: First line of the comment\nthe second line",
  );
});

test("pages whose annotations draw no text keep their drawing order", async () => {
  // Lines drawn bottom first, with a link and a check box: as before, in drawing order (not sorted by position).
  const b = new PdfBuilder();
  const content = "BT /F1 12 Tf 72 600 Td (Drawn first, at the bottom.) Tj 0 100 Td (Drawn second, at the top.) Tj ET";
  const link = b.add("<< /Type /Annot /Subtype /Link /Rect [72 595 300 615] /A << /S /URI /URI (https://example.com) >> >>");
  const checkbox = b.add("/Type /XObject /Subtype /Form /BBox [0 0 10 10]", Buffer.from("BT /ZaDb 8 Tf (4) Tj ET"));
  const box = b.add(`<< /Type /Annot /Subtype /Widget /Rect [50 600 60 610] /AS /Yes /AP << /N << /Yes ${refs(checkbox)} >> >> >>`);
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content(content))} /Annots [${refs(link, box)}] >>`);
  const expected = "Drawn first, at the bottom.\n\nDrawn second, at the top.";
  assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, expected);
  assert.equal((await readPdf(pdf([content])))!.text, expected);
  // Past 20,000 pieces to place (runs, or runs that follow each other), a page with a filled-in field is read in drawing order:
  // the value after the page.
  const c = new PdfBuilder();
  const field = c.widget([150, 695, 350, 713], "BT /Helv 10 Tf 2 4 Td (Sebastian) Tj ET");
  const many = c.add(`<< /Type /Page /Contents ${refs(c.content(`BT /F1 12 Tf 72 700 Td (Name:) Tj ET BT /F1 12 Tf 72 500 Td ${"(x) Tj 40 0 Td ".repeat(20_000)}ET`))} /Annots [${refs(field)}] >>`);
  assert.equal((await readPdf(c.build(pageTree(c, [many])), { maxChars: 0 }))!.text, `Name:\n\n${Array(20_000).fill("x").join("\t")}\nSebastian`);
});

test("placing form fields by position stays cheap: 480 fields, and the most runs sorted", async () => {
  // 480 fields in columns of 60, and a check box (of the 500 annotations read per page): the count is bounded, so is the cost.
  const file = formFile(Array.from({ length: 480 }, (_, i) => ({ label: `F${i}:`, y: 710 - (i % 60) * 11, x: 20 + Math.floor(i / 60) * 72, value: `v${i}`, width: 30 })));
  const r = await assertCpu("480 form fields", () => readPdf(file, { maxChars: 0 }), 1000);
  assert.match(r.value!.text, /^Application form\n\nF0: v0\tF60: v60\t[^\n]* F420: v420\nF1: v1\tF61: v61\t/);
  // About 10,000 and 20,000 runs far apart (each a piece of its own: 20,000 is the most placed by position) on a page with a field.
  const { large: runs } = await assertLinear("runs with a field", (n) => {
    const c = new PdfBuilder();
    const field = c.widget([150, 695, 350, 713], "BT /Helv 10 Tf 2 4 Td (Sebastian) Tj ET");
    const lines = Array.from({ length: n / 10 }, (_, i) => `1 0 0 1 72 ${690 - (i % 60) * 10} Tm ${"(ab) Tj 40 0 Td ".repeat(10)}`).join("\n");
    const page = c.add(`<< /Type /Page /Contents ${refs(c.content(`BT /F1 12 Tf 72 700 Td (Name:) Tj ${lines} ET`))} /Annots [${refs(field)}] >>`);
    const file = c.build(pageTree(c, [page]));
    return () => readPdf(file, { maxChars: 0 });
  }, 9_990, 300);
  assert.match(runs.value!.text, /^Name:\tSebastian\n(ab)+\t(ab)+\t/);
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
  // [the file at size n, n, the CPU ceiling in ms for 2n]
  const cases: Record<string, [(n: number) => Buffer, number, number]> = {
    // A page tree nested 5,000 levels deep.
    "deep tree": [
      (n) => {
        const b = new PdfBuilder();
        let node = textPage(b, "Deep inside a very deep page tree, still readable.");
        for (let i = 0; i < n; i++) node = b.add(`<< /Type /Pages /Kids [${refs(node)}] /Count 1 >>`);
        return b.build(b.add(`<< /Type /Catalog /Pages ${refs(node)} >>`));
      },
      2500,
      150,
    ],
    // A tree whose nodes list themselves and each other as kids, n times.
    "cyclic tree": [
      (n) => {
        const b = new PdfBuilder();
        const page = textPage(b, "The only real page in a cyclic page tree.");
        const a = b.reserve();
        const c = b.reserve();
        b.set(a, `<< /Type /Pages /Kids [${refs(a, c, page, a)}${` ${refs(a, c)}`.repeat(n)}] /Count 1 >>`);
        b.set(c, `<< /Type /Pages /Kids [${refs(a, c)}] /Count 1 >>`);
        return b.build(b.add(`<< /Type /Catalog /Pages ${refs(a)} >>`));
      },
      50_000,
      1200,
    ],
    // Kids arrays with 200,000 entries: the same page over and over, and pages that don't exist.
    "huge Kids, one page": [
      (n) => {
        const b = new PdfBuilder();
        const page = textPage(b, "One page listed two hundred thousand times.");
        return b.build(pageTree(b, Array(n).fill(page)));
      },
      100_000,
      1200,
    ],
    "huge Kids, missing pages": [
      (n) => {
        const m = new PdfBuilder();
        const real = textPage(m, "A real page before many missing ones, in the file.");
        return m.build(pageTree(m, [real].concat(Array.from({ length: n }, (_, i) => 10_000 + i))));
      },
      100_000,
      2000,
    ],
    // 20,000 pages, all but the first without text (they are listed as one line).
    "20,000 pages": [
      (n) => {
        const b = new PdfBuilder();
        const pages = [textPage(b, "First of twenty thousand mostly empty pages.")];
        for (let i = 1; i < n; i++) pages.push(b.add("<< /Type /Page >>"));
        return b.build(pageTree(b, pages));
      },
      10_000,
      1400,
    ],
    // 1,000 and 2,000 object streams (indexed); 3,000 and 6,000 (more than are indexed: read in file order).
    "object streams, indexed": [(n) => objectStreams(n), 1000, 600],
    "object streams, past the index": [(n) => objectStreams(n), 3000, 600],
  };
  for (const [name, [build, n, ceiling]] of Object.entries(cases)) {
    const { small, large } = await assertLinear(name, (size) => {
      const file = build(size);
      return () => readPdf(file);
    }, n, ceiling);
    assert.ok(small.value?.text && large.value?.text, `${name}: no text`);
  }
});

/** A file with one text page and `count` object streams. */
function objectStreams(count: number): Buffer {
  const b = new PdfBuilder();
  const page = textPage(b, "A page whose file has very many object streams.");
  const parts = [b.build(pageTree(b, [page]))];
  for (let i = 0; i < count; i++) {
    const data = deflateSync(Buffer.from(`${50_000 + i} 0 << /Junk ${i} >>`));
    parts.push(Buffer.from(`${20_000 + i} 0 obj\n<< /Type /ObjStm /N 1 /First 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n"));
  }
  return Buffer.concat(parts);
}

// ---------- PDF fonts ----------

/** Glyph codes of the composite test fonts: the character code plus 0x100, and three special glyphs. */
const LIGATURE = 0x201;
const EMOJI = 0x202;
const NOTHING = 0x203;
const glyphCodes = (text: string) =>
  hexString([...text].map((ch) => (ch === "ﬃ" ? LIGATURE : ch === "😀" ? EMOJI : ch === "\0" ? NOTHING : ch.charCodeAt(0) + 0x100)));
/** A ToUnicode CMap for those codes, using every form: bfchar, bfrange counting up, and bfrange with an array. */
const glyphCMap = () =>
  cmapOf({
    bfchar: [
      [hex4(0x120), "0020"],
      [hex4(0x12e), "002E"],
      [hex4(0x12c), "002C"],
      [hex4(0x13a), "003A"],
      [hex4(0x121), "0021"],
      [hex4(LIGATURE), "006600660069"],
      [hex4(EMOJI), "D83DDE00"],
      [hex4(NOTHING), "0000"],
    ],
    bfrange: [
      [hex4(0x141), hex4(0x15a), "0041"],
      [hex4(0x161), hex4(0x17a), "0061"],
      [hex4(0x130), hex4(0x139), Array.from({ length: 10 }, (_, i) => hex4(0x30 + i))],
    ],
  });

test("Type0 fonts with ToUnicode CMaps come out as text", async () => {
  const content = [
    `BT /F1 12 Tf 72 700 Td ${glyphCodes("Invoice 2024: oﬃce supplies, total 42.00 😀")} Tj ET`,
    // In a TJ array a negative adjustment moves right (a word gap), a positive one kerns; <0000> glyphs show nothing.
    `BT /F1 12 Tf 72 680 Td [${glyphCodes("Thank")} -300 ${glyphCodes("you")} 40 ${glyphCodes("\0!")}] TJ ET`,
  ].join("\n");
  const file = pdf([content], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(glyphCMap()) }) }));
  // The ligature glyph maps to three characters, the emoji glyph to a surrogate pair.
  assert.equal((await readPdf(file))!.text, "Invoice 2024: office supplies, total 42.00 😀\nThank you!");
});

test("composite fonts with other encodings: mixed-width codespaces, and codes that are UCS-2", async () => {
  // A Shift-JIS-like codespace: one-byte codes up to 0x80, two-byte codes from 0x8140; the ToUnicode CMap covers both.
  const mixed = cmapOf({
    codespace: [
      ["00", "80"],
      ["8140", "FFFF"],
    ],
    bfrange: [["41", "5A", "0041"]],
    bfchar: [
      ["20", "0020"],
      ["8140", "3042"],
      ["8141", "3044"],
    ],
  });
  const ucs2 = hexString(Array.from("Payment received 😀".split(""), (unit) => unit.charCodeAt(0)));
  const content = ["BT /F1 12 Tf 72 700 Td <4142434445464748494A20814081414B4C4D> Tj ET", `BT /F2 12 Tf 72 680 Td ${ucs2} Tj ET`].join("\n");
  const file = pdf([content], [], (b) => ({
    F1: b.type0Font({ encoding: "/90ms-RKSJ-H", ordering: "Japan1", toUnicode: b.cmap(mixed) }),
    // A predefined Unicode CMap and no ToUnicode: the codes themselves are UTF-16BE.
    F2: b.type0Font({ encoding: "/UniJIS-UCS2-H", ordering: "Japan1" }),
  }));
  assert.equal((await readPdf(file))!.text, "ABCDEFGHIJ あいKLM\nPayment received 😀");
});

test("simple fonts: /Differences, MacRoman, Standard and ToUnicode encodings", async () => {
  const toUnicode = cmapOf({ codespace: [["00", "FF"]], bfchar: [["01", "0048"], ["02", "0069"]], bfrange: [["03", "05", "0061"]] });
  const lines = [
    // Differences on a WinAnsi base: AGL names, uniXXXX, uXXXXX, a ligature of parts, a variant; /g12 says nothing (the base stays).
    "/F1 12 Tf (Caf\\202 \\203 \\310 \\311 \\312 \\313 \\314 \\315 \\316 \\317 \\320 \\321 \\200 summary) Tj",
    "/F2 12 Tf (caf\\216\\312\\245 \\320 \\336 bullets) Tj",
    "/F3 12 Tf (\\256 \\267 \\320 \\244 and \\252quotes\\272) Tj",
    "/F4 12 Tf (\\001\\002 \\003\\004\\005 there) Tj",
    "/F5 12 Tf (na\\357ve \\223quoted\\224) Tj",
  ];
  const content = `BT 72 700 Td 16 TL ${lines.join(" T* ")} ET`;
  const file = pdf([content], [], (b) => ({
    F1: b.simpleFont({ encoding: "<< /Differences [128 /Euro 130 /eacute /quoteright 200 /endash /emdash /bullet /fi /fl /uni00E9 /u1F600 /g12 /f_f_i /a.sc] >>" }),
    F2: b.simpleFont({ encoding: "/MacRomanEncoding" }),
    F3: b.simpleFont({ subtype: "Type1", base: "Times-Roman", encoding: "/StandardEncoding" }),
    F4: b.simpleFont({ toUnicode: b.cmap(toUnicode) }),
    F5: b.simpleFont({ encoding: "<< /BaseEncoding /WinAnsiEncoding >>" }),
  }));
  assert.equal(
    (await readPdf(file))!.text,
    [
      "Café ’ – — • ﬁ ﬂ é 😀 Ï ffi a € summary",
      "café • – ﬁ bullets",
      "ﬁ • — ⁄ and “quotes”",
      "Hi abc there",
      "naïve “quoted”",
    ].join("\n"),
  );
});

test("mixed fonts on one line keep their word spacing (CID widths from /W and /DW)", async () => {
  const b = new PdfBuilder();
  // The composite font's widths: capitals 700 (a range), lower case 500 (a list), digits 550, the period 300, the rest 250 (a wide range beats /DW).
  const w = `321 346 700 353 [${Array(26).fill(500).join(" ")}] 304 313 550 302 [300] 0 65535 250`;
  const cmap = b.cmap(glyphCMap());
  const cid = b.type0Font({ toUnicode: cmap, w, dw: 1000 });
  const fixed = b.type0Font({ toUnicode: cmap, dw: 600, base: "Inter-Mono" });
  const simple = b.simpleFont({ widths: Array.from({ length: 95 }, (_, i) => (i === 0 ? 300 : 600)).join(" ") });
  const cidWidth = (ch: string) => (/[A-Z]/.test(ch) ? 700 : /[a-z]/.test(ch) ? 500 : /[0-9]/.test(ch) ? 550 : ch === "." ? 300 : 250);
  const width = (text: string, of: (ch: string) => number) => [...text].reduce((sum, ch) => sum + (of(ch) * 12) / 1000, 0);
  const at = (x: number, y: number, font: string, shown: string) => `BT /${font} 12 Tf 1 0 0 1 ${x.toFixed(3)} ${y} Tm ${shown} Tj ET`;
  // Line 1: a word drawn glyph by glyph (each Td moving by the glyph's width, as Skia does), a word in a simple font, a number.
  let x = 72;
  const glyphs = [..."Invoice"].map((ch, i) => {
    const op = i === 0 ? `BT /F1 12 Tf 1 0 0 1 72 700 Tm ${glyphCodes(ch)} Tj` : `${width("Invoice"[i - 1], cidWidth).toFixed(3)} 0 Td ${glyphCodes(ch)} Tj`;
    x += width(ch, cidWidth);
    return op;
  });
  const line1 = [`${glyphs.join(" ")} ET`, at(x + 3.5, 700, "F2", "(total)"), at(x + 3.5 + width("total", (ch) => (ch === " " ? 300 : 600)) + 3.5, 700, "F1", glyphCodes("42.00"))];
  // Line 2: runs that start exactly where the previous one ends are joined; /DW gives the mono font's widths.
  x = 72;
  const line2 = [at(x, 684, "F1", glyphCodes("Pre")), at((x += width("Pre", cidWidth)), 684, "F2", "(paid)")];
  x += width("paid", () => 600) + 3.5;
  line2.push(at(x, 684, "F3", glyphCodes("now")), at(x + width("now", () => 600), 684, "F1", glyphCodes(".")));
  // The fonts are inherited from the page tree node.
  const page = b.add(`<< /Type /Page /Contents ${refs(b.content([...line1, ...line2].join("\n")))} >>`);
  const file = b.build(pageTree(b, [page], ` /Resources << /Font << ${fontResources({ F1: cid, F2: simple, F3: fixed })} >> >>`));
  assert.equal((await readPdf(file))!.text, "Invoice total 42.00\nPrepaid now.");
});

test("composite fonts without a ToUnicode CMap report no readable text, not gibberish", async () => {
  const codes = hexString([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 36, 37, 38, 39, 40, 41, 42]);
  // Identity-H with glyph indexes: the bytes say nothing about the characters.
  assert.equal(await pdfText(pdf([`BT /F1 12 Tf 72 700 Td ${codes} Tj ET`], [], (b) => ({ F1: b.type0Font() }))), undefined);
  // A CID-keyed font with a known character collection: its text would need that collection's tables.
  assert.equal(await pdfText(pdf([`BT /F1 12 Tf 72 700 Td ${codes} Tj ET`], [], (b) => ({ F1: b.type0Font({ ordering: "Japan1" }) }))), undefined);
  // Next to a readable font, such a font's text is left out rather than shown as gibberish.
  const mixed = pdf([`BT /F2 12 Tf 72 700 Td (Readable text in a plain font.) Tj ET BT /F1 12 Tf 72 680 Td ${codes} Tj ET`], [], (b) => ({
    F1: b.type0Font({ ordering: "Japan1" }),
    F2: b.simpleFont({ encoding: "/WinAnsiEncoding" }),
  }));
  assert.equal(await pdfText(mixed), "Readable text in a plain font.");
});

test("hostile ToUnicode CMaps stay fast and bounded", async () => {
  const letters = Array.from({ length: 26 }, (_, i) => [hex4(0x161 + i), hex4(0x61 + i)] as [string, string]);
  letters.push([hex4(0x120), "0020"]);
  const sentence = (offset: number) => hexString([..."the quick brown fox jumps over the lazy dog"].map((ch) => ch.charCodeAt(0) + offset));
  // Each CMap is built with n and 2n of its entries (the first read, which warms up the parser, isn't counted).
  const cases: Record<string, { cmap: (n: number) => string; n: number; ceiling: number; codes: string }> = {
    "100,000 bfchar entries": {
      cmap: (n) => cmapOf({ bfchar: [...letters, ...Array.from({ length: n }, (_, i) => [hex4(0x1000 + (i % 0xe000)), "0041"] as [string, string])] }),
      n: 50_000,
      ceiling: 300,
      codes: sentence(0x100),
    },
    // Each range maps every code c to U+0001 + c (so the letters still come out right); the mappings kept are capped.
    "a bfrange over every code, 1,000 times": {
      cmap: (n) => cmapOf({ bfchar: letters, bfrange: Array.from({ length: n }, () => ["0000", "FFFF", "0001"] as [string, string, string]) }),
      n: 500,
      ceiling: 200,
      codes: sentence(-1),
    },
    "ranges with lo > hi and over 65,536 codes": {
      cmap: (n) =>
        cmapOf({
          bfchar: letters,
          bfrange: Array.from({ length: n }, () => [
            ["FFFF", "0000", "0041"],
            ["00000000", "7FFFFFFF", "0041"],
            ["0100", "0010", "0042"],
          ] as [string, string, string][]).flat(),
        }),
      n: 10_000,
      ceiling: 100,
      codes: sentence(0x100),
    },
    "damaged syntax": {
      cmap: (n) => cmapOf({ bfchar: letters, junk: "beginbfrange <01> [ <02> endbfrange <<< ]] /x (stray) 42 ] [ >> <0102> <01> /uni0041 beginbfchar ".repeat(n) }),
      n: 5000,
      ceiling: 150,
      codes: sentence(0x100),
    },
  };
  for (const [name, { cmap, n, ceiling, codes }] of Object.entries(cases)) {
    const { small, large } = await assertLinear(name, (size) => {
      const file = pdf([`BT /F1 12 Tf 72 700 Td ${codes} Tj ET`], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(cmap(size)) }) }));
      return () => readPdf(file);
    }, n, ceiling);
    assert.equal(small.value?.text, "the quick brown fox jumps over the lazy dog", name);
    assert.equal(large.value?.text, "the quick brown fox jumps over the lazy dog", name);
  }
  // A CMap that inflates to 3 MB is past the limit: its font is unreadable, the page (and the rest) is still read, with no note.
  const huge = cmapOf({ bfchar: letters, junk: "% ".padEnd(3 * 1024 * 1024, "x") });
  const file = pdf([`q BT /F1 12 Tf ET Q BT 72 700 Td (Readable text in the default font.) Tj ET BT /F1 12 Tf 72 680 Td ${sentence(0x100)} Tj ET`], [], (b) => ({
    F1: b.type0Font({ toUnicode: b.cmap(huge) }),
  }));
  const r = await assertCpu("3 MB CMap", () => readPdf(file), 50);
  assert.equal(r.value, undefined);
  const unused = pdf(["q BT /F1 12 Tf ET Q BT 72 700 Td (Readable text in the default font.) Tj ET"], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(huge) }) }));
  assert.deepEqual(await readPdf(unused), { text: "Readable text in the default font." });
});

test("PDFs with ordinary WinAnsi fonts read as before", async () => {
  const shown = "(Caf\\351 \\223quoted\\224 \\200 5 \\226 dash) Tj";
  const content = `BT 72 700 Td 16 TL /F1 12 Tf ${shown} T* /F2 12 Tf ${shown} T* /F3 12 Tf ${shown} T* /F9 12 Tf ${shown} ET`;
  const file = pdf([content], [], (b) => ({
    F1: b.simpleFont({ encoding: "/WinAnsiEncoding", widths: Array(224).fill(500).join(" ") }),
    F2: b.simpleFont({ subtype: "Type1", base: "Helvetica" }),
    F3: b.simpleFont({ subtype: "TrueType", base: "ABCDEF+Calibri", extra: " /FontDescriptor << /Type /FontDescriptor /Flags 32 >>" }),
  }));
  const line = "Café “quoted” € 5 – dash";
  assert.equal((await readPdf(file))!.text, [line, line, line, line].join("\n"));
});

// ---------- embedded font programs ----------

/** A font whose cmap names glyphs 1-5 A-E (two code points for A: the first wins), glyph 6 drawn as glyph 4, glyph 8 an emoji. */
const FONT = () => ttf({ cmap: { 0x41: 1, 0x42: 2, 0x43: 3, 0x44: 4, 0x45: 5, 0xff21: 1, 0x1f600: 8 }, composites: { 6: 4 }, numGlyphs: 10 });

test("glyphs a ToUnicode CMap leaves out or maps to <0000> are read from the embedded TrueType font", async () => {
  // The CMap knows A and E, says glyph 2 has no character (what Skia writes for variants) and leaves 3, 6 and 8 out.
  const cmap = cmapOf({ bfchar: [["0001", "0041"], ["0002", "0000"], ["0005", "0045"]] });
  const text = hexString([1, 2, 3, 6, 5, 7, 8, 1, 2, 3, 6, 5, 1, 2, 3, 6, 5, 1, 2, 3, 6, 5]);
  const file = pdf([`BT /F1 12 Tf 72 700 Td ${text} Tj ET`], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(cmap), fontFile: FONT() }) }));
  // Glyph 7 is in no table: nothing. The cmap's format 12 subtable gives the emoji.
  assert.equal((await readPdf(file))!.text, "ABCDE😀ABCDEABCDEABCDE");
  // Without the font program, the same page gives only what the CMap knows ("AEAEAEAE": too little to count as text).
  const plain = pdf([`BT /F1 12 Tf 72 700 Td ${text} Tj ET`], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(cmap) }) }));
  assert.equal(await pdfText(plain), undefined);
});

test("Identity-H fonts without a ToUnicode CMap are read through the embedded font's cmap", async () => {
  const text = hexString([1, 2, 3, 6, 5, 8, 1, 2, 3, 6, 5, 1, 2, 3, 6, 5, 1, 2, 3, 6, 5]);
  const direct = pdf([`BT /F1 12 Tf 72 700 Td ${text} Tj ET`], [], (b) => ({ F1: b.type0Font({ fontFile: FONT() }) }));
  assert.equal((await readPdf(direct))!.text, "ABCDE😀ABCDEABCDEABCDE");
  // A /CIDToGIDMap stream: CIDs 1-5 are glyphs 5-1.
  const cidToGid = Buffer.from([0, 0, 0, 5, 0, 4, 0, 3, 0, 2, 0, 1]);
  const mapped = pdf([`BT /F1 12 Tf 72 700 Td ${hexString([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5])} Tj ET`], [], (b) => ({
    F1: b.type0Font({ fontFile: FONT(), cidToGid }),
  }));
  assert.equal((await readPdf(mapped))!.text, "EDCBAEDCBAEDCBAEDCBA");
  // A font program without a cmap, or not TrueType, leaves such a font unreadable, as before.
  for (const fontFile of [ttf({ cmap: { 0x41: 1 }, tables: ["head", "maxp", "glyf", "loca"] }), Buffer.from("OTTO" + "\0".repeat(200), "latin1")]) {
    assert.equal(await pdfText(pdf([`BT /F1 12 Tf 72 700 Td ${text} Tj ET`], [], (b) => ({ F1: b.type0Font({ fontFile }) }))), undefined);
  }
});

test("damaged or oversized font programs never fail a page", async () => {
  const text = hexString(Array(12).fill([1, 2, 3]).flat());
  const cmap = cmapOf({ bfchar: [["0001", "0041"], ["0002", "0000"], ["0003", "0043"]] });
  const good = FONT();
  const programs: Record<string, Buffer> = {
    "cmap offsets past the end": Buffer.concat([good.subarray(0, 12), Buffer.from("cmap\0\0\0\0\0\0\xff\xff\0\0\x10\0", "latin1"), good.subarray(28)]),
    "random bytes behind a TrueType header": Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 9]), randomBytes(2000)]),
    "a 1.5 MB font": Buffer.concat([good, Buffer.alloc(1.5 * 1024 * 1024)]),
    "a table count of 65,535": Buffer.concat([Buffer.from([0, 1, 0, 0, 0xff, 0xff]), good.subarray(6)]),
  };
  for (const [name, fontFile] of Object.entries(programs)) {
    const file = pdf([`BT /F1 12 Tf 72 700 Td ${text} Tj ET`], [], (b) => ({ F1: b.type0Font({ toUnicode: b.cmap(cmap), fontFile }) }));
    const r = await assertCpu(name, () => readPdf(file), 50);
    assert.equal(r.error, undefined, name);
    assert.equal(r.value?.text, "AC".repeat(12), name);
  }
});

// ---------- regressions from fuzzing ----------

test("text after a form XObject keeps its place, whatever the form's length", async () => {
  // Before, the page's tokenizer resumed at the form's length: text after Do was skipped (a long form) or read twice (a short one).
  for (const padding of [600, 1]) {
    const b = new PdfBuilder();
    const form = b.add("/Type /XObject /Subtype /Form /BBox [0 0 612 792]", Buffer.from(`BT /F1 12 Tf 72 686 Td (from the form) Tj ET\n${"% padding\n".repeat(padding)}`));
    const content = b.content("BT /F1 12 Tf 72 700 Td (one) Tj ET /Fx Do BT /F1 12 Tf 72 672 Td (two) Tj 0 -14 Td (three) Tj 0 -14 Td (four) Tj ET");
    const page = b.add(`<< /Type /Page /Contents ${refs(content)} /Resources << /XObject << /Fx ${refs(form)} >> >> >>`);
    assert.equal((await readPdf(b.build(pageTree(b, [page]))))!.text, "one\nfrom the form\ntwo\nthree\nfour");
  }
});

test("a content stream shared by many pages is decoded once, and reading stops within the budgets", async () => {
  // 3,000 pages share one stream that unpacks to 8 MB: it is inflated once, read a few times (the byte budget), then the file is cut.
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (shared content stream text) Tj ET\n${"% padding comment line\n".repeat(350_000)}`));
  const { large: shared } = await assertLinear("shared stream", (n) => {
    const b = new PdfBuilder();
    const contents = b.add("/Filter /FlateDecode", stream);
    const pages = Array.from({ length: n }, () => b.add(`<< /Type /Page /Contents ${refs(contents)} >>`));
    const file = b.build(pageTree(b, pages));
    return () => readPdf(file);
  }, 1500, 1000);
  assert.match(shared.value!.text, /^--- Page 1 ---\nshared content stream text/);
  assert.match(shared.value!.incomplete ?? "", /too large/);
  // One page whose /Contents array names the same small stream 20,000 times.
  const { large: repeated } = await assertLinear("repeated stream", (n) => {
    const c = new PdfBuilder();
    const small = c.content("BT /F1 12 Tf 72 720 Td (again) Tj ET");
    const page = c.add(`<< /Type /Page /Contents [${refs(Array(n).fill(small))}] >>`);
    const file = c.build(pageTree(c, [page]));
    return () => readPdf(file, { maxChars: 20_000 });
  }, 10_000, 200);
  assert.match(repeated.value!.text, /^(again){100}/);
});

test("PDFs missing their endobj keywords are indexed in linear time", async () => {
  const { large: r } = await assertLinear("no endobj", (n) => {
    const b = new PdfBuilder();
    const pages = Array.from({ length: n }, (_, i) => textPage(b, `Page ${i} of a file whose endobj keywords are gone.`));
    const file = Buffer.from(b.build(pageTree(b, pages)).toString("latin1").replaceAll("endobj", "      "), "latin1");
    return () => readPdf(file, { maxChars: 20_000 });
  }, 2500, 500);
  assert.match(r.value!.text, /Page 0 of a file/);
  // A million headers (no bodies) are given up on quickly: the file is read in file order instead (no text).
  const { large: headers } = await assertLinear("headers", (n) => {
    const file = Buffer.from(`%PDF-1.4\n${"1 0 obj\n".repeat(n)}`);
    return () => readPdf(file);
  }, 500_000, 4000);
  assert.equal(headers.value, undefined);
});

test("content streams built to amplify (nested parentheses, escapes, hex starts, huge TJ arrays) stay cheap", async () => {
  // Each is built at half and at full size: [the content at size n, n, the CPU ceiling in ms for 2n]
  const cases: Record<string, [(n: number) => string, number, number]> = {
    "4 MB of '('": [(n) => `BT (${"(".repeat(n)}) Tj ET`, 2_000_000, 500],
    "4 MB of escapes": [(n) => `BT (${"\\n".repeat(n)}) Tj ET`, 1_000_000, 1500],
    "1M hex starts": [(n) => `BT ${"<4".repeat(n)} ET`, 500_000, 200],
    "a TJ array of 1M elements": [(n) => `BT /F1 12 Tf 72 720 Td [${"(a)-1".repeat(n)}] TJ ET`, 250_000, 400],
  };
  for (const [name, [content, n, ceiling]] of Object.entries(cases)) {
    const { large: r } = await assertLinear(name, (size) => {
      const file = pdf([`BT /F1 12 Tf 72 700 Td (Readable text before the trap in this file.) Tj ET\n${content(size)}`]);
      return () => readPdf(file);
    }, n, ceiling);
    assert.equal(r.error, undefined, name);
    assert.match(r.value?.text ?? "", /^Readable text before the trap/, name);
  }
  // Past the token budget, a file is cut with a note rather than read on.
  const b = new PdfBuilder();
  const busy = b.add("/Filter /FlateDecode", deflateSync(Buffer.from("0 0 m 1 1 l S\n".repeat(500_000))));
  const page = b.add(`<< /Type /Page /Contents [${refs(b.content("BT /F1 12 Tf 72 700 Td (Before more than eight million drawing tokens.) Tj ET"), busy, busy, busy)}] >>`);
  const r = await readPdf(b.build(pageTree(b, [page])));
  assert.equal(r!.text, "Before more than eight million drawing tokens.");
  assert.match(r!.incomplete ?? "", /too complex/);
});

test("spreadsheets with huge runs of empty rows or cells are read in linear time", async () => {
  // 100,000 empty rows, then text: one line says so (as for missing rows).
  const { large: rows } = await assertLinear("empty rows", (n) => {
    const file = xlsxOf({ sheets: [{ name: "S", data: `${Array.from({ length: n }, (_, i) => `<row r="${i + 1}"/>`).join("")}<row r="${n + 1}"><c t="inlineStr"><is><t>text</t></is></c></row>` }] });
    return () => readOffice(file);
  }, 50_000, 500);
  assert.equal(rows.value!.text, "--- Sheet: S ---\n(rows 1–100000 are empty)\ntext");
  // 40,000 empty cells, then text: the text lands in Excel's last column.
  const { large: cells } = await assertLinear("empty cells", (n) => {
    const file = xlsxOf({ sheets: [{ name: "S", data: `<row r="1">${"<c/>".repeat(n)}<c t="inlineStr"><is><t>text</t></is></c></row>` }] });
    return () => readOffice(file);
  }, 100_000, 200);
  assert.equal(cells.value!.text, `--- Sheet: S ---\n${"\t".repeat(16_383)}text`);
  // A Word table row of 2,000 cells spanning 64 columns each, then text.
  const { large: table } = await assertLinear("table row", (n) => {
    const file = docxOf(`<w:tbl><w:tr>${'<w:tc><w:tcPr><w:gridSpan w:val="64"/></w:tcPr></w:tc>'.repeat(n)}<w:tc><w:p><w:r><w:t>text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`);
    return () => readOffice(file);
  }, 1000, 100);
  assert.equal(table.value!.text, "text"); // the row's leading tabs are leading white space of the document
});

test("number format codes are read in linear time, and only so far", async () => {
  for (const [unit, n, shown, ceiling] of [["[", 500_000, "45000", 50], ["[h", 250_000, "00:00", 50], ['"', 500_000, "45000", 500]] as const) {
    const { small, large } = await assertLinear(`format code ${unit}…`, (size) => {
      const code = unit.repeat(size);
      const file = xlsxOf({ sheets: [{ name: "S", data: '<row r="1"><c s="1"><v>45000</v></c></row>' }], styles: `<numFmts><numFmt numFmtId="164" formatCode="${code.replace(/"/g, "&quot;")}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>` });
      return () => readOffice(file);
    }, n, ceiling);
    assert.equal(small.value!.text, `--- Sheet: S ---\n${shown}`);
    assert.equal(large.value!.text, `--- Sheet: S ---\n${shown}`);
  }
});

test("simple number formats are applied: percent, currency, thousands, built-in ones", async () => {
  const file = xlsxOf({
    styles:
      `<numFmts><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="166" formatCode="#,##0.00 &quot;EUR&quot;;[Red]-#,##0.00"/><numFmt numFmtId="167" formatCode="0.00E+00"/><numFmt numFmtId="168" formatCode="0.${"0".repeat(150)}"/></numFmts>` +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="9"/><xf numFmtId="3"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="4"/><xf numFmtId="168"/></cellXfs>',
    sheets: [
      {
        name: "S",
        data:
          '<row r="1"><c s="1"><v>0.085</v></c><c s="2"><v>1234.5</v></c><c s="3"><v>0.5</v></c><c s="4"><v>1234567</v></c><c s="5"><v>-98765.432</v></c><c s="6"><v>12345</v></c><c s="7"><v>-0.001</v></c><c s="8"><v>1.5</v></c></row>',
      },
    ],
  });
  // Decimals are capped at 20 (a format asking for 150 is nonsense).
  assert.equal((await readOffice(file)).text, `--- Sheet: S ---\n8.5%\t$1,234.50\t50%\t1,234,567\t-98,765.43 EUR\t12345\t0.00\t1.5${"0".repeat(19)}`);
});

test("odd row numbers and serial 60 are shown sensibly", async () => {
  const file = xlsxOf({
    styles: '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>',
    sheets: [
      {
        name: "S",
        data:
          '<row r="1000000000000000000"><c t="inlineStr"><is><t>a</t></is></c></row><row r="1"><c t="inlineStr"><is><t>b</t></is></c></row>' +
          '<row r="Infinity"><c t="inlineStr"><is><t>c</t></is></c></row><row r="5"><c s="1"><v>60</v></c><c s="1"><v>59</v></c><c s="1"><v>61</v></c></row>',
      },
    ],
  });
  assert.equal((await readOffice(file)).text, "--- Sheet: S ---\na\nb\nc\n\n1900-02-29\t1900-02-28\t1900-03-01");
});

test("a stray closing tag in Word markup doesn't hide the text after it", async () => {
  assert.equal(await officeText(docxOf("</w:del><w:p><w:r><w:t>visible</w:t></w:r></w:p></mc:Fallback><w:p><w:r><w:t>still visible</w:t></w:r></w:p>")), "visible\nstill visible");
  // Runs of empty paragraphs don't eat the text budget.
  assert.equal(await officeText(docxOf(`${"<w:p/>".repeat(1_000_000)}<w:p><w:r><w:t>end</w:t></w:r></w:p>`)), "end");
});

test("a million character references in a Word document are decoded cheaply", async () => {
  const { large: r } = await assertLinear("entities", (n) => {
    const file = docxOf(`<w:p><w:r><w:t>${"&#x41;".repeat(n)}&#x1F600;&amp;&#65;&bogus;&#xZZ;</w:t></w:r></w:p>`);
    return () => readOffice(file);
  }, 500_000, 700);
  assert.equal(r.value!.text, `${"A".repeat(1_000_000)}😀&A&bogus;&#xZZ;`);
});

test("HTML attachments are converted only up to 4 MB, whatever maxChars asks", () => {
  const html = Buffer.from(`<p>${"word ".repeat(100)}</p>`.repeat(13_000)); // about 6.6 MB
  const r = readTextFile(html, "text/html", "big.html", { maxChars: 0 });
  assert.match(r.incomplete ?? "", /too large/);
  // About 4 MB of the 6.6 MB became text (the rest is the note's business).
  assert.ok(r.text.length > 3_000_000 && r.text.length < 5_000_000, String(r.text.length));
});

test("damaged ZIP offsets fail with the module's own error, and the ZIP64 size marker means unknown", async () => {
  const good = docx(["Hello there"]);
  const patched = Buffer.from(good);
  // The central directory's local-header offset of the document part, pointed past the file.
  const name = Buffer.from("word/document.xml");
  const central = patched.indexOf(name, patched.indexOf(name) + 1) - 46;
  assert.equal(patched.readUInt32LE(central), 0x02014b50);
  patched.writeUInt32LE(0xfffffff0, central + 42);
  await assert.rejects(readOffice(patched), (err: unknown) => !(err instanceof RangeError) && /damaged ZIP/.test(String(err)));
  const marked = zipOf([{ name: "word/document.xml", data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>sized unknown</w:t></w:r></w:p></w:body></w:document>'), declaredSize: 0xffffffff }]);
  assert.equal(await officeText(marked), "sized unknown");
});

test("Greek glyph names resolve", async () => {
  const file = pdf(["BT /F1 12 Tf 72 700 Td (The Greek letters \\001\\002\\003 and \\004\\005\\006 here.) Tj ET"], [], (b) => ({
    F1: b.simpleFont({ subtype: "Type1", base: "Symbol", encoding: "<< /Differences [1 /alpha /beta /gamma /Alpha /Beta /Gamma] >>" }),
  }));
  assert.equal((await readPdf(file))!.text, "The Greek letters αβγ and ΑΒΓ here.");
});

test("no trailing-run regular expressions remain in the attachment reader (they backtrack quadratically)", () => {
  const source = readFileSync(new URL("../../src/attachments.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /[+*]\$\/[a-z]*[,)]/);
});
