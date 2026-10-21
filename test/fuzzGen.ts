/**
 * Deterministic generators of hostile and odd input for the fuzz smoke test (test/fuzz.test.ts):
 * a seeded PRNG, string mutators, HTML, address lists, charset bytes, plain text with reply markers,
 * Gmail message payloads, List-Unsubscribe headers and batch responses. Trimmed from a larger fuzzing
 * harness; sizes are kept small enough for a few hundred cases per target to run in a second or two.
 */
import { Buffer } from "node:buffer";
import type { ApiMessage, ApiMessagePart } from "../src/format.js";

export interface Rng {
  f(): number;
  int(n: number): number;
  range(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Mostly small (below `typical`), sometimes up to 16 or 256 times that, rarely up to `max`. */
  size(max: number, typical?: number): number;
  bytes(n: number): Buffer;
  str(n: number, alphabet: string): string;
  word(lo?: number, hi?: number): string;
  /** Text with surrogate pairs, combining marks, invisible characters and control characters. */
  unicode(n: number): string;
}

/** mulberry32: small, fast and deterministic. */
export function rng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r: Rng = {
    f: next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    size: (max, typical = 64) => {
      const u = next();
      if (u < 0.6) return Math.floor(next() * typical);
      if (u < 0.9) return Math.floor(next() * Math.min(max, typical * 16));
      if (u < 0.99) return Math.floor(next() * Math.min(max, typical * 256));
      return Math.floor(next() * max);
    },
    bytes: (n) => {
      const b = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i++) b[i] = (next() * 256) | 0;
      return b;
    },
    str: (n, alphabet) => {
      let s = "";
      for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)];
      return s;
    },
    word: (lo = 1, hi = 10) => r.str(r.range(lo, hi), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    unicode: (n) => {
      let s = "";
      for (let i = 0; i < n; i++) {
        const u = next();
        if (u < 0.5) s += String.fromCharCode(0x20 + Math.floor(next() * 95));
        else if (u < 0.7) s += String.fromCharCode(0xa0 + Math.floor(next() * 0x60));
        else if (u < 0.8) s += String.fromCodePoint(0x1f300 + Math.floor(next() * 0x200));
        else if (u < 0.85) s += String.fromCharCode(0x300 + Math.floor(next() * 0x70));
        else if (u < 0.9) s += r.pick(["\u200b", "\u200c", "\u200d", "\u200e", "\ufeff", "\u00ad", "\u2060", "\u180e", "\u3164", "\u2800"]);
        else if (u < 0.95) s += String.fromCharCode(0x4e00 + Math.floor(next() * 0x1000));
        else s += r.pick(["\n", "\r\n", "\t", " ", "  ", "\u00a0", "\f", "\v", "\0", "\x1b", "\x7f"]);
      }
      return s;
    },
  };
  return r;
}

/** Random edits: bit flips, cut, duplicated or moved chunks, inserted tokens, repetition, truncation. */
export function mutate(r: Rng, s: string, tokens: readonly string[], rounds: number): string {
  for (let k = 0; k < rounds; k++) {
    if (!s.length) s = r.pick(tokens.length ? tokens : ["x"]);
    const i = r.int(s.length);
    const j = Math.min(s.length, i + r.size(Math.max(1, s.length - i), 16));
    switch (r.int(8)) {
      case 0:
        s = s.slice(0, i) + String.fromCharCode((s.charCodeAt(i) ^ (1 << r.int(8))) & 0xffff) + s.slice(i + 1);
        break;
      case 1:
        s = s.slice(0, i) + s.slice(j);
        break;
      case 2:
        s = s.slice(0, j) + s.slice(i, j) + s.slice(j);
        break;
      case 3:
        s = s.slice(0, i) + r.pick(tokens) + s.slice(i);
        break;
      case 4: {
        const times = r.pick([2, 3, 10, 100, 1000]);
        if ((j - i) * times < 200_000) s = s.slice(0, i) + s.slice(i, j).repeat(times) + s.slice(j);
        break;
      }
      case 5:
        s = s.slice(0, i) + r.unicode(r.size(64, 8)) + s.slice(i);
        break;
      case 6:
        s = s.slice(0, r.int(s.length + 1));
        break;
      default: {
        const a = r.int(s.length);
        const b = r.int(s.length);
        s = s.slice(0, Math.min(a, b)) + s.slice(Math.max(a, b)) + s.slice(Math.min(a, b), Math.max(a, b));
      }
    }
  }
  return s;
}

