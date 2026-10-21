/**
 * A deterministic fuzz smoke test: a few hundred generated inputs per parser of untrusted email
 * content (fixed seeds, so every run sees the same ones). Each must finish without an exception
 * other than the module's own error classes, within a generous CPU bound, and agree with the
 * oracles below. Saved reproducers of past bugs are in test/fixtures.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  bareAddress,
  cleanBody,
  cleanSnippet,
  decodeCharset,
  formatMessage,
  formatThread,
  hideQuotedHistory,
  limitLength,
  parseAddressList,
  parseMailboxes,
  QUOTE_HIDDEN,
  quoteKey,
  recipientsFrom,
  shortenLinks,
  unflow,
  type ApiMessage,
} from "../src/format.js";
import { parseBatchResponse } from "../src/gmailClient.js";
import { unsubscribeOptions } from "../src/mailbox.js";
import { decodeEntities, escapeHtml, htmlToText, HtmlTextReader, isValidAddress } from "../src/mime.js";
import { addressInput, batchInput, charsetBytes, CHARSETS, entityInput, htmlInput, messageInput, rng, textInput, unsubscribeInput, type Rng } from "./fuzzGen.js";

/** Cases per target. */
const CASES = 300;
/** CPU per case, generously: every case takes a few milliseconds at most. */
const MAX_MS = 500;

/** C0 control characters that should never reach a result (all but tab and line feed). */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/;

/**
 * Generates CASES inputs for `target` (seeds differ per target) and runs `check` on each; any
 * exception fails the test, naming the target and seed, unless it is one of `allowed`.
 */
async function fuzz<T>(target: string, gen: (r: Rng) => T, check: (input: T) => unknown, allowed: (new (...args: never[]) => Error)[] = []) {
  for (let seed = 1; seed <= CASES; seed++) {
    const input = gen(rng(seed * 7919 + target.length));
    const start = process.cpuUsage();
    try {
      await check(input);
    } catch (err) {
      if (allowed.some((type) => err instanceof type)) continue;
      throw new Error(`${target}, seed ${seed}: ${(err as Error)?.stack ?? err}`);
    }
    const used = process.cpuUsage(start);
    const ms = (used.user + used.system) / 1000;
    assert.ok(ms < MAX_MS, `${target}, seed ${seed}: ${ms.toFixed(0)} ms of CPU`);
  }
}

