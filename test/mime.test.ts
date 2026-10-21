import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import {
  bareAddress,
  cleanBody,
  cleanSnippet,
  decodeBody,
  decodeCharset,
  extractContent,
  formatMessage,
  parseAddressList,
  parseMailboxes,
  recipientsFrom,
  type ApiMessagePart,
} from "../src/format.js";
import { Base64UrlData, buildMime, decodeBase64, decodeEntities, encodeHeaderValue, htmlToText } from "../src/mime.js";
import { attachmentDataOf } from "../src/mailbox.js";
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

/** Character references found the way decodeEntities used to find them (a regex), as a reference. */
function referenceEntities(text: string): string {
  const legacy = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "AMP", "LT", "GT", "QUOT", "COPY", "REG"]);
  const c1 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
  const code = (n: number) => (n >= 0x80 && n <= 0x9f ? c1[n - 0x80] : n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\ufffd" : String.fromCodePoint(n));
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/g, (match, hex, dec, name, semi, offset: number) => {
    if (hex) return code(parseInt(hex, 16));
    if (dec) return code(parseInt(dec, 10));
    if (semi) return decodeEntities(match); // a lone known name decodes; anything else is left as is
    const next = text.charAt(offset + match.length);
    return legacy.has(name) && !/[A-Za-z0-9=]/.test(next) ? decodeEntities(`&${name};`) : match;
  });
}

test("decodeEntities finds references exactly as the regex it replaces did, without allocating per unknown name", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const tokens = ["&", "#", "x", "X", ";", "=", " ", "0", "1", "9", "a", "f", "F", "z", "amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "AMP", "eacute", "Eacute", "hearts", "bogus", "constructor", "1F600", "128512", "99999999", "123456789", "a".repeat(33), "é", "&amp;", "&#x41;"];
  for (let i = 0; i < 3000; i++) {
    let text = "";
    const length = Math.floor(random() * 30);
    for (let j = 0; j < length; j++) text += tokens[Math.floor(random() * tokens.length)];
    assert.equal(decodeEntities(text), referenceEntities(text), JSON.stringify(text));
  }
  for (const text of ["&#x110000;", "&#xD800;", "&#0;", "&#146;", "&ampx", "&amp=1", "&amp", "&lt;b&gt;", "&#x", "&#;", "&;", "&&amp;"]) {
    assert.equal(decodeEntities(text), referenceEntities(text), text);
  }
  // 2 MB of unknown names: the same text back, quickly (the regex version ran out of memory at the Worker's limit).
  const unknown = "&a".repeat(1024 * 1024);
  const start = process.cpuUsage();
  assert.equal(decodeEntities(unknown), unknown);
  const used = process.cpuUsage(start);
  assert.ok((used.user + used.system) / 1000 < 200);
});

test("htmlToText keeps link addresses, including unusual ones", () => {
  assert.equal(htmlToText(`<a href="https://x.com/it's/page">Page</a>`), "Page (https://x.com/it's/page)");
  assert.equal(htmlToText("<a href=https://x.com/page?a=1&amp;b=2>Page</a>"), "Page (https://x.com/page?a=1&b=2)");
  assert.equal(htmlToText('<a href="https://shop.example/x"><img src="b.png" alt="Shop now"></a>'), "Shop now (https://shop.example/x)");
  assert.equal(htmlToText('<a href="https://shop.example/x"><img src="b.png"></a>'), "https://shop.example/x");
  assert.equal(htmlToText('<a href="https://x.com">https://x.com</a> <a href="#top">Top</a>'), "https://x.com Top");
});