// ---------- HTML ----------

const HTML_TAGS = ["div", "p", "span", "b", "i", "a", "img", "br", "table", "tbody", "tr", "td", "th", "ul", "ol", "li", "pre", "script", "style", "h1", "h2", "blockquote", "font", "center", "hr", "title", "iframe", "xmp", "template", "dl", "dt", "dd", "section", "form", "o:p", "html", "body", "head", "meta", "strong", "em", "small", "input"];
export const ENTITY_SAMPLES = ["&amp;", "&lt;", "&gt;", "&quot;", "&nbsp;", "&#160;", "&#xA0;", "&#39;", "&apos;", "&amp", "&lt", "&zwnj;", "&zwj;", "&#8203;", "&eacute;", "&Eacute;", "&euro;", "&#128512;", "&#x1F600;", "&#0;", "&#1;", "&#xF;", "&#xD800;", "&#x110000;", "&#146;", "&bogus;", "&constructor;", "&__proto__;", "&", "&#", "&#x", "&;", "&#;", "&amp;amp;", "&#99999999;", "&#xFFFFFFFF;", "&AMP;", `&${"a".repeat(40)};`];
export const HTML_TOKENS = ["<", ">", "</", "<!--", "-->", "<!-->", "<![CDATA[", "]]>", "<?xml ?>", "<!DOCTYPE html>", '"', "'", "=", "/", "<a href=", '<a href="', "</a>", "<br>", "<pre>", "</pre>", "<script>", "</script>", "<style>", "</style>", "<td>", "</td>", "<li>", "<ol start=5>", "<table>", "<img alt='x'>", "\u00a0", "&nbsp;", "&", "&#", "\n", "\r\n", "\t", " ", "javascript:", "mailto:", '<div style="display:none">', '<span style="max-height:0;overflow:hidden">', "<p hidden>", "</div>"];

function genAttrs(r: Rng, tag: string): string {
  let out = "";
  const n = r.chance(0.5) ? 0 : r.size(12, 3);
  for (let i = 0; i < n; i++) {
    const name = r.pick(["href", "alt", "start", "src", "class", "style", "hidden", "id", "title", r.word(1, 6), "=", '"', "'", "/"]);
    const u = r.f();
    let value: string | undefined;
    if (u < 0.3) value = `"${r.unicode(r.size(40, 8)).replace(/"/g, "")}"`;
    else if (u < 0.5) value = `'${r.unicode(r.size(40, 8)).replace(/'/g, "")}'`;
    else if (u < 0.65) value = r.word(0, 12);
    else if (u < 0.8) value = `"${r.pick(["http://x.y/z", "mailto:a@b.c?subject=hi", "mailto:%zz@x.y", "javascript:alert(1)", "#top", "cid:img1", "display:none", "max-height:0;overflow:hidden", `http://a.b/${r.str(300, "abc123/?&=")}`])}"`;
    else if (u < 0.85) value = '"unterminated';
    out += r.pick([" ", "  ", "\n", "\t", "/"]) + name + (value === undefined ? "" : r.pick(["=", " = ", "= "]) + value);
  }
  if (tag === "ol" && r.chance(0.5)) out += ` start=${r.pick(["3", "-1", "0", "99999999999999999999", "x", ""])}`;
  return out;
}

