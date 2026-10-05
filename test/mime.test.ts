import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { bareAddress, cleanBody, cleanSnippet, parseAddressList, parseMailboxes, recipientsFrom } from "../src/format.js";
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

test("htmlToText lays text out like a browser", () => {
  // <br> and <hr> with attributes (Apple Mail's <br class="">, Gmail's <br clear="all">).
  assert.equal(htmlToText('Line one<br class="">Line two<br clear="all">Three<hr style="x">Four'), "Line one\nLine two\nThree\nFour");
  // Source line breaks and indentation inside text are just spaces; <pre> keeps them.
  assert.equal(htmlToText("<p>Thanks for the\n   update, see you\non Monday.</p>"), "Thanks for the update, see you on Monday.");
  assert.equal(htmlToText("<p>Output:</p><pre>\nname    qty\n  tea     2</pre>Done"), "Output:\n\nname    qty\n  tea     2\n\nDone");
  // Ordered lists are numbered, nested lists stay together, table cells are tab-separated.
  assert.equal(htmlToText("<ol><li>One<ul><li>a</li></ul></li><li>Two</li></ol>"), "1. One\n- a\n2. Two");
  assert.equal(htmlToText("<table><tr><td>Item</td><td>Price</td></tr><tr><td>Tea</td><td>3</td></tr></table>"), "Item\tPrice\nTea\t3");
  // Hidden content, including unterminated comments and scripts, never shows.
  assert.equal(htmlToText('<title>T</title><script>var s = "</p>";</script>Shown<style>p{}</style><!-- hidden'), "Shown");
  // A "<" that doesn't start a tag is text.
  assert.equal(htmlToText("<p>if a < b and 1<2</p>"), "if a < b and 1<2");
});

test("htmlToText decodes entities fully and safely", () => {
  assert.equal(htmlToText("F&uuml;r Sie: Caf&eacute; &Agrave; &rarr; &hearts; &alpha;&Omega; &euro;5 &frac12;"), "Für Sie: Café À → ♥ αΩ €5 ½");
  // Numeric references in the Windows-1252 range, and legacy references without ";".
  assert.equal(htmlToText("&#147;Hi&#148; it&#146;s &copy 2024 &amp more"), "“Hi” it’s © 2024 & more");
  // Unknown names stay as written; object prototype names are not entities.
  assert.equal(htmlToText("&constructor; &toString; &bogus;"), "&constructor; &toString; &bogus;");
  // Emoji sequences keep their zero-width joiners.
  assert.equal(htmlToText("&#x1F468;&zwj;&#x1F469;&zwj;&#x1F467;"), "👨‍👩‍👧");
});

test("htmlToText keeps link addresses, including unusual ones", () => {
  assert.equal(htmlToText(`<a href="https://x.com/it's/page">Page</a>`), "Page (https://x.com/it's/page)");
  assert.equal(htmlToText("<a href=https://x.com/page?a=1&amp;b=2>Page</a>"), "Page (https://x.com/page?a=1&b=2)");
  assert.equal(htmlToText('<a href="https://shop.example/x"><img src="b.png" alt="Shop now"></a>'), "Shop now (https://shop.example/x)");
  assert.equal(htmlToText('<a href="https://shop.example/x"><img src="b.png"></a>'), "https://shop.example/x");
  assert.equal(htmlToText('<a href="https://x.com">https://x.com</a> <a href="#top">Top</a>'), "https://x.com Top");
});

