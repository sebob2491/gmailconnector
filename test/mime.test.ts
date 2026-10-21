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
  hideQuotedHistory,
  limitLength,
  QUOTE_HIDDEN,
  quoteKey,
  parseAddressList,
  parseMailboxes,
  recipientsFrom,
  unflow,
  type ApiMessagePart,
} from "../src/format.js";
import { Base64UrlData, buildMime, decodeBase64, decodeEntities, encodeHeaderValue, htmlToText, HtmlTextReader } from "../src/mime.js";
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
  // Ordered lists are numbered, nested lists are indented, table cells are tab-separated.
  assert.equal(htmlToText("<ol><li>One<ul><li>a</li></ul></li><li>Two</li></ol>"), "1. One\n  - a\n2. Two");
  assert.equal(htmlToText("<table><tr><td>Item</td><td>Price</td></tr><tr><td>Tea</td><td>3</td></tr></table>"), "Item\tPrice\nTea\t3");
  // Hidden content, including unterminated comments and scripts, never shows.
  assert.equal(htmlToText('<title>T</title><script>var s = "</p>";</script>Shown<style>p{}</style><!-- hidden'), "Shown");
  // A "<" that doesn't start a tag is text.
  assert.equal(htmlToText("<p>if a < b and 1<2</p>"), "if a < b and 1<2");
});

test("control characters from numeric references or raw bytes are dropped from bodies", () => {
  assert.equal(htmlToText("a&#1;b&#x1F;c\u0007d &#xF;e\u000bf<pre>g\u0000h\fi</pre>"), "abcd ef\n\nghi");
  assert.equal(htmlToText('<a href="x&#2;y">&#3;</a>'), "xy");
  // Tabs and line breaks stay; vertical tab and form feed in plain text are line breaks.
  assert.equal(cleanBody("a\tb\u0000c\u001b[31md\fpage 2\u000bnext"), "a\tbc[31md\npage 2\nnext");
});

test("htmlToText leaves out elements hidden by their style, such as a newsletter's preview text", () => {
  const preheader = `<div style="display:none;font-size:1px;color:#fff;max-height:0;overflow:hidden">Jeans from $39.99 this week only${"&zwnj;&nbsp;".repeat(20)}</div>`;
  assert.equal(htmlToText(`${preheader}<table><tr><td><p>Hi Sam,</p><p>New arrivals are in.</p></td></tr></table>`), "Hi Sam,\nNew arrivals are in.");
  // Nested elements, other spellings, the preheader pattern without display:none, and `hidden`.
  assert.equal(htmlToText('<div style="DISPLAY: none !important"><div>a</div><p>b</p></div>c'), "c");
  assert.equal(htmlToText('<span style="font-size:0;max-height:0px;overflow:hidden;mso-hide:all">preview</span>Body'), "Body");
  assert.equal(htmlToText("<p hidden>secret</p>shown"), "shown");
  // A hidden element ends with its end tag, an end tag of what it is in, or the next cell, item or row.
  assert.equal(htmlToText('<div><span style="display:none">x</div>after'), "after");
  assert.equal(htmlToText('<table><tr><td style="display:none">mobile<td>desktop</table>'), "desktop");
  assert.equal(htmlToText('<table><tr><td style="display:none"><table><tr><td>inner</td></tr></table></td><td>shown</td></tr></table>'), "shown");
  assert.equal(htmlToText('<ul><li style="display:none">one<li>two</ul>'), "- two");
  // A hidden image's alt text isn't used; other "none" styles hide nothing.
  assert.equal(htmlToText('<a href="https://x.example/"><img style="display:none" alt="Hidden"><img alt="Shop"></a>'), "Shop (https://x.example/)");
  assert.equal(htmlToText('<p style="text-decoration:none;border:none">kept</p><div style="max-height:0px">kept too</div>'), "kept\n\nkept too");
});