export function genHtml(r: Rng, budget = 400): string {
  const parts: string[] = [];
  const open: string[] = [];
  while (budget > 0) {
    const u = r.f();
    if (u < 0.35) {
      const text = r.chance(0.7) ? r.word(0, 12) + r.pick([" ", "  ", "\n", "", ".", ", "]) : r.unicode(r.size(60, 10));
      parts.push(text);
      budget -= text.length || 1;
    } else if (u < 0.45) {
      parts.push(r.pick(ENTITY_SAMPLES));
      budget -= 5;
    } else if (u < 0.75) {
      const tag = r.pick(HTML_TAGS);
      const tagText = `<${r.chance(0.1) ? tag.toUpperCase() : tag}${genAttrs(r, tag)}${r.pick(["", " ", "/"])}>`;
      parts.push(tagText);
      budget -= tagText.length;
      if (["script", "style", "title", "xmp", "template", "iframe"].includes(tag) && r.chance(0.8)) {
        const body = r.chance(0.5) ? r.unicode(r.size(60, 10)) : `var a = "<b>" + ${r.int(100)}; // </ script </${tag}x`;
        parts.push(body, r.chance(0.9) ? `</${tag}>` : "");
        budget -= body.length;
      } else if (!["br", "img", "hr", "meta", "input"].includes(tag)) open.push(tag);
    } else if (u < 0.9) {
      const tag = open.length && r.chance(0.8) ? open.pop()! : r.pick(HTML_TAGS);
      parts.push(r.chance(0.95) ? `</${tag}>` : `</${tag}`);
      budget -= 4;
    } else if (u < 0.95) {
      parts.push(r.pick(["<!-- c -->", "<!-- unterminated", "<!---->", "<!-->", "<!--->", "<!DOCTYPE html>", "<?xml version='1.0'?>", "</ x>", "</>", "< b>", "<1>", "<", ">", "<<<<<", "<!", "<!-"]));
      budget -= 5;
    } else {
      parts.push(r.pick(HTML_TOKENS));
      budget -= 3;
    }
  }
  if (r.chance(0.5)) for (const tag of open.reverse()) parts.push(`</${tag}>`);
  return parts.join("");
}

/** HTML for htmlToText: generated, mutated, random bytes or text, or deeply nested or repeated. */
export function htmlInput(r: Rng): string {
  const u = r.f();
  if (u < 0.45) return genHtml(r, r.size(40_000, 400));
  if (u < 0.75) return mutate(r, genHtml(r, r.size(10_000, 300)), HTML_TOKENS, r.range(1, 8));
  if (u < 0.85) return r.bytes(r.size(20_000, 200)).toString("latin1");
  if (u < 0.95) return r.unicode(r.size(20_000, 200));
  const inner = genHtml(r, 40);
  const wrap = r.pick(["div", "p", "ul", "ol", "li", "a href=x", "pre", "table", "tr", "td", "blockquote", 'div style="display:none"']);
  const n = r.pick([10, 100, 1000, 5000]);
  const close = `</${wrap.split(" ")[0]}>`;
  return r.chance(0.5) ? `<${wrap}>`.repeat(n) + inner + close.repeat(n) : (`<${wrap}>${inner}${close}`).repeat(n);
}

/** Character references, mostly numeric, in runs and mixed with text. */
export function entityInput(r: Rng): string {
  const u = r.f();
  if (u < 0.3) return r.str(r.size(50_000, 200), "&#;xX0123456789abcdefABCDEFghijklmnopq=");
  if (u < 0.6) {
    let s = "";
    for (let i = r.size(2000, 20); i > 0; i--) s += r.pick(ENTITY_SAMPLES) + (r.chance(0.3) ? r.word(0, 4) : "");
    return s;
  }
  if (u < 0.8) return r.pick(["&", "&#", "&#x", "&a", "&amp", "&amp;", "&#1", "&#x1", "&;"]).repeat(r.size(100_000, 1000));
  return mutate(r, r.pick(ENTITY_SAMPLES).repeat(r.size(1000, 10)), ["&", "#", ";", "x", "0", "a"], r.range(1, 5));
}

// ---------- addresses ----------

const ADDRESS_TOKENS = ["<", ">", "(", ")", '"', "\\", ",", ";", ":", "@", " ", "\t", "\r\n ", "=?UTF-8?B?w6k=?=", '\\"', "\\(", ".", "[", "]", "undisclosed-recipients:;", "group:", "\u00e9", "\u200b"];

export function genMailbox(r: Rng): string {
  const local = r.chance(0.8) ? r.word(1, 12) : `"${r.pick(["john doe", "a,b", "x<y>z", 'q\\"q', "(paren)", ";semi", "ü"])}"`;
  const domain = r.chance(0.9) ? `${r.word(1, 10)}.${r.pick(["com", "org", "co.uk", "de"])}` : r.pick(["[127.0.0.1]", "localhost", "", "x"]);
  const address = `${local}@${domain}`;
  const u = r.f();
  const name =
    u < 0.3
      ? undefined
      : u < 0.55
        ? `${r.word(1, 10)} ${r.word(1, 10)}`
        : u < 0.75
          ? `"${r.pick(["Doe, John", 'John \\"JD\\" Doe', "Smith; Jane", "x@y.z", "<fake@x.com>", "a:b", "(c)", "Müller"])}"`
          : r.unicode(r.size(30, 8)).replace(/[\r\n]/g, "");
  if (name === undefined) return r.chance(0.3) ? `<${address}>` : address;
  return r.chance(0.8) ? `${name} <${address}>` : `${address} (${name.replace(/[()]/g, "")})`;
}