test("htmlToText stays fast on hostile HTML", () => {
  const inputs = {
    "unclosed attributes": '<a href="x" '.repeat(20_000),
    "unclosed links": '<a href="x">'.repeat(20_000),
    "unterminated comments": "<!--".repeat(50_000),
    "unterminated styles": "<style>".repeat(50_000),
    "stray brackets": "<x ".repeat(50_000),
    "long space run": `a${" ".repeat(200_000)}b`,
    "no-break space run": `a${"&nbsp;".repeat(50_000)}b`,
    "unclosed quotes": '<x a="'.repeat(50_000),
  };
  for (const [name, html] of Object.entries(inputs)) {
    const start = process.cpuUsage();
    htmlToText(html);
    const used = process.cpuUsage(start);
    const ms = (used.user + used.system) / 1000;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(0)} ms of CPU`);
  }
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
  // The Content-ID is plain ASCII, and the HTML's reference was pointed at it.
  const cid = /Content-ID: <([^>]+)>/.exec(raw)![1];
  assert.match(cid, /^caf_photo\.png\.[0-9a-f]{8}$/);
  assert.ok(raw.includes(Buffer.from(`<img src="cid:${cid}">`).toString("base64")), "HTML refers to the new Content-ID");
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

test("invisible padding is removed, but joiners that are part of words are kept", () => {
  // Preview padding: combining grapheme joiner, no-break space and zero-width non-joiner runs.
  assert.equal(cleanSnippet("Sale ͏ ‌͏ ‌͏ ‌ ends &zwnj;&nbsp;now"), "Sale ends now");
  // Persian and Hindi need U+200C between letters (after combining marks); Mongolian needs U+180E.
  for (const word of ["می‌خواهم", "क्‌ष", "ᠮᠣᠷᠢ᠎ᠨ", "👨‍👩‍👧"]) assert.equal(cleanBody(`a ${word} b`), `a ${word} b`);
  assert.equal(cleanBody("Blank⠀⠀ Braille​"), "Blank Braille");
});

test("cleanBody stays fast on long runs of tabs and spaces", () => {
  const start = process.cpuUsage();
  cleanBody(`a${"\t".repeat(200_000)}b\n${" \t".repeat(100_000)}c`);
  const used = process.cpuUsage(start);
  assert.ok((used.user + used.system) / 1000 < 200);
});

/** The decoded body of each leaf part, by Content-Type, from a message built by buildMime. */
function leafBodies(raw: string): { type: string; headers: { name: string; value: string }[]; body: string }[] {
  const out: { type: string; headers: { name: string; value: string }[]; body: string }[] = [];
  const atts = new Map<string, string>();
  const walk = (part: ReturnType<typeof parseMime>) => {
    if (part.parts?.length) return part.parts.forEach(walk);
    const data = part.body?.data ?? atts.get(part.body?.attachmentId ?? "") ?? "";
    out.push({ type: part.mimeType!, headers: part.headers ?? [], body: Buffer.from(data, "base64url").toString() });
  };
  walk(
    parseMime(raw, (data) => {
      const id = `att${atts.size}`;
      atts.set(id, data);
      return id;
    }),
  );
  return out;
}

test("inline images get plain ASCII Content-IDs that the HTML points at, even with odd or repeated names", () => {
  const raw = buildMime({
    to: ["a@example.com"],
    html: '<p><img src="cid:my logo.png"> <img src="cid:caf%C3%A9.png"> <img src="cid:chart.png"><img src="cid:chart.png"></p>',
    attachments: [
      { content: Buffer.from("logo"), filename: "my logo.png", mimeType: "image/png", inline: true },
      { content: Buffer.from("cafe"), filename: "café.png", mimeType: "image/png", inline: true },
      { content: Buffer.from("one"), filename: "chart.png", mimeType: "image/png", inline: true },
      { content: Buffer.from("two"), filename: "chart.png", mimeType: "image/png", inline: true },
    ],
  });
  const leaves = leafBodies(raw);
  const html = leaves.find((l) => l.type === "text/html")!.body;
  const images = leaves.filter((l) => l.type === "image/png");
  const ids = images.map((l) => l.headers.find((h) => h.name === "Content-ID")!.value.replace(/^<|>$/g, ""));
  assert.equal(new Set(ids).size, 4, "Content-IDs are unique");
  for (const id of ids) assert.match(id, /^[\x21-\x7e]+$/);
  assert.equal(ids[2], "chart.png", "plain names are kept as they are");
  assert.equal(html, `<p><img src="cid:${ids[0]}"> <img src="cid:${ids[1]}"> <img src="cid:${ids[2]}"><img src="cid:${ids[3]}"></p>`);
  assert.deepEqual(images.map((l) => l.body), ["logo", "cafe", "one", "two"]);
});

test("long filenames use RFC 2231 continuations and long subjects stay within line limits", () => {
  const filename = `${"見積書_株式会社サンプル_2024年度第3四半期_最終版".repeat(6)}.pdf`;
  const raw = buildMime({
    to: ["a@example.com"],
    subject: `https://example.com/${"a".repeat(1200)}`,
    text: "hi",
    attachments: [{ content: Buffer.from("x"), filename, mimeType: "application/pdf" }],
  });
  for (const line of raw.split("\r\n")) assert.ok(line.length <= 78, `line of ${line.length}: ${line.slice(0, 40)}`);
  assert.match(raw, /filename\*0\*=UTF-8''%E8%A6%8B/);
  assert.match(raw, /filename\*1\*=%/);
  const headers = parseHeaders(raw.slice(0, raw.indexOf("\r\n\r\n")));
  assert.equal(headers.find((h) => h.name === "Subject")!.value, `https://example.com/${"a".repeat(1200)}`);
});

test("addresses with control or invisible characters are refused", () => {
  for (const address of ["a\u0000@x.com", "a@x\u200b.com", "\u202ea@x.com", "a\t@x.com"]) {
    assert.throws(() => buildMime({ to: [address], text: "hi" }), /Invalid email address/, JSON.stringify(address));
  }
  assert.throws(() => buildMime({ to: ["bob@exam\u200bple.com"], text: "hi" }), /invisible or control character/);
  // Internationalized addresses are fine.
  assert.doesNotThrow(() => buildMime({ to: ["jörg@bücher.de"], text: "hi" }));
});

test("attached emails are sent as 7-bit text when they are plain ASCII", () => {
  const eml = Buffer.from("From: a@x.com\nSubject: Hi\n\nHello there.\n");
  const raw = buildMime({ to: ["a@example.com"], text: "fwd", attachments: [{ content: eml, filename: "hi.eml", mimeType: "message/rfc822" }] });
  assert.match(raw, /Content-Type: message\/rfc822; name="hi\.eml"\r\nContent-Disposition: attachment; filename="hi\.eml"\r\nContent-Transfer-Encoding: 7bit\r\n\r\nFrom: a@x\.com\r\nSubject: Hi\r\n\r\nHello there\.\r\n--/);
  // 8-bit content can't be sent as 7-bit text: it stays base64.
  const latin = Buffer.from("Subject: Caf\xe9\r\n\r\nx", "latin1");
  const raw8 = buildMime({ to: ["a@example.com"], text: "fwd", attachments: [{ content: latin, filename: "x.eml", mimeType: "message/rfc822" }] });
  assert.match(raw8, /message\/rfc822[^]*Content-Transfer-Encoding: base64/);
});