describe("fuzz smoke test", () => {
  test("htmlToText: text laid out cleanly, the same when converted in steps", () =>
    fuzz("html", htmlInput, (html) => {
      const text = htmlToText(html);
      assert.equal(typeof text, "string");
      assert.doesNotMatch(text, CONTROLS);
      assert.doesNotMatch(text, /\n{3,}/);
      assert.doesNotMatch(text, /^\s|\s$/);
      // Converted in steps (as long bodies are), the text is the same as converted at once.
      const reader = new HtmlTextReader(html);
      let read = reader.read(60);
      for (let chars = 300; !read.complete; chars *= 5) read = reader.read(chars);
      assert.equal(read.text, text);
    }));

  test("htmlToText: escaped plain text comes back as it was, white space collapsed", () =>
    fuzz("htmlPlain", (r) => (r.chance(0.5) ? r.unicode(r.size(20_000, 100)) : r.str(r.size(20_000, 100), " \t\n\u00a0abc<>&\"'&#;x1F")), (text) => {
      const expected = text.replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "").replace(/[ \t\n\r\f\u00a0]+/g, " ").trim();
      assert.equal(htmlToText(escapeHtml(text)), expected);
    }));

  test("decodeEntities: numeric references decode like the reference", () =>
    fuzz("entities", entityInput, (text) => {
      const out = decodeEntities(text);
      if (/&[A-Za-z]/.test(text)) return; // named references are the module's own table
      const c1 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
      const reference = text.replace(/&#(?:[xX]([0-9a-fA-F]{1,8})|([0-9]{1,8}))(;?)/g, (_m, hex: string | undefined, dec: string | undefined) => {
        const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
        if (code >= 0x80 && code <= 0x9f) return c1[code - 0x80];
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
      });
      assert.equal(out, reference);
    }));

  test("address headers: parsed without errors, recipients are valid addresses", () =>
    fuzz("addresses", addressInput, (header) => {
      for (const mailbox of parseMailboxes(header)) assert.ok(mailbox.address.includes("@"));
      for (const mailbox of recipientsFrom(header, ["x@y.z"])) assert.ok(isValidAddress(mailbox.address));
      for (const item of parseAddressList(header)) assert.equal(item, item.trim());
      assert.equal(typeof bareAddress(header), "string");
    }));

  test("decodeCharset: valid UTF-8 is read as UTF-8 except under the labels that override it", () =>
    fuzz(
      "charset",
      (r) => ({ bytes: charsetBytes(r), declared: r.chance(0.2) ? undefined : r.pick(CHARSETS), partial: r.chance(0.2) }),
      ({ bytes, declared, partial }) => {
        const out = decodeCharset(bytes, declared, partial);
        assert.equal(typeof out, "string");
        const label = declared?.trim().replace(/^["']|["']$/g, "").toLowerCase();
        let valid: string | undefined;
        try {
          valid = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
        } catch {
          valid = undefined;
        }
        if (valid === undefined || (label && /^utf-?(16|32)/.test(label))) return;
        const nonAscii = bytes.filter((b) => b >= 0x80).length;
        if (!nonAscii && label && /^(?:iso-?2022|csiso2022|hz-|utf-?7)/.test(label)) return; // 7-bit charsets are read as declared
        if (label && /^(?:gb|big5|shift[-_]?jis|sjis|euc-|ks_c_5601)/.test(label) && nonAscii <= 8) {
          try {
            new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes, { stream: partial });
            return; // a few bytes valid in the declared East Asian charset are read as declared
          } catch {
            // not valid there: read as UTF-8
          }
        }
        assert.equal(out, valid);
      },
    ));

  test("text cleaning: bodies cleaned, quotes cut only after a marker, links and lengths cut safely", () =>
    fuzz(
      "text",
      (r) => ({ text: textInput(r), earlier: r.chance(0.5) ? textInput(r).slice(0, 3000) : "> quoted line" }),
      ({ text, earlier }) => {
        const body = cleanBody(text);
        assert.doesNotMatch(body, /\n{3,}|[^\S\n]\n|\r/);
        assert.doesNotMatch(body, CONTROLS);
        const hidden = hideQuotedHistory(text, [quoteKey(earlier)]);
        if (hidden !== text) assert.ok(hidden.endsWith(QUOTE_HIDDEN) && text.startsWith(hidden.slice(0, -QUOTE_HIDDEN.length).trim()));
        const short = shortenLinks(body).text;
        const limited = limitLength(short, 20_000).text;
        assert.ok(limited.length <= 20_000);
        const last = limited.charCodeAt(limited.length - 1);
        assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no split surrogate pair");
        cleanSnippet(text.slice(0, 500));
        unflow(text, true);
      },
    ));

  test("formatMessage and formatThread on generated Gmail payloads", () =>
    fuzz("mimeTree", (r) => [messageInput(r), messageInput(r)] as const, async ([first, second]) => {
      const loader = () => async (id: string) => (id.endsWith("x") ? Buffer.from(`loaded ${id}`).toString("base64url") : "");
      const check = (out: Awaited<ReturnType<typeof formatMessage>>, max: number) => {
        assert.ok((out.plaintextBody ?? "").length <= max);
        assert.doesNotMatch(out.plaintextBody ?? "", CONTROLS);
        assert.doesNotMatch(out.plaintextBody ?? "", /\r/);
        for (const attachment of out.attachments ?? []) assert.equal("id" in attachment, false);
        if (out.date !== undefined && /^\d{4}-/.test(out.date)) assert.match(out.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      };
      check(await formatMessage(first, "PLAIN_TEXT", "me@example.com", loader(), { shortenLinks: true, maxBodyChars: 2_000 }), 2_000);
      check(await formatMessage(first, "FULL_CONTENT", "me@example.com", loader()), 20_000);
      const thread: ApiMessage[] = [first, { ...second, id: `${second.id}2` }];
      for (const out of await formatThread(thread, "PLAIN_TEXT", "me@example.com", loader, { hideQuotedHistory: true, shortenLinks: true })) check(out, 20_000);
    }));

  test("List-Unsubscribe: options only as the header allows", () =>
    fuzz("unsub", unsubscribeInput, ({ header, post }) => {
      const out = unsubscribeOptions(header, post);
      if (out.oneClick) {
        assert.match(out.oneClick, /^https:/);
        assert.match(post ?? "", /^\s*List-Unsubscribe=One-Click\s*$/i);
      }
      if (out.mailto) {
        assert.ok(isValidAddress(out.mailto.to));
        assert.doesNotMatch(out.mailto.to + out.mailto.subject, /[\r\n]/);
      }
    }));

  test("Gmail batch responses: each request's answer, as the generator built it", () =>
    fuzz("batch", batchInput, ({ text, contentType, count, expected }) => {
      const out = parseBatchResponse(text, contentType, count);
      assert.equal(out.length, count);
      if (!expected) return;
      expected.forEach((answer, i) => {
        if (answer) assert.deepEqual(out[i], answer, `response ${i}`);
      });
    }));

  test("saved reproducers of past bugs", () => {
    const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8");
    // A mailto: link with a bad %-escape threw URIError and failed the whole message.
    assert.equal(htmlToText(fixture("html-mailto-bad-escape.html")), "Hi\n\n%zz@x.y");
    // A forwarded email was hidden as if it were quoted history; it stays, even when the thread holds it.
    const forward = fixture("thread-forward-hidden.txt");
    const vendor = forward.slice(forward.indexOf("Hi Sebastian"));
    assert.equal(hideQuotedHistory(forward, [quoteKey("Any news from the vendor?"), quoteKey(vendor)]), forward);
  });
});