test("tables keep one row per line even when every cell holds a paragraph, as in Outlook", () => {
  const cell = (text: string) => `<td width=312 valign=top style='padding:0in 5.4pt'><p class=MsoNormal>${text}<o:p></o:p></p></td>`;
  const outlook =
    "<p class=MsoNormal>Here are the two options we discussed:<o:p></o:p></p>" +
    "<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0>" +
    `<tr>${cell("<b>Option</b>")}${cell("<b>Price</b>")}</tr><tr>${cell("A")}${cell("$1,200")}</tr><tr>${cell("B")}${cell("$1,450")}</tr>` +
    "</table><p class=MsoNormal>Jane<o:p></o:p></p>";
  assert.equal(htmlToText(outlook), "Here are the two options we discussed:\n\nOption\tPrice\nA\t$1,200\nB\t$1,450\n\nJane");
  // Blocks inside a cell are a line break apart; a cell's trailing line breaks don't split its row.
  assert.equal(htmlToText("<table><tr><td><h2>INVOICE 12</h2>Date: Jan 3<br>Due: Feb 2<br></td><td><p>Total</p><p>$9</p></td></tr></table>"), "INVOICE 12\nDate: Jan 3\nDue: Feb 2\tTotal\n$9");
  // Layout tables (newsletters): sections and paragraphs come one per line, nested tables included.
  assert.equal(
    htmlToText('<table><tr><td><h1>News</h1><p>One</p><table><tr><td><ul><li>a</li><li>b</li></ul></td></tr></table><p>Two</p></td></tr><tr><td><p>Footer</p></td></tr></table>'),
    "News\nOne\n- a\n- b\nTwo\nFooter",
  );
  // Cells left open, and empty ones.
  assert.equal(htmlToText("<table><tr><td>a<td><p>b</p><tr><td>c<td></table>after"), "a\tb\nc\nafter");
});

test("nested lists are indented and list numbers stay sane", () => {
  assert.equal(
    htmlToText("<ol><li>Freeze main<ol><li>announce in #eng</li><li>tag release<ul><li>v2.1</li></ul></li></ol></li><li>Run migrations</li></ol>"),
    "1. Freeze main\n  1. announce in #eng\n  2. tag release\n    - v2.1\n2. Run migrations",
  );
  assert.equal(htmlToText('<ol start="0"><li>a</li><li>b</li></ol>'), "0. a\n1. b");
  assert.equal(htmlToText("<ol start=99999999999999999999><li>a</li></ol><ol start=-7><li>b</li></ol>"), "1000000. a\n\n-7. b");
  // However deep the nesting, an item is indented at most 16 spaces.
  assert.equal(htmlToText(`${"<ul><li>x".repeat(50)}`).split("\n").at(-1), `${" ".repeat(16)}- x`);
});

test("format=flowed text has its soft line breaks joined", () => {
  assert.equal(
    unflow("Hi team, \nhere is the status for \nthis week.\n\nNext steps:\n- load tests\n-- \nSebastian", false),
    "Hi team, here is the status for this week.\n\nNext steps:\n- load tests\n-- \nSebastian",
  );
  // DelSp=yes removes the space at each soft break (text without spaces between words, like Japanese).
  assert.equal(unflow("来週の打ち合わせ \nの件、承知 \nいたしました。", true), "来週の打ち合わせの件、承知いたしました。");
  // An empty line after a soft break still separates paragraphs.
  assert.equal(unflow("one \ntwo \n\nthree", false), "one two \n\nthree");
  // Quote depth is kept, a change of depth ends a paragraph, and space-stuffing is undone.
  assert.equal(
    unflow("> Can we meet \n> on Friday?\n>> Earlier \n>> note\n > not a quote\n From here", false),
    "> Can we meet on Friday?\n>> Earlier note\n> not a quote\nFrom here",
  );
});

