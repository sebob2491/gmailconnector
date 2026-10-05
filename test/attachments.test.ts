import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodeTextFile, FileTooLargeError, kindOf, officeText, pdfText, readOffice, readPdf, sniffType } from "../src/attachments.js";
import { docx, docxOf, pdf, pdfOf, png, pptx, xlsx, xlsxOf, zip, zipOf } from "./files.js";

test("PDF text comes out with line breaks and word spacing", async () => {
  const file = pdf([
    "BT /F1 12 Tf 72 720 Td (Pay statement for Sebastian) Tj 0 -14 Td (Net pay: $1,234.56) Tj T* [(Hello)-250(World)] TJ ET",
    "BT /F1 12 Tf 72 720 Td (Caf\\351 \\(page two\\)) Tj ET",
  ]);
  assert.equal(await pdfText(file), "Pay statement for Sebastian\nNet pay: $1,234.56\nHello World\n\nCafé (page two)");
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
  const pdfBomb = pdf(["BT 72 700 Td (Readable statement text for the account holder.) Tj ET"], [
    { dict: "/Filter /FlateDecode", data: deflateSync(Buffer.alloc(64 * 1024 * 1024, " ")) },
  ]);
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