export function addressInput(r: Rng): string {
  const u = r.f();
  if (u < 0.5) {
    const text = Array.from({ length: r.size(50, 3) }, () => genMailbox(r)).join(r.pick([", ", ",", ",\r\n ", ";", ", , "]));
    return r.chance(0.5) ? text : mutate(r, text, ADDRESS_TOKENS, r.range(1, 6));
  }
  if (u < 0.65) return r.str(r.size(100_000, 200), '<>()",;:@ \\abc\r\n');
  if (u < 0.85) return r.pick(["(", ")", "<", ">", '"', "\\", "(a", "<a", '"a', "\\(", "a,", "a:", ";", ", "]).repeat(r.size(200_000, 1000)) + r.pick(["", "x@y.z", ">", ")", '"']);
  return r.unicode(r.size(20_000, 100));
}

// ---------- charsets ----------

export const CHARSETS = ["utf-8", "UTF-8", "utf8", "us-ascii", "iso-8859-1", "windows-1252", "iso-8859-15", "windows-1251", "koi8-r", "shift_jis", "Shift-JIS", "euc-jp", "iso-2022-jp", "gb2312", "gbk", "gb18030", "big5", "euc-kr", "ks_c_5601-1987", "utf-16", "utf-16le", "utf-16be", "x-mac-roman", "x-user-defined", "unicode-1-1-utf-8", "", "bogus", '"utf-8"', " utf-8 "];

export function charsetBytes(r: Rng): Buffer {
  const u = r.f();
  const n = r.size(20_000, 64);
  if (u < 0.3) return r.bytes(n);
  if (u < 0.6) return Buffer.from(r.unicode(n), "utf8");
  if (u < 0.7) return Buffer.from(r.str(n, "abcdef \n"), "latin1");
  if (u < 0.8) return Buffer.from(r.unicode(n), "latin1");
  if (u < 0.9) return Buffer.from(r.unicode(n), "utf16le");
  return Buffer.concat([Buffer.from(r.pick(["\xef\xbb\xbf", "\xff\xfe", "\xfe\xff", "\x1b$B", ""]), "latin1"), r.bytes(n)]);
}

// ---------- plain text with reply markers ----------

const QUOTE_LINES = [
  "On Mon, Jan 1, 2024 at 10:00 AM John Doe <john@example.com> wrote:",
  "On Mon, Jan 1, 2024 at 10:00 AM John Doe\n<john@example.com> wrote:",
  "Am 01.01.2024 um 10:00 schrieb Hans Müller:",
  "Le 1 janv. 2024 à 10:00, Marie Curie a écrit :",
  "> On Jan 1, 2024, at 10:00 AM, John <john@example.com> wrote:",
  "-----Original Message-----",
  "From: John Doe\nSent: Monday, January 1, 2024 10:00 AM\nTo: Jane\nSubject: Re: hi",
  "Von: Hans\nGesendet: Montag\nAn: Jane\nBetreff: Hallo",
  "---------- Forwarded message ---------",
  "________________________________",
  "On Monday the team wrote:",
  "> quoted line",
  ">> nested quote",
];
const TEXT_TOKENS = ["\n", "\r\n", "\r", "\t", "  ", "\u00a0", "\u200b", "\u200c", "\u200d", "\u00ad", "\ufeff", "\u3164", "\u202e", `https://example.com/${"a".repeat(250)}`, "http://x.y/z?q=1", "https://", ">", "> ", "On ", " wrote:", "wrote:", "schrieb:", "From: ", "Sent: ", "To: ", "\u0301", "é", "\x01", "\x0b"];

export function textInput(r: Rng): string {
  const u = r.f();
  if (u < 0.35) {
    let s = "";
    for (let i = r.size(1000, 30); i > 0; i--) s += r.chance(0.6) ? r.word(0, 8) + r.pick([" ", "\n", ". "]) : r.chance(0.5) ? r.pick(TEXT_TOKENS) : `${r.pick(QUOTE_LINES)}\n`;
    return s;
  }
  if (u < 0.5) return r.pick(TEXT_TOKENS).repeat(r.size(100_000, 1000));
  if (u < 0.7) return r.unicode(r.size(50_000, 500));
  if (u < 0.85) return mutate(r, QUOTE_LINES.join("\n"), TEXT_TOKENS, r.range(1, 10));
  return `${"On " + r.str(r.range(1, 320), "abc 0123 ,:")}${r.chance(0.5) ? " wrote:" : ""}\n`.repeat(r.size(5_000, 50));
}