test("malformed %-escapes and unpaired surrogates never make link or filename handling throw", () => {
  // An empty mailto: link shows its address; a bad escape (fuzz repro html-mailto-bad-escape.html) is shown as written.
  assert.equal(htmlToText('<p>Hi</p><a href="mailto:%zz@x.y"></a>'), "Hi\n\n%zz@x.y");
  assert.equal(htmlToText('<a href="mailto:caf%C3%A9@x.y?subject=hi"></a> <a href="mailto:%E0%A4%A"></a>'), "café@x.y %E0%A4%A");
  // A forwarded file or inline image whose name holds an unpaired surrogate is still sent.
  const raw = buildMime({
    to: ["a@example.com"],
    html: '<img src="cid:pic\ud800.png">',
    attachments: [
      { content: Buffer.from("x"), filename: "report\ud800.pdf", mimeType: "application/pdf" },
      { content: Buffer.from("y"), filename: "pic\ud800.png", mimeType: "image/png", inline: true },
    ],
  });
  assert.match(raw, /filename\*=UTF-8''report%EF%BF%BD\.pdf/);
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

test("runs of '<' that start no tag are text, converted in one piece", () => {
  assert.equal(htmlToText("<p>if a < b and 1<2 << 3 <= 4</p><pre>x <1\n< y</pre>"), "if a < b and 1<2 << 3 <= 4\n\nx <1\n< y");
  const stray = "<".repeat(4 * 1024 * 1024);
  const heap = process.memoryUsage().heapUsed;
  const start = process.cpuUsage();
  assert.equal(htmlToText(stray).length, stray.length);
  const used = process.cpuUsage(start);
  assert.ok((used.user + used.system) / 1000 < 250, "CPU");
  assert.ok(process.memoryUsage().heapUsed - heap < 48 * 1024 * 1024, "one part per run, not one per '<'");
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

test("bodies Gmail already converted to UTF-8 aren't decoded twice; real legacy charsets still work", () => {
  // Gmail hands out the ASU-style body as UTF-8 while the part still says ISO-8859-1.
  const converted = Buffer.from("admission — prior notations (2017–2026)", "utf8");
  assert.equal(decodeCharset(converted, "ISO-8859-1"), "admission — prior notations (2017–2026)");
  // The same text really in Windows-1252 bytes (0x97 is an em dash there).
  const legacy = Buffer.from([0x61, 0x20, 0x97, 0x20, 0x62, 0x20, 0xe9]);
  assert.equal(decodeCharset(legacy, "ISO-8859-1"), "a — b é");
  // 7-bit charsets (ISO-2022-JP) are decoded as declared, not taken for ASCII UTF-8.
  const jis = Buffer.from([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]);
  assert.equal(decodeCharset(jis, "ISO-2022-JP"), "日本");
  // Shift_JIS bytes aren't valid UTF-8, so the label is used.
  assert.equal(decodeCharset(Buffer.from([0x93, 0xfa, 0x96, 0x7b]), "Shift_JIS"), "日本");
  // Mislabelled "UTF-8" that is really Windows-1252 doesn't turn into replacement characters.
  assert.equal(decodeCharset(Buffer.from([0x4a, 0xfc, 0x72, 0x67, 0x65, 0x6e]), "utf-8"), "Jürgen");
  assert.equal(decodeBody(Buffer.from("café", "utf8").toString("base64url"), "text/plain; charset=windows-1252"), "café");
});

test("a few bytes of East Asian text that also pass as UTF-8 are read as declared; converted text stays UTF-8", () => {
  // C4 A3 is 模 in GBK and ģ in UTF-8; C2 A9 is ﾂｩ in Shift_JIS and © in UTF-8.
  assert.equal(decodeCharset(Buffer.from([0xc4, 0xa3]), "gb2312"), "模");
  assert.equal(decodeCharset(Buffer.from([0xc2, 0xa9]), "Shift_JIS"), "ﾂｩ");
  // A Japanese sentence Gmail delivered as UTF-8 under its original ISO-2022-JP or Shift_JIS label.
  const sentence = "お世話になっております。来週の打ち合わせの件、承知いたしました。";
  assert.equal(decodeCharset(Buffer.from(sentence, "utf8"), "ISO-2022-JP"), sentence);
  assert.equal(decodeCharset(Buffer.from(sentence, "utf8"), "shift_jis"), sentence);
  // An em dash (3 bytes) in converted English text isn't valid GBK, so it stays UTF-8.
  assert.equal(decodeCharset(Buffer.from("Q4 — done", "utf8"), "gbk"), "Q4 — done");
});

test("attachments re-attached from Gmail's base64url text come out byte for byte as when decoded and encoded again", () => {
  /** What re-attaching produced before: decode the file, then base64 in 76-character lines. */
  const reference = (bytes: Buffer) => (bytes.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
  const anonymous = (raw: string) => raw.replace(/=_mcp_[0-9a-f]+/g, "BOUNDARY");
  const block = 57 * 1024; // one block of re-wrapped text
  for (const size of [0, 1, 2, 3, 4, 56, 57, 58, 1000, block - 1, block, block + 1, 3 * block + 2, 1_000_001]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7919 + (i >> 8)) & 0xff));
    const gmail = bytes.toString("base64url");
    const padded = gmail + "=".repeat((4 - (gmail.length % 4)) % 4); // Gmail's text may or may not be padded
    const message = (content: Buffer | Base64UrlData) =>
      buildMime({ to: ["a@example.com"], subject: "Fwd", text: "see", html: "<p>see</p>", attachments: [{ content, filename: "f.bin", mimeType: "application/octet-stream" }] });
    const decoded = message(bytes);
    for (const text of [gmail, padded]) {
      const data = new Base64UrlData(Buffer.from(text, "latin1"));
      assert.equal(data.size, size);
      assert.equal(anonymous(message(data)), anonymous(decoded), `size ${size}${text === padded ? " (padded)" : ""}`);
    }
    // And both match the old encoding exactly.
    const body = decoded.split('filename="f.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--")[0];
    assert.equal(body, reference(bytes), `size ${size}`);
  }
});

test("an attachment's base64url text is sliced out of Gmail's JSON without parsing it", () => {
  const enc = new TextEncoder();
  const latin = (u: Uint8Array) => Buffer.from(u).toString("latin1");
  assert.equal(latin(attachmentDataOf(enc.encode('{\n  "size": 3,\n  "data": "QUJD"\n}\n'))), "QUJD");
  assert.equal(latin(attachmentDataOf(enc.encode('{"data":"QUJD_-8=","size":5}'))), "QUJD_-8=");
  assert.equal(latin(attachmentDataOf(enc.encode('{"attachmentId": "x", "size": 0, "data": ""}'))), "");
  // Anything unexpected is parsed properly.
  assert.equal(latin(attachmentDataOf(enc.encode('{"size": 3, "data" : "QUJD" }'))), "QUJD");
  assert.equal(latin(attachmentDataOf(enc.encode('{"size": 0}'))), "");
});


/** A text/plain leaf wrapped in `depth` levels of multipart/mixed. */
function nestedPayload(depth: number, text: string): ApiMessagePart {
  let part: ApiMessagePart = { partId: "leaf", mimeType: "text/plain", headers: [], body: { size: text.length, data: Buffer.from(text).toString("base64url") } };
  for (let i = 0; i < depth; i++) part = { partId: String(i), mimeType: "multipart/mixed", headers: [], body: { size: 0 }, parts: [part] };
  return part;
}

test("deeply nested MIME trees don't overflow the stack; parts past 64 levels are ignored", async () => {
  const none = async () => "";
  assert.equal((await extractContent(nestedPayload(20, "found"), none)).text, "found");
  assert.equal((await extractContent(nestedPayload(64, "found"), none)).text, "found");
  assert.equal((await extractContent(nestedPayload(65, "too deep"), none)).text, undefined);
  const msg = { id: "m", threadId: "t", payload: nestedPayload(20_000, "x") };
  const out = await formatMessage(msg, "PLAIN_TEXT", "me@example.com", none);
  assert.equal(out.plaintextBody, "");
});

test("an unnamed text/calendar part is listed as invite.ics, never used as the body", async () => {
  const leaf = (partId: string, mimeType: string, text: string, extra: Partial<ApiMessagePart> = {}): ApiMessagePart => ({
    partId,
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }],
    body: { size: text.length, data: Buffer.from(text).toString("base64url") },
    ...extra,
  });
  const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Q1 planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const none = async () => "";
  // Exchange/Outlook: the event is only in the alternative's unnamed text/calendar part.
  const exchange: ApiMessagePart = {
    partId: "",
    mimeType: "multipart/alternative",
    body: { size: 0 },
    parts: [leaf("0", "text/plain", "Q1 planning, Friday 10am"), leaf("1", "text/html", "<p>Q1 planning</p>"), leaf("2", "text/calendar", ics)],
  };
  const content = await extractContent(exchange, none);
  assert.equal(content.text, "Q1 planning, Friday 10am");
  assert.deepEqual(
    content.attachments.map(({ filename, mimeType, partId }) => ({ filename, mimeType, partId })),
    [{ filename: "invite.ics", mimeType: "text/calendar", partId: "2" }],
  );
  // Google Calendar also attaches invite.ics as a file: the event is listed once.
  const google: ApiMessagePart = {
    partId: "",
    mimeType: "multipart/mixed",
    body: { size: 0 },
    parts: [{ ...exchange, partId: "0" }, { partId: "1", mimeType: "application/ics", filename: "invite.ics", headers: [], body: { attachmentId: "ATT1", size: ics.length } }],
  };
  const both = await extractContent(google, none);
  assert.deepEqual(both.attachments.map((a) => `${a.filename} ${a.mimeType} ${a.partId}`), ["invite.ics application/ics 1"]);
  // A calendar part alone is an attachment, not the body.
  const only = await extractContent(leaf("", "text/calendar", ics), none);
  assert.equal(only.text, undefined);
  assert.equal(only.attachments[0].filename, "invite.ics");
});

test("dates are ISO 8601 to the second; a missing or broken internalDate falls back to the Date header", async () => {
  const none = async () => "";
  const payload: ApiMessagePart = { partId: "", mimeType: "text/plain", headers: [{ name: "Date", value: "Tue, 20 Oct 2026 21:09:45 +0000" }], body: { size: 0 } };
  const at = (internalDate?: string) => formatMessage({ id: "m", threadId: "t", internalDate, payload }, "METADATA_ONLY", "me@example.com", none);
  assert.equal((await at(String(Date.UTC(2026, 9, 20, 21, 9, 45, 123)))).date, "2026-10-20T21:09:45Z");
  assert.equal((await at(undefined)).date, "Tue, 20 Oct 2026 21:09:45 +0000");
  assert.equal((await at("not a time")).date, "Tue, 20 Oct 2026 21:09:45 +0000");
});
