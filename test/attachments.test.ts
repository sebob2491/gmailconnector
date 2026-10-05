import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodeTextFile, FileTooLargeError, kindOf, officeText, pdfText, readOffice, readPdf, sniffType } from "../src/attachments.js";
import { docx, docxOf, pdf, pdfOf, png, pptx, xlsx, zipOf } from "./files.js";

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