// ---------- Gmail message payloads ----------

const MIME_TYPES = ["text/plain", "text/html", "text/calendar", "multipart/mixed", "multipart/alternative", "multipart/related", "multipart/report", "message/rfc822", "message/delivery-status", "image/png", "application/pdf", "application/octet-stream", "application/ics", "", "TEXT/PLAIN", "x/y"];

function genPart(r: Rng, depth: number, budget: { n: number }, state: { next: number; maxDepth: number; maxWidth: number }): ApiMessagePart {
  const mimeType = r.chance(0.05) ? r.unicode(10) : r.pick(MIME_TYPES);
  const headers: { name: string; value: string }[] = [];
  if (r.chance(0.8)) headers.push({ name: r.pick(["Content-Type", "content-type"]), value: `${mimeType}; charset=${r.pick(CHARSETS)}${r.chance(0.2) ? "; format=flowed; delsp=yes" : ""}` });
  if (r.chance(0.3)) headers.push({ name: "Content-Disposition", value: r.pick(["inline", "attachment", `attachment; filename="${r.unicode(10)}"`, "INLINE", ""]) });
  if (r.chance(0.3)) headers.push({ name: "Content-ID", value: r.pick(["<img1@x>", "img2", "<>", "", `<${r.unicode(20)}>`]) });
  const part: ApiMessagePart = { partId: String(state.next++), mimeType, headers };
  if (r.chance(0.3)) part.filename = r.pick(["", "a.pdf", "image.png", "x.eml", "invite.ics", r.unicode(12)]);
  const multi = mimeType.toLowerCase().startsWith("multipart/") || (mimeType.toLowerCase().startsWith("message/") && r.chance(0.6));
  if (multi && depth < state.maxDepth && budget.n > 0) {
    part.parts = [];
    for (let i = r.range(0, Math.min(budget.n, state.maxWidth)); i > 0 && budget.n > 0; i--) {
      budget.n--;
      part.parts.push(genPart(r, depth + 1, budget, state));
    }
    part.body = { size: 0 };
  } else {
    const content = r.chance(0.4) ? genHtml(r, r.size(5000, 100)) : r.chance(0.5) ? r.unicode(r.size(5000, 100)) : textInput(r).slice(0, 20_000);
    const data = Buffer.from(content, "utf8").toString("base64url");
    const u = r.f();
    if (u < 0.6) part.body = { size: data.length, data };
    else if (u < 0.8) part.body = { size: r.int(100_000), attachmentId: `ATT${r.word(5, 10)}${r.chance(0.5) ? "x" : ""}` };
    else if (u < 0.9) part.body = { size: 0 };
    else part.body = { data: r.pick(["", "!!!", "YQ", "=", r.bytes(20).toString("latin1")]) };
  }
  return part;
}

export function messageInput(r: Rng): ApiMessage {
  const u = r.f();
  const shape = u < 0.8 ? {} : u < 0.9 ? { maxDepth: 300, maxWidth: 1, parts: 300 } : { maxDepth: 1, maxWidth: 1000, parts: 1000 };
  const state = { next: 0, maxDepth: shape.maxDepth ?? r.pick([1, 2, 3, 5, 8]), maxWidth: shape.maxWidth ?? r.pick([1, 2, 3, 5, 20]) };
  const payload = genPart(r, 0, { n: shape.parts ?? r.pick([1, 3, 10, 50]) }, state);
  payload.headers = [
    ...(payload.headers ?? []),
    { name: "Subject", value: r.chance(0.3) ? r.unicode(r.size(2000, 40)) : `Re: ${r.word(3, 20)}` },
    { name: "From", value: genMailbox(r) },
    { name: "To", value: Array.from({ length: r.range(0, 5) }, () => genMailbox(r)).join(", ") },
    { name: "Date", value: r.pick(["Mon, 1 Jan 2024 10:00:00 +0000", "garbage", ""]) },
  ];
  return {
    id: r.word(10, 16),
    threadId: "thread",
    labelIds: ["INBOX"],
    snippet: r.chance(0.8) ? r.pick(["Hello &amp; welcome", "&#8203;&zwnj;&nbsp;".repeat(r.size(500, 10)), r.unicode(r.size(500, 50))]) : undefined,
    internalDate: r.pick(["1704103200000", "", "0", "not a time", undefined]),
    payload,
  };
}

