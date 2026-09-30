import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { bareAddress, parseAddressList, parseMailboxes, recipientsFrom } from "../src/format.js";
import { buildMime, decodeBase64, encodeHeaderValue, htmlToText } from "../src/mime.js";
import { parseHeaders, parseMime } from "./fakeGmail.js";

test("ASCII headers pass through; non-ASCII becomes short encoded-words that round-trip", () => {
  assert.equal(encodeHeaderValue("Hello there"), "Hello there");
  const long = "Réunion trimestrielle — résultats et prévisions pour l'équipe 🚀 ".repeat(3).trim();
  const encoded = encodeHeaderValue(long);
  for (const line of encoded.split("\r\n")) assert.ok(line.length <= 76, `line too long: ${line.length}`);
  assert.equal(parseHeaders(`Subject: ${encoded}`)[0].value, long);
});

test("CR/LF in header values cannot start a new header", () => {
  assert.equal(encodeHeaderValue("a\r\nBcc: x@y.z"), "a Bcc: x@y.z");
});

test("address lists split on commas outside quotes", () => {
  assert.deepEqual(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com, (Team, Ops) ops@z.com'), [
    '"Doe, Jane" <jane@x.com>',
    "bob@y.com",
    "(Team, Ops) ops@z.com",
  ]);
  assert.equal(bareAddress('"Doe, Jane" <Jane@X.com>'), "jane@x.com");
});

test("buildMime nests alternative, related and mixed parts correctly", () => {
  const raw = buildMime({
    to: ["a@example.com"],
    subject: "Photos",
    html: '<p>Look: <img src="cid:pic.png"></p>',
    attachments: [
      { content: Buffer.from("PNGDATA"), filename: "pic.png", mimeType: "image/png", inline: true },
      { content: Buffer.from("CSV"), filename: "résumé.csv", mimeType: "text/csv" },
    ],
  });
  const atts = new Map<string, string>();
  const root = parseMime(raw, (data) => {
    const id = `att${atts.size}`;
    atts.set(id, data);
    return id;
  });
  assert.equal(root.mimeType, "multipart/mixed");
  const [related, csv] = root.parts!;
  assert.equal(related.mimeType, "multipart/related");
  const [alternative, png] = related.parts!;
  assert.deepEqual(alternative.parts!.map((p) => p.mimeType), ["text/plain", "text/html"]);
  assert.equal(Buffer.from(alternative.parts![0].body!.data!, "base64url").toString(), "Look:");
  assert.equal(png.headers!.find((h) => h.name === "Content-ID")!.value, "<pic.png>");
  assert.equal(csv.filename, "résumé.csv");
  assert.equal(Buffer.from(atts.get(csv.body!.attachmentId!)!, "base64url").toString(), "CSV");
});

test("inline attachments without an HTML body become regular attachments", () => {
  const raw = buildMime({
    to: ["a@example.com"],
    text: "hi",
    attachments: [{ content: Buffer.from("x"), filename: "x.png", inline: true }],
  });
  assert.match(raw, /Content-Disposition: attachment; filename="x.png"/);
});

test("attachments over 25 MB are refused", () => {
  assert.throws(
    () => buildMime({ to: ["a@b.co"], attachments: [{ content: Buffer.alloc(26 * 1024 * 1024) }] }),
    /at most 25 MB/,
  );
});

test("decodeBase64 accepts standard and URL-safe alphabets", () => {
  assert.equal(decodeBase64("aGk/Pz8+").toString(), "hi???>");
  assert.equal(decodeBase64("aGk_Pz8-").toString(), "hi???>");
  assert.throws(() => decodeBase64("not base64!"), /base64/);
});

test("htmlToText keeps structure, links and entities readable", () => {
  const html = `<html><head><style>p{color:red}</style></head><body>
    <h1>Order&nbsp;shipped</h1><p>Hi Sam,<br>your order <b>#123</b> is on its way.</p>
    <ul><li>Widget &times; 2</li><li>Gadget</li></ul>
    <p><a href="https://track.example/abc">Track package</a> &middot; <a href="mailto:help@x.com">Email us</a></p>
  </body></html>`;
  assert.equal(
    htmlToText(html),
    "Order shipped\n\nHi Sam,\nyour order #123 is on its way.\n\n- Widget × 2\n- Gadget\n\nTrack package (https://track.example/abc) · Email us",
  );
});

test("attachment content given as a data: URL is accepted", () => {
  assert.equal(decodeBase64("data:text/plain;base64,aGVsbG8=").toString(), "hello");
});

test("long References and Subject headers are folded; Content-IDs stay ASCII", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `<message-${i}-abcdefghijklmnop@mail.example.com>`).join(" ");
  const raw = buildMime({
    to: ["a@example.com"],
    subject: "A very long subject line ".repeat(8).trim(),
    references: ids,
    html: '<img src="cid:caf%C3%A9%20photo.png">',
    attachments: [{ content: Buffer.from("img"), filename: "café photo.png", mimeType: "image/png", inline: true }],
  });
  const headerBlock = raw.slice(0, raw.indexOf("\r\n\r\n"));
  for (const line of headerBlock.split("\r\n")) assert.ok(line.length <= 78, `header line too long: ${line.length}`);
  assert.equal(parseHeaders(headerBlock).find((h) => h.name === "References")!.value, ids);
  assert.match(raw, /Content-ID: <caf%C3%A9%20photo\.png>/);
  assert.ok(!/[^\x00-\x7f]/.test(raw), "message is 7-bit clean");
});

test("display names are quoted or encoded as needed", () => {
  const raw = buildMime({
    to: [{ name: "Doe, Jane", address: "jane@x.com" }, { name: "Zoë", address: "zoe@x.com" }, { name: "Bob", address: "bob@x.com" }],
    from: { name: "Me Alias", address: "alias@x.com" },
    text: "hi",
  });
  const headers = parseHeaders(raw.slice(0, raw.indexOf("\r\n\r\n")));
  assert.equal(headers.find((h) => h.name === "To")!.value, '"Doe, Jane" <jane@x.com>, Zoë <zoe@x.com>, Bob <bob@x.com>');
  assert.equal(headers.find((h) => h.name === "From")!.value, "Me Alias <alias@x.com>");
});

test("group syntax and comments parse into real mailboxes", () => {
  assert.deepEqual(parseMailboxes('undisclosed-recipients:;'), []);
  assert.deepEqual(parseMailboxes('Team: a@x.com, "B, Bee" <b@y.com>;, c@z.com (Cee)'), [
    { address: "a@x.com" },
    { name: "B, Bee", address: "b@y.com" },
    { name: "Cee", address: "c@z.com" },
  ]);
  assert.equal(bareAddress('"Help <help@vendor.com>" <NoReply@Vendor.com>'), "noreply@vendor.com");
  assert.deepEqual(recipientsFrom('"john doe"@example.com, not-an-address, a@x.com, A@X.com'), [
    { address: '"john doe"@example.com' },
    { address: "a@x.com" },
  ]);
});