test("a format=flowed body is read unwrapped", async () => {
  const text = "Hello, this line was \r\nwrapped by the mail program.\r\n";
  const part: ApiMessagePart = {
    partId: "",
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"; format=flowed; delsp=no' }],
    body: { size: text.length, data: Buffer.from(text).toString("base64url") },
  };
  assert.equal((await extractContent(part, async () => "")).text, "Hello, this line was wrapped by the mail program.\n");
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

test("cleanBody keeps the spaces that indent a line, and collapses other runs", () => {
  assert.equal(cleanBody("Steps:\n  - one\n    - two\n\u00a0\u00a0\u00a0padded\nwide   gap  \n\tx"), "Steps:\n  - one\n    - two\n padded\nwide gap\n\tx");
  assert.equal(cleanBody("    \n  \n  code\n"), "code");
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

/** A conversation in which every reply quotes everything before it, Gmail style. */
function quotingThread(count: number): string[] {
  const bodies: string[] = [];
  let previous = "";
  for (let i = 0; i < count; i++) {
    const own = `Hi team,\r\n\r\nUpdate ${i}: the numbers  for week ${i} are in.\u200b\r\nThanks,\r\nPerson ${i % 7}\r\n`;
    const quote = previous.split("\r\n").map((line) => (line ? `> ${line}` : ">")).join("\r\n");
    previous = i ? `${own}\r\nOn Mon, Jan ${(i % 28) + 1}, 2024 at 10:00 AM Person ${(i - 1) % 7} <p@example.com> wrote:\r\n\r\n${quote}` : own;
    bodies.push(previous);
  }
  return bodies;
}

test("cutting the quoted history before cleaning a body gives the same text as after", () => {
  const bodies = quotingThread(100);
  const keys = bodies.map((body) => quoteKey(body));
  bodies.forEach((body, i) => {
    const before = cleanBody(hideQuotedHistory(body, keys.slice(0, i))); // CRLF line ends and all
    assert.equal(before, hideQuotedHistory(cleanBody(body), keys.slice(0, i)));
    assert.equal(before, cleanBody(hideQuotedHistory(body.replace(/\r\n?/g, "\n"), keys.slice(0, i))));
    if (i) assert.ok(before.endsWith(QUOTE_HIDDEN), `message ${i} has its quote hidden`);
  });
});

/** A newsletter of about `bytes` characters: rows of a layout table, each with a headline, a paragraph and a tracking link. */
function newsletter(bytes: number): string {
  let html = '<html><body><div style="display:none;max-height:0;overflow:hidden">Preview text</div><table role="presentation"><tr><td><table width="600">';
  for (let i = 1; html.length < bytes; i++) {
    html +=
      `<tr><td style="padding:10px 20px;font-family:Arial,sans-serif"><h2 style="font-size:18px">Story ${i}: what changed this week</h2>` +
      `<p style="margin:0 0 12px">We rebuilt the reports pipeline &amp; cut the wait from minutes to seconds. Here is what that means for your team.</p>` +
      `<p><a href="https://click.example.com/t/${"x".repeat(220)}?u=${i}" style="color:#0a0">Read more</a></p></td></tr>\n`;
  }
  return `${html}</table></td></tr></table></body></html>`;
}

const htmlMessage = (html: string) => ({
  id: "m",
  threadId: "t",
  payload: { partId: "", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: html.length, data: Buffer.from(html).toString("base64url") } },
});

test("htmlToText converts only as much as asked, and goes on from there when asked for more", () => {
  const html = newsletter(200_000);
  const whole = htmlToText(html);
  const start = htmlToText(html, 1000);
  assert.ok(start.length >= 1000 && start.length < 2500, `${start.length} characters`);
  assert.ok(whole.startsWith(start.slice(0, 1000)));
  // Read in steps, the text is the same as read at once.
  const reader = new HtmlTextReader(html);
  let read = reader.read(500);
  for (let chars = 2000; !read.complete; chars *= 3) read = reader.read(chars);
  assert.equal(read.text, whole);
});

test("only the start of a long body is read, and it reads exactly like the start of the whole body", async () => {
  const none = async () => "";
  for (const [size, max] of [[2_000_000, 20_000], [200_000, 20_000], [30_000, 20_000], [30_000, 0], [200_000, 3_000]]) {
    const msg = htmlMessage(newsletter(size));
    const all = await formatMessage(msg, "PLAIN_TEXT", "me@example.com", none, { shortenLinks: true, maxBodyChars: 0 });
    const cpu = process.cpuUsage();
    const out = await formatMessage(msg, "PLAIN_TEXT", "me@example.com", none, { shortenLinks: true, maxBodyChars: max });
    const used = process.cpuUsage(cpu);
    assert.equal(out.plaintextBody, max ? limitLength(all.plaintextBody!, max).text : all.plaintextBody, `${size} characters, limit ${max}`);
    if (!max || all.plaintextBody!.length <= max) assert.equal(out.truncated, undefined, "a body within the limit is all there");
    else if (size > 100_000) assert.equal(out.truncated, "Body shortened; the rest is available with maxBodyChars: 0.");
    assert.ok((used.user + used.system) / 1000 < 100, `${size}: ${(used.user + used.system) / 1000} ms`);
  }
  // Plain text too, without a link cut at the point where reading stopped.
  const text = ("Read https://click.example.com/" + "y".repeat(300) + " now.\n").repeat(400);
  const plain = { id: "m", threadId: "t", payload: { partId: "", mimeType: "text/plain", headers: [], body: { size: text.length, data: Buffer.from(text).toString("base64url") } } };
  const all = await formatMessage(plain, "PLAIN_TEXT", "me@example.com", none, { shortenLinks: true, maxBodyChars: 0 });
  for (const max of [100, 1_000, 5_000]) {
    const out = await formatMessage(plain, "PLAIN_TEXT", "me@example.com", none, { shortenLinks: true, maxBodyChars: max });
    assert.equal(out.plaintextBody, limitLength(all.plaintextBody!, max).text);
  }
});

/** hideQuotedHistory for a reply, given the earlier messages of its thread. */
const hideIn = (reply: string, ...earlier: string[]) => hideQuotedHistory(reply, earlier.map(quoteKey));

test("quoted history is hidden in Gmail, Apple Mail and Outlook replies, in several languages", () => {
  const ask = "Can we meet at 3pm tomorrow?\n\nJohn";
  const gmail = "Sounds good.\n\nOn Mon, Jan 1, 2024 at 10:00 AM John <john@example.com> wrote:\n\n> Can we meet at 3pm tomorrow?\n>\n> John\n";
  assert.equal(hideIn(gmail, ask), `Sounds good.\n\n${QUOTE_HIDDEN}`);
  const wrapped = "Sounds good.\n\nOn Mon, Jan 1, 2024 at 10:00 AM Jonathan Livingston Seagull <jonathan@example.com>\nwrote:\n\n> Can we meet at 3pm tomorrow?\n>\n> John\n";
  assert.equal(hideIn(wrapped, ask), `Sounds good.\n\n${QUOTE_HIDDEN}`);
  // Apple Mail puts the attribution inside the quote.
  const apple = "Sounds good.\n\nSent from my iPhone\n\n> On Jan 1, 2024, at 10:00 AM, John <john@example.com> wrote:\n> \n> Can we meet at 3pm tomorrow?\n> \n> John\n";
  assert.equal(hideIn(apple, ask), `Sounds good.\n\nSent from my iPhone\n\n${QUOTE_HIDDEN}`);
  // Outlook: the header block (with the rule above it), or -----Original Message-----.
  const outlook = "Perfect.\n\n________________________________\nFrom: John <john@example.com>\nSent: Monday, January 1, 2024 10:00 AM\nTo: Me <me@example.com>\nSubject: Meeting\n\nCan we meet at 3pm tomorrow?\n\nJohn\n";
  assert.equal(hideIn(outlook, ask), `Perfect.\n\n${QUOTE_HIDDEN}`);
  const original = "Perfect.\n\n-----Original Message-----\nFrom: John <john@example.com>\nSent: Monday, January 1, 2024 10:00 AM\nTo: Me\nSubject: Meeting\n\nCan we meet at 3pm tomorrow?\nJohn\n";
  assert.equal(hideIn(original, ask), `Perfect.\n\n${QUOTE_HIDDEN}`);
  const german = "Passt, danke!\n\nVon: Hans Müller <hans@example.de>\nGesendet: Montag, 1. Januar 2024 10:00\nAn: Sebastian <me@example.com>\nBetreff: Treffen\n\nKönnen wir uns am Montag treffen?\n";
  assert.equal(hideIn(german, "Können wir uns am Montag treffen?"), `Passt, danke!\n\n${QUOTE_HIDDEN}`);
  const french = "Oui.\n\nDe : Marie Curie <marie@example.fr>\nEnvoyé : lundi 1 janvier 2024 10:00\nÀ : Sebastian <me@example.com>\nObjet : Réunion\n\nOn se voit lundi ?\n";
  assert.equal(hideIn(french, "On se voit lundi ?"), `Oui.\n\n${QUOTE_HIDDEN}`);
  // Below an Outlook header nobody answers between the lines, even if the quoted reply quotes with ">" itself.
  const earlierReply = "Friday works.\n\nOn Tue, Jan 2, 2024 at 9:00 AM Ann <ann@example.com> wrote:\n> Can we meet Friday?\n";
  const outlookOverQuotes = `Great, see you then.\n\nFrom: Bob <bob@example.com>\nSent: Tuesday, January 2, 2024 9:30 AM\nTo: Ann <ann@example.com>\nSubject: RE: Friday\n\n${earlierReply}`;
  assert.equal(hideIn(outlookOverQuotes, "Can we meet Friday?", earlierReply), `Great, see you then.\n\n${QUOTE_HIDDEN}`);
  // Attribution lines in other languages put the verb anywhere on the line.
  const question = "Können wir uns am Montag treffen?";
  for (const attribution of [
    "Am Mo., 1. Jan. 2024 um 10:00 Uhr schrieb Hans Müller <hans@example.de>:",
    "Am 01.01.2024 um 10:00 schrieb Hans Müller <hans@example.de>:",
    "Le lun. 1 janv. 2024 à 10:00, Marie Curie <marie@example.fr> a écrit :",
    "El lun, 1 ene 2024 a las 10:00, Juan Pérez (<juan@example.es>) escribió:",
    "Il giorno lun 1 gen 2024 alle ore 10:00 Marco Rossi <marco@example.it> ha scritto:",
    "Op ma 1 jan 2024 om 10:00 schreef Jan de Vries <jan@example.nl>:",
    "Den 1 jan. 2024 kl. 10:00 skrev Sven <sven@example.se>:",
    "pon., 1 sty 2024 o 10:00 Jan Kowalski <jan@example.pl> napisał(a):",
    "пн, 1 янв. 2024 г. в 10:00, Иван <ivan@example.ru>:",
  ]) {
    assert.equal(hideIn(`Ja.\n\n${attribution}\n\n> ${question}\n`, question), `Ja.\n\n${QUOTE_HIDDEN}`, attribution);
    assert.equal(hideIn(`Ja.\n\n> ${attribution}\n> \n> ${question}\n`, question), `Ja.\n\n${QUOTE_HIDDEN}`, `quoted ${attribution}`);
  }
  // A short message is hidden when quoted as it is.
  assert.equal(hideIn("You're welcome.\n\nOn Mon, Jan 1, 2024 at 10:00 AM Ann <ann@example.com> wrote:\n> Thanks!\n", "Thanks!"), `You're welcome.\n\n${QUOTE_HIDDEN}`);
});

test("a forwarded email, a quote from outside the thread and answers between quoted lines stay", () => {
  // Gmail's forward (fuzz repro thread-forward-hidden.txt): kept, even when the thread holds the forwarded email.
  const forward =
    "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Vendor Support <support@vendor.example>\nDate: Tue, Jan 2, 2024 at 4:15 PM\n" +
    "Subject: Ticket #4521\nTo: Sebastian <me@example.com>\n\n\nHi Sebastian,\n\nWe have identified the cause. A fix will ship on Jan 4.\n\nRegards,\nPriya\n";
  const vendor = "Hi Sebastian,\n\nWe have identified the cause. A fix will ship on Jan 4.\n\nRegards,\nPriya";
  assert.equal(hideIn(forward, "Any news from the vendor?"), forward);
  assert.equal(hideIn(forward, vendor), forward);
  for (const marker of ["---------- Weitergeleitete Nachricht ---------", "---------- Message transféré ---------", "-------- Forwarded Message --------", "Begin forwarded message:"]) {
    const localized = forward.replace("---------- Forwarded message ---------", marker);
    assert.equal(hideIn(localized, vendor), localized, marker);
  }
  // Outlook forwards look like replies: what doesn't copy an earlier message of the thread stays.
  const outlookForward = "Please handle.\n\nFrom: Vendor Support <support@vendor.example>\nSent: Tuesday, January 2, 2024 4:15 PM\nTo: Sebastian <me@example.com>\nSubject: Ticket #4521\n\nThanks for your patience, the fix ships on Jan 4.\n";
  assert.equal(hideIn(outlookForward, "Thanks", "Can you forward me their answer?"), outlookForward);
  // A quote of a message that isn't in the thread.
  const elsewhere = "Agreed.\n\nOn Mon, Jan 1, 2024 at 10:00 AM Jon <jon@example.com> wrote:\n> The budget for Q3 is approved.\n";
  assert.equal(hideIn(elsewhere, "Lunch on Friday?"), elsewhere);
  // Answers written between quoted lines.
  const inline = "Answers inline.\n\nOn Mon, Jan 1, 2024 at 10:00 AM Jon <jon@example.com> wrote:\n\n> Can you do Monday?\nYes.\n> And Tuesday?\nNo.\n";
  assert.equal(hideIn(inline, "Can you do Monday?\nAnd Tuesday?"), inline);
  // Prose that looks like an attribution, and no earlier messages at all.
  const prose = "Thanks!\n\nOn Monday the team wrote:\nWe are hiring two people.";
  assert.equal(hideIn(prose, "We are hiring two people."), prose);
  assert.equal(hideQuotedHistory("Sounds good.\n\nOn Mon, Jan 1, 2024 at 10:00 AM John <john@example.com> wrote:\n> Hi\n"), "Sounds good.\n\nOn Mon, Jan 1, 2024 at 10:00 AM John <john@example.com> wrote:\n> Hi\n");
});