// ---------- List-Unsubscribe ----------

const URI_SAMPLES = ["https://example.com/unsub?u=1", "http://example.com/u", "mailto:unsub@example.com", "mailto:unsub@example.com?subject=unsubscribe%20me&body=please", "mailto:a@b.c,d@e.f", "mailto:%zz@x.y", "mailto:?subject=x", "ftp://x.y/", "javascript:alert(1)", "https://[::1]/", "https://127.0.0.1/", "https://localhost/", "https://user:pass@example.com/", "https://example.com:8443/x", "", "<>", "mailto:", 'mailto:"a b"@x.y', `mailto:a@b.c?subject=${"x".repeat(5000)}`];

export function unsubscribeInput(r: Rng): { header: string; post: string | undefined } {
  const u = r.f();
  let header: string;
  if (u < 0.4) {
    const uris = Array.from({ length: r.size(20, 3) }, () => (r.chance(0.3) ? `https://${r.word(2, 10)}.com/${r.word(0, 20)}` : r.pick(URI_SAMPLES)));
    header = uris.map((x) => (r.chance(0.85) ? `<${x}>` : x)).join(r.pick([", ", ",", " ,", ",\r\n ", " "]));
  } else if (u < 0.6) header = r.str(r.size(100_000, 100), "<>,; https://mailto:abc.?=&%\r\n");
  else if (u < 0.8) header = r.pick(["<", ">", "<<", "<>", ",", "<https://x.y/>,", "<mailto:a@b.c>,", "<a"]).repeat(r.size(100_000, 1000)) + r.pick(["", ">", "<"]);
  else header = r.unicode(r.size(20_000, 100));
  return { header, post: r.pick([undefined, "List-Unsubscribe=One-Click", " list-unsubscribe=one-click ", "x", ""]) };
}

// ---------- Gmail batch responses ----------

export interface BatchCase {
  text: string;
  contentType: string;
  count: number;
  /** What a correct parser returns for each request, when the generator can tell. */
  expected?: ({ status: number; body: string } | undefined)[];
}

export function batchInput(r: Rng): BatchCase {
  const boundary = `batch_${r.word(8, 20)}`;
  const count = r.range(0, 40);
  const expected = new Array<{ status: number; body: string } | undefined>(count);
  const parts: string[] = [];
  let boundaryInBody = false;
  for (let i = r.range(0, count + 5); i > 0; i--) {
    const id = r.chance(0.9) ? r.int(count + 2) : r.pick([-1, 1e10]);
    const status = r.chance(0.9) ? r.pick([200, 404, 429, 500, 403]) : r.pick(["20", "abc", ""]);
    const body = r.chance(0.8) ? JSON.stringify({ id: r.word(5), snippet: r.unicode(r.size(500, 20)), data: r.chance(0.3) ? `--${boundary}` : "" }) : r.unicode(r.size(1000, 30));
    const nl = r.pick(["\r\n", "\n"]);
    const withId = r.chance(0.9);
    parts.push(`--${boundary}${nl}Content-Type: application/http${nl}${withId ? `Content-ID: <response-item-${id}>${nl}` : ""}${nl}HTTP/1.1 ${status} OK${nl}Content-Type: application/json${nl}${nl}${body}${nl}`);
    if (body.includes(`--${boundary}`)) boundaryInBody = true;
    if (withId && id >= 0 && id < count && /^\d{3}$/.test(String(status))) expected[id] = { status: Number(status), body: body.trim() };
  }
  let text = `${parts.join("")}--${boundary}--${r.pick(["", "\r\n", "trailing garbage"])}`;
  const mutated = r.chance(0.3);
  if (mutated) text = mutate(r, text, ["--", boundary, "\r\n\r\n", "Content-ID: <response-item-", "HTTP/1.1 200", ">", "<"], r.range(1, 6));
  return { text, contentType: `multipart/mixed; boundary=${r.chance(0.5) ? `"${boundary}"` : boundary}`, count, expected: mutated || boundaryInBody ? undefined : expected };
}
