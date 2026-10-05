import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { decodeTextFile, kindOf, officeText, pdfText, sniffType } from "../src/attachments.js";
import { docx, pdf, png, pptx, xlsx } from "./files.js";

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
