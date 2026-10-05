import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountStore } from "../src/accountStore.js";
import { TokenProvider } from "../src/gmailClient.js";
import { AuthError } from "../src/google.js";
import { createServer } from "../src/server.js";
import { FakeGmail, FakeWeb, parseHeaders, type FakeMailbox } from "./fakeGmail.js";
import { docx, pdf, png, xlsx } from "./files.js";

const PERSONAL = "me.personal@gmail.com";
const WORK = "me@work.example";

const tmpDirs: string[] = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function crlf(lines: string[]): string {
  return lines.join("\r\n");
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

interface Ctx {
  fake: FakeGmail;
  web: FakeWeb;
  store: AccountStore;
  client: Client;
  personal: FakeMailbox;
  work: FakeMailbox;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;
}

async function setup(
  opts: { accounts?: "both" | "personal"; defaultAccount?: string; maxAttachmentBytes?: number; maxAttachmentNote?: string } = {},
): Promise<Ctx> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-test-"));
  tmpDirs.push(dir);
  const store = new AccountStore(dir);
  const fake = new FakeGmail();
  const personal = fake.addMailbox(PERSONAL, "rt-personal");
  const work = fake.addMailbox(WORK, "rt-work");

  await store.upsert({ email: PERSONAL, alias: "personal", refreshToken: "rt-personal", scopes: [], addedAt: "" });
  if (opts.accounts !== "personal") {
    await store.upsert({ email: WORK, alias: "work", refreshToken: "rt-work", scopes: [], addedAt: "" });
  }
  if (opts.defaultAccount) await store.setDefault(opts.defaultAccount);

  // personal: a plain lunch invite with a CC
  fake.deliver(
    personal,
    crlf([
      "From: Alice <alice@example.com>",
      `To: ${PERSONAL}, "Doe, Bob" <bob@example.com>`,
      "Cc: carol@example.com",
      "Subject: Lunch?",
      "Date: Mon, 1 Sep 2026 12:00:00 +0000",
      "Message-ID: <lunch-1@example.com>",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Want to grab lunch?\r\nThursday works.",
    ]),
    { id: "p1", threadId: "pt1" },
  );

  // work: HTML-only body with a PDF attachment
  fake.deliver(
    work,
    crlf([
      "From: Boss <boss@work.example>",
      `To: ${WORK}`,
      "Subject: Q3 report",
      "Date: Tue, 2 Sep 2026 09:00:00 +0000",
      "Message-ID: <q3@work.example>",
      'Content-Type: multipart/mixed; boundary="XX"',
      "",
      "--XX",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("<p>Please review the <b>attached</b> report &amp; reply.</p><p>Thanks</p>"),
      "--XX",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("%PDF-1.4 fake pdf bytes"),
      "--XX--",
    ]),
    { id: "w1", threadId: "wt1" },
  );
  fake.deliver(
    work,
    crlf(["From: hr@work.example", `To: ${WORK}`, "Subject: Benefits", "Content-Type: text/plain", "", "Enroll now."]),
    { id: "w2", threadId: "wt2" },
  );
  work.labels.push({ id: "Label_7", name: "Reports", type: "user" });

  const web = new FakeWeb();
  const server = createServer({
    store,
    fetchImpl: fake.fetch,
    tokens: new TokenProvider(async () => ({ clientId: "cid", clientSecret: "secret" }), fake.fetch),
    webFetch: web.fetch,
    resolveHost: web.resolve,
    maxAttachmentBytes: opts.maxAttachmentBytes,
    maxAttachmentNote: opts.maxAttachmentNote,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0].text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(res.isError), text, json };
  };
  return { fake, web, store, client, personal, work, call };
}

/** Pulls headers and decoded text parts out of a raw MIME message for assertions. */
function inspectMime(raw: string) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headers = parseHeaders(raw.slice(0, headerEnd));
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
  const decoded: { type: string; text: string; filename?: string }[] = [];
  const partRe = /Content-Type: ([^;\r\n]+)[^\r\n]*(?:\r\n[^\r\n]+)*?\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--)/g;
  for (const m of raw.matchAll(partRe)) {
    const filename = /filename="([^"]+)"/.exec(m[0])?.[1];
    decoded.push({ type: m[1], text: Buffer.from(m[2].replace(/\r\n/g, ""), "base64").toString("utf8"), filename });
  }
  if (!decoded.length) {
    // single-part message
    decoded.push({ type: get("Content-Type")!.split(";")[0], text: Buffer.from(raw.slice(headerEnd + 4), "base64").toString("utf8") });
  }
  return { get, parts: decoded };
}

describe("tool catalogue", () => {
  test("mirrors the Gmail connector's tools, plus accounts, attachments and bulk changes", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "bulk_trash",
      "bulk_update",
      "create_draft",
      "create_label",
      "delete_draft",
      "delete_label",
      "forward",
      "get_attachment",
      "get_draft",
      "get_message",
      "get_thread",
      "label_message",
      "label_thread",
      "list_accounts",
      "list_drafts",
      "list_labels",
      "mark_message_spam",
      "mark_thread_spam",
      "reply",
      "search_threads",
      "send_message",
      "trash_message",
      "trash_thread",
      "unlabel_message",
      "unlabel_thread",
      "unmark_message_spam",
      "unmark_thread_spam",
      "unsubscribe",
      "untrash_message",
      "untrash_thread",
      "update_draft",
      "update_label",
      "update_message_labels",
    ]);
    for (const tool of tools.filter((t) => t.name !== "list_accounts")) {
      assert.ok((tool.inputSchema.properties as Record<string, unknown>).account, `${tool.name} takes an account`);
    }
    const labelThread = tools.find((t) => t.name === "label_thread")!;
    assert.deepEqual(labelThread.inputSchema.required?.sort(), ["labelIds", "threadId"]);
  });
});

describe("accounts", () => {
  test("list_accounts shows every linked account", async () => {
    const { call } = await setup({ defaultAccount: "work" });
    const res = await call("list_accounts");
    assert.deepEqual(res.json.accounts, [
      { email: PERSONAL, alias: "personal", isDefault: false, status: "ok" },
      { email: WORK, alias: "work", isDefault: true, status: "ok" },
    ]);
  });

  test("list_accounts says which accounts need re-linking, without failing", async () => {
    const { call, fake } = await setup();
    fake.revoked.add("rt-work");
    const res = await call("list_accounts");
    assert.equal(res.isError, false, res.text);
    const [personal, work] = res.json.accounts;
    assert.equal(personal.status, "ok");
    assert.equal(work.status, "needs re-link");
    assert.match(work.hint, /me@work\.example: authorization expired or was revoked\. Re-link it/);

    const other = await setup();
    other.fake.tokenOutage = 503;
    const outage = await other.call("list_accounts");
    assert.equal(outage.isError, false);
    assert.ok(outage.json.accounts.every((a: any) => a.status === "couldn't check" && /token refresh failed \(503\)/.test(a.error)), outage.text);
  });

  test("single-account tools need `account` when several are linked and no default is set", async () => {
    const { call } = await setup();
    const res = await call("get_thread", { threadId: "pt1" });
    assert.equal(res.isError, true);
    assert.match(res.text, /pass `account`/);
    assert.match(res.text, /me\.personal@gmail\.com \(personal\)/);
  });

  test("reads fall back to the default account", async () => {
    const { call } = await setup({ defaultAccount: WORK });
    const res = await call("get_thread", { threadId: "wt1" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.account, WORK);
  });

  test("with a single account, `account` can be omitted everywhere", async () => {
    const { call } = await setup({ accounts: "personal" });
    const res = await call("send_message", { to: ["x@example.com"], subject: "hi", body: "yo" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.account, PERSONAL);
  });

  test("unknown account names are rejected with the list of linked accounts", async () => {
    const { call } = await setup();
    const res = await call("get_message", { account: "school", messageId: "p1" });
    assert.equal(res.isError, true);
    assert.match(res.text, /No linked Gmail account matches "school"/);
  });

  test("an ID used with the wrong account explains that IDs are per account", async () => {
    const { call } = await setup();
    const res = await call("get_message", { account: "work", messageId: "p1" });
    assert.equal(res.isError, true);
    assert.match(res.text, /belong to a single Gmail account/);
  });

  test("a revoked account gives a re-link hint", async () => {
    const { call, fake } = await setup();
    fake.revoked.add("rt-work");
    const res = await call("get_thread", { account: "work", threadId: "wt1" });
    assert.equal(res.isError, true);
    assert.match(res.text, /me@work\.example: authorization expired or was revoked\. Re-link it/);
  });

  test("an expired access token is refreshed and the call retried", async () => {
    const { call, fake } = await setup();
    assert.equal((await call("get_thread", { account: "work", threadId: "wt1" })).isError, false);
    const used = fake.requests.at(-1)!;
    assert.equal(used.email, WORK);
    const before = fake.tokenCalls;
    // Expire every token handed out so far.
    for (let i = 0; i <= fake.tokenCalls; i++) fake.expiredTokens.add(`at-${WORK}-${i}`);
    const res = await call("get_thread", { account: "work", threadId: "wt1" });
    assert.equal(res.isError, false, res.text);
    assert.equal(fake.tokenCalls, before + 1);
  });
});

describe("search_threads", () => {
  test("searches every account when `account` is omitted, merged newest first with each thread's account", async () => {
    const { call, fake, personal } = await setup();
    // A reply makes the lunch thread the newest, although its first email is the oldest.
    fake.deliver(personal, crlf(["From: alice@example.com", `To: ${PERSONAL}`, "Subject: Re: Lunch?", "", "Noon?"]), { id: "p2", threadId: "pt1" });
    const res = await call("search_threads", { query: "report OR lunch" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.accounts, undefined);
    assert.deepEqual(
      res.json.threads.map((t: any) => [t.account, t.id, t.subject]),
      [
        [PERSONAL, "pt1", "Lunch?"],
        [WORK, "wt2", "Benefits"],
        [WORK, "wt1", "Q3 report"],
      ],
    );
    assert.deepEqual(Object.keys(res.json.threads[0]).slice(0, 2), ["account", "id"]);
    assert.match(res.json.threads[1].viewUrl, /authuser=me%40work\.example#all\/wt2$/);
    assert.equal(res.json.errors, undefined);
    const qs = fake.requests.filter((r) => r.path === "threads").map((r) => r.query.get("q"));
    assert.deepEqual(qs, ["(report OR lunch) -in:draft", "(report OR lunch) -in:draft"]);
  });

  test("a single account returns a flat result", async () => {
    const { call } = await setup();
    const res = await call("search_threads", { account: "personal" });
    assert.equal(res.json.account, PERSONAL);
    assert.equal(res.json.threads.length, 1);
    assert.equal(res.json.threads[0].totalMessages, 1);
    assert.equal(res.json.threads[0].sender, "Alice <alice@example.com>");
    assert.deepEqual(res.json.threads[0].toRecipients, [PERSONAL, '"Doe, Bob" <bob@example.com>']);
  });

  test("the combined page token continues only the accounts that have more", async () => {
    const { call, fake, work } = await setup();
    work.pageSize = 1;
    const first = await call("search_threads", {});
    assert.ok(first.json.nextPageToken.startsWith("multi:"));
    assert.deepEqual(first.json.accountsWithMore, [WORK]);
    assert.equal(first.json.threads.filter((t: any) => t.account === WORK).length, 1);

    fake.requests.length = 0;
    const second = await call("search_threads", { pageToken: first.json.nextPageToken });
    assert.deepEqual(second.json.threads.map((t: any) => [t.account, t.id]), [[WORK, "wt1"]]);
    assert.equal(second.json.accountsWithMore, undefined);
    assert.equal(second.json.nextPageToken, undefined);
    assert.ok(fake.requests.every((r) => r.email === WORK));
  });

  test("one failing account doesn't hide the others' results", async () => {
    const { call, fake } = await setup();
    fake.revoked.add("rt-personal");
    const res = await call("search_threads", {});
    assert.equal(res.isError, false);
    assert.equal(res.json.errors.length, 1);
    assert.equal(res.json.errors[0].account, PERSONAL);
    assert.match(res.json.errors[0].error, /Re-link/);
    assert.deepEqual(res.json.threads.map((t: any) => t.account), [WORK, WORK]);
  });
});

describe("reading", () => {
  test("get_thread PLAIN_TEXT converts HTML bodies and lists attachments", async () => {
    const { call } = await setup();
    const res = await call("get_thread", { account: "work", threadId: "wt1" });
    const [msg] = res.json.messages;
    assert.equal(msg.plaintextBody, "Please review the attached report & reply.\n\nThanks");
    assert.equal(msg.htmlBody, undefined);
    assert.equal(msg.attachments[0].filename, "report.pdf");
    assert.equal(msg.attachments[0].mimeType, "application/pdf");
    assert.ok(msg.attachments[0].id);
  });

  test("get_message FULL_CONTENT includes the HTML body; METADATA_ONLY omits subject", async () => {
    const { call } = await setup();
    const full = await call("get_message", { account: WORK, messageId: "w1", messageFormat: "FULL_CONTENT" });
    assert.match(full.json.htmlBody, /<b>attached<\/b>/);
    const meta = await call("get_message", { account: WORK, messageId: "w1", messageFormat: "METADATA_ONLY" });
    assert.equal(meta.json.subject, undefined);
    assert.equal(meta.json.sender, "Boss <boss@work.example>");
  });
});

describe("sending", () => {
  test("send_message requires an explicit account when several are linked", async () => {
    const { call, fake } = await setup({ defaultAccount: "work" });
    const res = await call("send_message", { to: ["x@example.com"], subject: "hi", body: "yo" });
    assert.equal(res.isError, true);
    assert.match(res.text, /`account` is required when sending/);
    assert.equal(fake.requests.filter((r) => r.path === "messages/send").length, 0);
  });

  test("send_message sends from the chosen account with encoded headers", async () => {
    const { call, fake } = await setup();
    const res = await call("send_message", {
      account: "work",
      to: ["x@example.com", "y@example.com"],
      bcc: ["z@example.com"],
      subject: "Café meeting ☕ — agenda",
      body: "Plain body ✓",
      htmlBody: "<p>Rich body ✓</p>",
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.account, WORK);
    const [sent] = fake.sentBy(WORK);
    assert.equal(fake.sentBy(PERSONAL).length, 0);
    const mime = inspectMime(sent.raw);
    assert.equal(mime.get("To"), "x@example.com, y@example.com");
    assert.equal(mime.get("Bcc"), "z@example.com");
    assert.equal(mime.get("Subject"), "Café meeting ☕ — agenda");
    assert.ok(!/[^\x00-\x7f]/.test(sent.raw), "raw message is 7-bit clean");
    assert.deepEqual(
      mime.parts.map((p) => [p.type, p.text]),
      [
        ["text/plain", "Plain body ✓"],
        ["text/html", "<p>Rich body ✓</p>"],
      ],
    );
  });

  test("header injection through the subject is neutralised", async () => {
    const { call, fake } = await setup();
    await call("send_message", { account: "work", to: ["x@example.com"], subject: "Hi\r\nBcc: evil@example.com", body: "b" });
    const mime = inspectMime(fake.sentBy(WORK)[0].raw);
    assert.equal(mime.get("Bcc"), undefined);
    assert.equal(mime.get("Subject"), "Hi Bcc: evil@example.com");
  });

  test("non-plain addresses are rejected", async () => {
    const { call } = await setup();
    const res = await call("send_message", { account: "work", to: ["Bob <bob@example.com>"], body: "b" });
    assert.equal(res.isError, true);
    assert.match(res.text, /Invalid email address/);
  });

  test("send_message can send an existing draft", async () => {
    const { call, fake } = await setup();
    const draft = await call("create_draft", { account: "personal", to: ["x@example.com"], subject: "d", body: "b" });
    const res = await call("send_message", { account: "personal", draftId: draft.json.id });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.labelIds, ["SENT"]);
    assert.ok(fake.requests.some((r) => r.path === "drafts/send" && r.body.id === draft.json.id));
  });

  test("reply threads under the original, addresses the sender and quotes the original", async () => {
    const { call, fake } = await setup();
    const res = await call("reply", { account: "personal", messageId: "p1", body: "Sure, noon?" });
    assert.equal(res.isError, false, res.text);
    const [sent] = fake.sentBy(PERSONAL);
    assert.equal(sent.metadata.threadId, "pt1");
    const mime = inspectMime(sent.raw);
    assert.equal(mime.get("To"), "Alice <alice@example.com>");
    assert.equal(mime.get("Cc"), undefined);
    assert.equal(mime.get("Subject"), "Re: Lunch?");
    assert.equal(mime.get("In-Reply-To"), "<lunch-1@example.com>");
    assert.equal(mime.get("References"), "<lunch-1@example.com>");
    assert.equal(
      mime.parts[0].text,
      "Sure, noon?\n\nOn Mon, 1 Sep 2026 12:00:00 +0000, Alice <alice@example.com> wrote:\n> Want to grab lunch?\n> Thursday works.",
    );
  });

  test("reply-all copies the other recipients but never yourself", async () => {
    const { call, fake } = await setup();
    await call("reply", { account: "personal", messageId: "p1", body: "All in!", replyAll: true });
    const mime = inspectMime(fake.sentBy(PERSONAL)[0].raw);
    assert.equal(mime.get("To"), "Alice <alice@example.com>");
    assert.equal(mime.get("Cc"), '"Doe, Bob" <bob@example.com>, carol@example.com');
  });

  test("forward re-attaches the original attachments", async () => {
    const { call, fake } = await setup();
    const res = await call("forward", {
      account: "work",
      messageId: "w1",
      to: ["accountant@example.com"],
      forwardText: "FYI",
    });
    assert.equal(res.isError, false, res.text);
    const [sent] = fake.sentBy(WORK);
    const mime = inspectMime(sent.raw);
    assert.equal(mime.get("Subject"), "Fwd: Q3 report");
    const plain = mime.parts.find((p) => p.type === "text/plain")!.text;
    assert.match(plain, /^FYI\n\n---------- Forwarded message ---------\nFrom: Boss <boss@work\.example>/);
    assert.match(plain, /Please review the attached report & reply\./);
    const pdf = mime.parts.find((p) => p.filename === "report.pdf")!;
    assert.equal(pdf.text, "%PDF-1.4 fake pdf bytes");
    assert.equal(pdf.type, "application/pdf");
  });
});

describe("drafts", () => {
  test("update_draft merges fields and keeps attachments unless replaced", async () => {
    const { call, fake, personal } = await setup();
    const created = await call("create_draft", {
      account: "personal",
      to: ["x@example.com"],
      subject: "Invoice",
      body: "See attached.",
      attachments: [{ content: b64("invoice-bytes"), filename: "invoice.txt", mimeType: "text/plain" }],
    });
    assert.equal(created.isError, false, created.text);
    assert.match(created.json.viewUrl, /#drafts\?compose=/);

    const updated = await call("update_draft", { account: "personal", draftId: created.json.id, subject: "Invoice #42" });
    assert.equal(updated.isError, false, updated.text);
    const got = await call("get_draft", { account: "personal", draftId: created.json.id });
    assert.equal(got.json.subject, "Invoice #42");
    assert.deepEqual(got.json.toRecipients, ["x@example.com"]);
    assert.equal(got.json.plaintextBody, "See attached.");
    assert.equal(got.json.attachments[0].filename, "invoice.txt");
    const attId = got.json.attachments[0].id;
    assert.equal(Buffer.from(personal.attachments.get(`${got.json.messageId}/${attId}`)!, "base64url").toString(), "invoice-bytes");

    await call("update_draft", { account: "personal", draftId: created.json.id, attachments: [] });
    const stripped = await call("get_draft", { account: "personal", draftId: created.json.id });
    assert.equal(stripped.json.attachments, undefined);
    assert.equal(stripped.json.subject, "Invoice #42");
    assert.ok(fake.requests.some((r) => r.method === "PUT"));
  });

  test("create_draft with replyToMessageId threads, addresses and quotes", async () => {
    const { call, fake } = await setup();
    const res = await call("create_draft", { account: "work", replyToMessageId: "w1", body: "Looks good." });
    assert.equal(res.json.threadId, "wt1");
    const draftReq = fake.requests.find((r) => r.path === "drafts" && r.method === "POST")!;
    const mime = inspectMime(draftReq.body.raw);
    assert.equal(mime.get("To"), "Boss <boss@work.example>");
    assert.equal(mime.get("Subject"), "Re: Q3 report");
    assert.match(mime.parts[0].text, /^Looks good\.\n\nOn Tue, 2 Sep 2026 09:00:00 \+0000, Boss <boss@work\.example> wrote:\n> Please review/);
  });

  test("list_drafts groups drafts by account", async () => {
    const { call } = await setup();
    await call("create_draft", { account: "work", to: ["a@example.com"], subject: "W", body: "w" });
    await call("create_draft", { account: "personal", to: ["b@example.com"], subject: "P", body: "p" });
    const res = await call("list_drafts", { view: "DRAFT_VIEW_FULL" });
    const subjects = Object.fromEntries(res.json.accounts.map((a: any) => [a.account, a.drafts.map((d: any) => d.subject)]));
    assert.deepEqual(subjects, { [PERSONAL]: ["P"], [WORK]: ["W"] });
    const meta = await call("list_drafts", { account: "work" });
    assert.equal(meta.json.drafts[0].subject, undefined);
    assert.deepEqual(meta.json.drafts[0].toRecipients, ["a@example.com"]);
  });

  test("delete_draft removes the draft", async () => {
    const { call } = await setup();
    const d = await call("create_draft", { account: "work", to: ["a@example.com"], body: "w" });
    assert.equal((await call("delete_draft", { account: "work", draftId: d.json.id })).isError, false);
    assert.equal((await call("get_draft", { account: "work", draftId: d.json.id })).isError, true);
  });
});

describe("labels, trash and spam", () => {
  test("label tools accept display names and resolve them per account", async () => {
    const { call, fake, work } = await setup();
    const res = await call("label_thread", { account: "work", threadId: "wt1", labelIds: ["reports", "STARRED"] });
    assert.equal(res.isError, false, res.text);
    const modify = fake.requests.find((r) => r.path === "threads/wt1/modify")!;
    assert.deepEqual(modify.body, { addLabelIds: ["Label_7", "STARRED"], removeLabelIds: [] });
    assert.ok(work.messages.get("w1")!.labelIds!.includes("Label_7"));

    const missing = await call("label_thread", { account: "personal", threadId: "pt1", labelIds: ["Reports"] });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Label "Reports" not found in me\.personal@gmail\.com/);
  });

  test("unlabel_message removes UNREAD (mark as read)", async () => {
    const { call, personal } = await setup();
    await call("unlabel_message", { account: "personal", messageId: "p1", labelIds: ["UNREAD"] });
    assert.deepEqual(personal.messages.get("p1")!.labelIds, ["INBOX"]);
  });

  test("update_message_labels moves a message in one call", async () => {
    const { call, work } = await setup();
    const res = await call("update_message_labels", {
      account: "work",
      messageId: "w2",
      addLabelIds: ["Reports"],
      removeLabelIds: ["INBOX"],
    });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(work.messages.get("w2")!.labelIds, ["UNREAD", "Label_7"]);
  });

  test("trash/untrash and spam/unspam", async () => {
    const { call, personal } = await setup();
    await call("trash_thread", { account: "personal", threadId: "pt1" });
    assert.ok(personal.messages.get("p1")!.labelIds!.includes("TRASH"));
    await call("untrash_thread", { account: "personal", threadId: "pt1" });
    assert.ok(!personal.messages.get("p1")!.labelIds!.includes("TRASH"));
    await call("mark_message_spam", { account: "personal", messageId: "p1" });
    assert.deepEqual(personal.messages.get("p1")!.labelIds, ["UNREAD", "SPAM"]);
    await call("unmark_message_spam", { account: "personal", messageId: "p1" });
    assert.deepEqual(personal.messages.get("p1")!.labelIds, ["UNREAD", "INBOX"]);
  });

  test("create_label builds missing parents and applies the color preset", async () => {
    const { call, work } = await setup();
    const res = await call("create_label", {
      account: "work",
      displayName: "Clients/Acme/2026",
      colorPreset: "LABEL_COLOR_PRESET_BLUE",
    });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.createdParentLabels, ["Clients", "Clients/Acme"]);
    const label = work.labels.find((l) => l.name === "Clients/Acme/2026") as any;
    assert.deepEqual(label.color, { backgroundColor: "#4a86e8", textColor: "#ffffff" });
  });

  test("list_labels without account covers every account", async () => {
    const { call } = await setup();
    const res = await call("list_labels", {});
    const work = res.json.accounts.find((a: any) => a.account === WORK);
    assert.ok(work.labels.some((l: any) => l.name === "Reports"));
    const personal = res.json.accounts.find((a: any) => a.account === PERSONAL);
    assert.ok(!personal.labels.some((l: any) => l.name === "Reports"));
  });

  test("update_label and delete_label resolve names", async () => {
    const { call, work } = await setup();
    const renamed = await call("update_label", { account: "work", labelId: "Reports", displayName: "Reports/2026" });
    assert.equal(renamed.isError, false, renamed.text);
    assert.ok(work.labels.some((l) => l.id === "Label_7" && l.name === "Reports/2026"));
    const deleted = await call("delete_label", { account: "work", labelId: "Label_7" });
    assert.deepEqual(deleted.json, { account: WORK, deleted: "Label_7" });
    assert.ok(!work.labels.some((l) => l.id === "Label_7"));
  });
});

describe("account store", () => {
  let store: AccountStore;
  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-store-"));
    tmpDirs.push(dir);
    store = new AccountStore(dir);
  });

  test("re-linking an account keeps its alias and replaces the token", async () => {
    await store.upsert({ email: "A@x.com", alias: "a", refreshToken: "1", scopes: [], addedAt: "" });
    await store.upsert({ email: "a@x.com", refreshToken: "2", scopes: [], addedAt: "" });
    const [account] = await store.list();
    assert.equal(account.alias, "a");
    assert.equal(account.refreshToken, "2");
  });

  test("aliases must be unique and cannot be 'all'", async () => {
    await store.upsert({ email: "a@x.com", alias: "home", refreshToken: "1", scopes: [], addedAt: "" });
    await store.upsert({ email: "b@x.com", refreshToken: "2", scopes: [], addedAt: "" });
    await assert.rejects(store.setAlias("b@x.com", "HOME"), /already used/);
    await assert.rejects(store.setAlias("b@x.com", "all"), /reserved/);
  });

  test("removing the default account clears the default", async () => {
    await store.upsert({ email: "a@x.com", refreshToken: "1", scopes: [], addedAt: "" });
    await store.setDefault("a@x.com");
    await store.remove("a@x.com");
    assert.equal((await store.load()).defaultAccount, undefined);
  });
});

describe("fixes from the code review", () => {
  test("reply-all skips group syntax and keeps the real recipients", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(
      personal,
      crlf([
        "From: News <news@example.com>",
        "To: undisclosed-recipients:;",
        `Cc: Team: dana@example.com, eve@example.com;, ${PERSONAL}`,
        "Subject: Weekly",
        "Message-ID: <weekly@example.com>",
        "Content-Type: text/plain",
        "",
        "Hello",
      ]),
      { id: "g1", threadId: "gt1" },
    );
    const res = await call("reply", { account: "personal", messageId: "g1", body: "Thanks", replyAll: true });
    assert.equal(res.isError, false, res.text);
    const mime = inspectMime(fake.sentBy(PERSONAL)[0].raw);
    assert.equal(mime.get("To"), "News <news@example.com>");
    assert.equal(mime.get("Cc"), "dana@example.com, eve@example.com");
  });

  test("replies understand comment-style names and angle brackets inside quoted names", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(personal, crlf(["From: root@server.example (Cron Daemon)", `To: ${PERSONAL}`, "Subject: Job", "", "done"]), {
      id: "c1",
    });
    fake.deliver(
      personal,
      crlf([`From: "Help <help@vendor.com>" <noreply@vendor.com>`, `To: ${PERSONAL}`, "Subject: Ticket", "", "hi"]),
      { id: "c2" },
    );
    assert.equal((await call("reply", { account: "personal", messageId: "c1", body: "ok" })).isError, false);
    assert.equal((await call("reply", { account: "personal", messageId: "c2", body: "ok" })).isError, false);
    const [first, second] = fake.sentBy(PERSONAL).map((s) => inspectMime(s.raw));
    assert.equal(first.get("To"), "Cron Daemon <root@server.example>");
    assert.equal(second.get("To"), '"Help <help@vendor.com>" <noreply@vendor.com>');
  });

  test("send_message with only replyThreadId adds the headers Gmail needs to thread it", async () => {
    const { call, fake } = await setup();
    const res = await call("send_message", {
      account: "personal",
      replyThreadId: "pt1",
      to: ["alice@example.com"],
      body: "Following up",
    });
    assert.equal(res.isError, false, res.text);
    const [sent] = fake.sentBy(PERSONAL);
    assert.equal(sent.metadata.threadId, "pt1");
    const mime = inspectMime(sent.raw);
    assert.equal(mime.get("In-Reply-To"), "<lunch-1@example.com>");
    assert.equal(mime.get("References"), "<lunch-1@example.com>");
    assert.equal(mime.get("Subject"), "Re: Lunch?");
  });

  test("a body split around an attachment is kept whole, and attached emails aren't the body", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(
      personal,
      crlf([
        "From: a@example.com",
        `To: ${PERSONAL}`,
        "Subject: Contract",
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        "Content-Type: text/plain",
        "",
        "Here is the contract:",
        "--M",
        'Content-Type: application/pdf; name="c.pdf"',
        'Content-Disposition: attachment; filename="c.pdf"',
        "",
        "PDF",
        "--M",
        "Content-Type: text/plain",
        "",
        "Please sign by Friday.",
        "--M",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="earlier.eml"',
        "",
        "Subject: earlier",
        "",
        "old text",
        "--M--",
      ]),
      { id: "s1" },
    );
    const res = await call("get_message", { account: "personal", messageId: "s1" });
    assert.equal(res.json.plaintextBody, "Here is the contract:\nPlease sign by Friday.");
    assert.deepEqual(res.json.attachments.map((a: any) => a.filename), ["c.pdf", "earlier.eml"]);
  });

  test("an empty plain-text alternative falls back to the HTML version", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(
      personal,
      crlf([
        "From: billing@example.com",
        `To: ${PERSONAL}`,
        "Subject: Invoice",
        'Content-Type: multipart/alternative; boundary="A"',
        "",
        "--A",
        "Content-Type: text/plain",
        "",
        "",
        "--A",
        "Content-Type: text/html",
        "",
        "<p>Your invoice is ready.</p>",
        "--A--",
      ]),
      { id: "e1" },
    );
    const res = await call("get_message", { account: "personal", messageId: "e1" });
    assert.equal(res.json.plaintextBody, "Your invoice is ready.");
  });

  test('"-in:draft" in a query still filters drafts out', async () => {
    const { call, fake } = await setup();
    await call("create_draft", { account: "personal", to: ["x@example.com"], subject: "secret draft", body: "d" });
    const res = await call("search_threads", { account: "personal", query: "from:alice -in:draft" });
    const q = fake.requests.filter((r) => r.path === "threads").at(-1)!.query.get("q");
    assert.equal(q, "(from:alice -in:draft) -in:draft");
    for (const thread of res.json.threads) {
      for (const m of thread.messages ?? [thread]) assert.ok(!m.labelIds.includes("DRAFT"));
    }
  });

  test("update_draft keeps a send-as From address and recipients' display names", async () => {
    const { call, fake, personal } = await setup();
    const msg = fake.deliver(
      personal,
      crlf([
        "From: Me Alias <alias@mydomain.com>",
        'To: "Doe, Jane" <jane@x.com>',
        "Subject: Old subject",
        "Content-Type: text/plain",
        "",
        "Body",
      ]),
      { labelIds: ["DRAFT"] },
    );
    personal.drafts.set("r-alias", msg.id);
    const res = await call("update_draft", { account: "personal", draftId: "r-alias", subject: "New subject" });
    assert.equal(res.isError, false, res.text);
    const put = fake.requests.find((r) => r.method === "PUT")!;
    assert.equal(put.body.metadata.message.threadId, msg.threadId);
    const mime = inspectMime(put.body.raw);
    assert.equal(mime.get("From"), "Me Alias <alias@mydomain.com>");
    assert.equal(mime.get("To"), '"Doe, Jane" <jane@x.com>');
    assert.equal(mime.get("Subject"), "New subject");
  });

  test("nested labels reuse the existing parent's capitalization", async () => {
    const { call, work } = await setup();
    const res = await call("create_label", { account: "work", displayName: "reports/2026" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.createdParentLabels, undefined);
    assert.ok(work.labels.some((l) => l.name === "Reports/2026"));
  });

  test("searching five accounts uses about three HTTP calls per account", async () => {
    const { call, fake, store } = await setup();
    for (let i = 3; i <= 5; i++) {
      const email = `extra${i}@example.com`;
      const mb = fake.addMailbox(email, `rt-${i}`);
      await store.upsert({ email, refreshToken: `rt-${i}`, scopes: [], addedAt: "" });
      for (let t = 0; t < 20; t++) {
        fake.deliver(mb, crlf([`From: s${t}@example.com`, `To: ${email}`, `Subject: T${t}`, "", "x"]), { threadId: `x${i}-${t}` });
      }
    }
    fake.outboundCalls = 0;
    const res = await call("search_threads", {});
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.threads.length, 3 + 3 * 20);
    assert.equal(new Set(res.json.threads.map((t: any) => t.account)).size, 5);
    assert.equal(res.json.errors, undefined);
    // Cloudflare's free plan allows 50 outgoing calls per request; one call per thread would need ~70 here.
    assert.ok(fake.outboundCalls <= 15, `made ${fake.outboundCalls} calls`);
  });

  test("a rate-limited call inside a batch is retried", async () => {
    const { call, fake } = await setup();
    fake.failOnce.set("threads/wt1", 429);
    const res = await call("search_threads", { account: "work" });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.threads.map((t: any) => t.id).sort(), ["wt1", "wt2"]);
    assert.equal(fake.failOnce.size, 0);
  });

  test("forwarding a message with many attachments downloads them in one batch", async () => {
    const { call, fake, work } = await setup();
    const parts = Array.from({ length: 8 }, (_, i) => [
      "--B",
      `Content-Type: text/plain; name="f${i}.txt"`,
      `Content-Disposition: attachment; filename="f${i}.txt"`,
      "",
      `file ${i}`,
    ]).flat();
    fake.deliver(
      work,
      crlf(["From: a@example.com", `To: ${WORK}`, "Subject: Files", 'Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain", "", "See files", ...parts, "--B--"]),
      { id: "f1" },
    );
    fake.batchCalls = 0;
    const res = await call("forward", { account: "work", messageId: "f1", to: ["x@example.com"] });
    assert.equal(res.isError, false, res.text);
    assert.equal(fake.batchCalls, 1);
    const files = inspectMime(fake.sentBy(WORK)[0].raw).parts.filter((p) => p.filename);
    assert.deepEqual(files.map((f) => f.text), Array.from({ length: 8 }, (_, i) => `file ${i}`));
  });

  test("after a 401 the token is refreshed once, and a failed send is not retried", async () => {
    const { call, fake } = await setup();
    assert.equal((await call("get_thread", { account: "work", threadId: "wt1" })).isError, false);
    for (let i = 0; i <= fake.tokenCalls; i++) fake.expiredTokens.add(`at-${WORK}-${i}`);
    fake.failOnce.set("threads/wt1", 503);
    const before = fake.tokenCalls;
    const res = await call("get_thread", { account: "work", threadId: "wt1" });
    assert.equal(res.isError, false, res.text);
    assert.equal(fake.tokenCalls, before + 1);

    fake.failOnce.set("messages/send", 503);
    const sent = await call("send_message", { account: "work", to: ["x@example.com"], body: "hi" });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /503/);
    assert.equal(fake.sentBy(WORK).length, 0, "a send that may have gone through isn't repeated");
  });

  test("403 rate-limit errors are retried", async () => {
    const { call, fake } = await setup();
    fake.failOnce.set("messages/w2", 403);
    const res = await call("get_message", { account: "work", messageId: "w2" });
    assert.equal(res.isError, false, res.text);
  });

  test("page tokens are checked against the accounts being searched", async () => {
    const { call, work } = await setup();
    work.pageSize = 1;
    const single = await call("search_threads", { account: "work" });
    assert.ok(single.json.nextPageToken && !single.json.nextPageToken.startsWith("multi:"));
    const reused = await call("search_threads", { pageToken: single.json.nextPageToken });
    assert.equal(reused.isError, true);
    assert.match(reused.text, /single-account call/);

    const combined = await call("search_threads", {});
    const wrongAccount = await call("search_threads", { account: "personal", pageToken: combined.json.nextPageToken });
    assert.equal(wrongAccount.isError, true);
    assert.match(wrongAccount.text, /doesn't continue/);

    const bogus = await call("search_threads", { pageToken: "multi:" + Buffer.from("null").toString("base64url") });
    assert.equal(bogus.isError, true);
    assert.match(bogus.text, /Invalid pageToken/);
  });

  test("a missing OAuth client isn't cached, and the error doesn't suggest re-linking", async () => {
    const { store, fake } = await setup();
    let attempts = 0;
    const tokens = new TokenProvider(async () => {
      if (attempts++ === 0) throw new AuthError("No Google OAuth client found.");
      return { clientId: "cid", clientSecret: "secret" };
    }, fake.fetch);
    const server = createServer({ store, fetchImpl: fake.fetch, tokens });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const first = (await client.callTool({ name: "get_thread", arguments: { account: "work", threadId: "wt1" } })) as any;
    assert.equal(first.isError, true);
    assert.doesNotMatch(first.content[0].text, /Re-link/);
    const second = (await client.callTool({ name: "get_thread", arguments: { account: "work", threadId: "wt1" } })) as any;
    assert.equal(second.isError, undefined, second.content[0].text);
  });

  test("aliases are trimmed when saved", async () => {
    const { store } = await setup();
    await store.setAlias(WORK, "  job ");
    assert.equal((await store.list()).find((a) => a.email === WORK)!.alias, "job");
  });
});

describe("cleaner, smaller results", () => {
  test("previews are decoded and stripped of invisible padding", async () => {
    const { call, fake, personal } = await setup();
    const msg = fake.deliver(personal, crlf(["From: shop@example.com", `To: ${PERSONAL}`, "Subject: Sale \u034f\u200c", "", "x"]), {
      id: "promo",
    });
    msg.snippet = "Friends &amp; Family: don&#39;t miss out \u034f \u200c \u034f \u200c \u2800\u2800 &quot;30%&quot; off";
    const res = await call("search_threads", { account: "personal" });
    const promo = res.json.threads.find((t: any) => t.id === "promo");
    assert.equal(promo.snippet, 'Friends & Family: don\'t miss out "30%" off');
    assert.equal(promo.subject, "Sale");
  });

  test("single-email threads are flat; recipients only when it wasn't just to you", async () => {
    const { call, fake, work } = await setup();
    const res = await call("search_threads", { account: "work" });
    const single = res.json.threads.find((t: any) => t.id === "wt2");
    assert.equal(single.messages, undefined);
    assert.equal(single.subject, "Benefits");
    assert.equal(single.sender, "hr@work.example");
    assert.equal(single.toRecipients, undefined, "addressed only to this account");
    assert.equal(single.threadId, undefined);
    assert.match(single.viewUrl, /#all\/wt2$/);

    fake.deliver(work, crlf(["From: Boss <boss@work.example>", `To: ${WORK}`, "Subject: Re: Q3 report", "", "Looks good"]), {
      threadId: "wt1",
    });
    fake.deliver(work, crlf(["From: Vendor <v@vendor.example>", `To: ${WORK}`, "Subject: RE: [EXTERNAL]Re: Q3 report", "", "Thanks"]), {
      threadId: "wt1",
    });
    const again = await call("search_threads", { account: "work" });
    const thread = again.json.threads.find((t: any) => t.id === "wt1");
    assert.equal(thread.subject, "Q3 report");
    assert.equal(thread.totalMessages, 3);
    assert.equal(thread.messages.length, 3);
    for (const m of thread.messages) {
      assert.equal(m.subject, undefined, "replies don't repeat the thread subject");
      assert.equal(m.viewUrl, undefined);
      assert.equal(m.threadId, undefined);
    }
  });

  test("very long bodies are shortened unless maxBodyChars says otherwise", async () => {
    const { call, fake, personal } = await setup();
    const long = "word ".repeat(10_000); // 50,000 characters
    fake.deliver(personal, crlf(["From: news@example.com", `To: ${PERSONAL}`, "Subject: Huge", "Content-Type: text/plain", "", long]), {
      id: "huge",
    });
    const short = await call("get_message", { account: "personal", messageId: "huge" });
    assert.ok(short.json.plaintextBody.length <= 20_000);
    // 50,000 characters, less the trailing space that cleaning trims, less the 20,000 shown.
    assert.match(short.json.truncated, /^Body shortened: 29,999 more characters not shown/);

    const custom = await call("get_message", { account: "personal", messageId: "huge", maxBodyChars: 500 });
    assert.equal(custom.json.plaintextBody.length, 500);

    const full = await call("get_message", { account: "personal", messageId: "huge", maxBodyChars: 0 });
    assert.equal(full.json.truncated, undefined);
    assert.equal(full.json.plaintextBody, long.trim());

    const thread = await call("get_thread", { account: "personal", threadId: "huge", maxBodyChars: 1000 });
    assert.equal(thread.json.messages[0].plaintextBody.length, 1000);
  });

  test("forwarding and replying still use the whole email, not the shortened one", async () => {
    const { call, fake, personal } = await setup();
    const long = "line of text\n".repeat(3000); // ~39,000 characters
    fake.deliver(
      personal,
      crlf(["From: a@example.com", `To: ${PERSONAL}`, "Subject: Long", "Message-ID: <long@example.com>", "Content-Type: text/plain", "", long]),
      { id: "long" },
    );
    await call("forward", { account: "personal", messageId: "long", to: ["x@example.com"] });
    const plain = inspectMime(fake.sentBy(PERSONAL)[0].raw).parts.find((p) => p.type === "text/plain")!.text;
    assert.ok(plain.length > 39_000, `forwarded ${plain.length} characters`);
  });

  test("invisible padding is removed from bodies too", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(
      personal,
      crlf([
        "From: shop@example.com",
        `To: ${PERSONAL}`,
        "Subject: Deals",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Big sale \u034f \u200c \u034f \u200c \u034f \u200c today\n\n\n\n\nShop now",
      ]),
      { id: "pad" },
    );
    const res = await call("get_message", { account: "personal", messageId: "pad" });
    assert.equal(res.json.plaintextBody, "Big sale today\n\nShop now");
  });

  test("blank padding made of other spaces and CRLF line ends is collapsed; tabs are kept", async () => {
    const { call, fake, personal } = await setup();
    const figureSpaces = "\u2007".repeat(200);
    fake.deliver(
      personal,
      crlf(["From: shop@example.com", `To: ${PERSONAL}`, "Subject: Deals", "Content-Type: text/plain; charset=UTF-8", "", "Ends tonight.", "", figureSpaces, "", "", "", "Item\t\tPrice"]),
      { id: "spaces" },
    );
    const res = await call("get_message", { account: "personal", messageId: "spaces" });
    assert.equal(res.json.plaintextBody, "Ends tonight.\n\nItem\t\tPrice");
  });

  test("get_thread hides quoted history that repeats earlier messages; get_message keeps it", async () => {
    const { call, fake, personal } = await setup();
    const mail = (id: string, from: string, subject: string, body: string[]) =>
      fake.deliver(personal, crlf([`From: ${from}`, `To: ${PERSONAL}`, `Subject: ${subject}`, "Content-Type: text/plain", "", ...body]), {
        id,
        threadId: "conv",
      });
    mail("q0", "Ann <ann@example.com>", "Interview", ["Can you do Friday?", "", "On Mon, Sep 28, 2026 at 9:00 AM Recruiter <r@example.com> wrote:", "> Earlier note"]);
    mail("q1", "Me <me@example.com>", "Re: Interview", ["Friday works.", "", "On Tue, Sep 29, 2026 at 6:33 AM Ann Smith <", "ann@example.com> wrote:", "", "> Can you do Friday?", ">"]);
    mail("q2", "Ann <ann@example.com>", "RE: Interview", ["Great, see you then.", "", "-----Original Message-----", "From: Me <me@example.com>", "Friday works."]);
    mail("q3", "Me <me@example.com>", "Re: Interview", ["On Wed, Sep 30, 2026, Ann <ann@example.com> wrote:", "> Where?", "Downtown office.", "> When?", "10am."]);
    mail("q4", "Ann <ann@example.com>", "Re: Interview", ["Thanks!", "", "On Monday the team wrote:", "We are hiring two people."]);

    const thread = await call("get_thread", { account: "personal", threadId: "conv" });
    const bodies = thread.json.messages.map((m: any) => m.plaintextBody);
    assert.match(bodies[0], /> Earlier note$/, "the first message keeps its quote");
    assert.equal(bodies[1], "Friday works.\n\n[Quoted earlier messages hidden: they're above in this thread. get_message shows this email in full.]");
    assert.match(bodies[2], /^Great, see you then\.\n\n\[Quoted earlier messages hidden/);
    assert.match(bodies[3], /Downtown office\.\n> When\?\n10am\.$/, "answers written between quoted lines are kept");
    assert.equal(bodies[4], "Thanks!\n\nOn Monday the team wrote:\nWe are hiring two people.", "prose isn't mistaken for a quote");

    const one = await call("get_message", { account: "personal", messageId: "q1" });
    assert.match(one.json.plaintextBody, /wrote:\n\n> Can you do Friday\?\n>$/);
  });

  test("long tracking links are cut to their site when reading, but kept in drafts and FULL_CONTENT", async () => {
    const { call, fake, personal } = await setup();
    const tracking = `https://click.mail.shop.example/c2/abc?jwt=${"x".repeat(1500)}`;
    const meeting = "https://meet.example.com/j/123456789?pwd=abcdef";
    fake.deliver(
      personal,
      crlf([
        "From: shop@example.com",
        `To: ${PERSONAL}`,
        "Subject: Sale",
        "Content-Type: text/html",
        "",
        `<p>Sale ends tonight</p><p><a href="${tracking}">SHOP JEANS</a></p><p>Join: <a href="${meeting}">${meeting}</a></p>`,
      ]),
      { id: "sale" },
    );
    for (const res of [
      await call("get_message", { account: "personal", messageId: "sale" }),
      { json: (await call("get_thread", { account: "personal", threadId: "sale" })).json.messages[0] },
    ]) {
      assert.equal(res.json.plaintextBody, `Sale ends tonight\n\nSHOP JEANS (https://click.mail.shop.example/…)\n\nJoin: ${meeting}`);
      assert.match(res.json.linksShortened, /^1 long link was cut to its website.*FULL_CONTENT/);
    }
    const full = await call("get_message", { account: "personal", messageId: "sale", messageFormat: "FULL_CONTENT" });
    assert.ok(full.json.plaintextBody.includes(tracking));
    assert.equal(full.json.linksShortened, undefined);

    const draft = await call("create_draft", { account: "personal", to: ["a@example.com"], subject: "Link", body: `See ${tracking}` });
    const got = await call("get_draft", { account: "personal", draftId: draft.json.id });
    assert.equal(got.json.plaintextBody, `See ${tracking}`, "drafts keep their links, so editing one can't break them");
    const listed = await call("list_drafts", { account: "personal", view: "DRAFT_VIEW_FULL" });
    assert.ok(listed.json.drafts.some((d: any) => d.plaintextBody?.includes(tracking)));
  });
});

/** An email with the given attachments (each base64-encoded, like real mail). */
function withAttachments(from: string, to: string, subject: string, files: { name: string; type: string; data: Buffer }[]) {
  return crlf([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: multipart/mixed; boundary="ATT"',
    "",
    "--ATT",
    "Content-Type: text/plain",
    "",
    "See attached.",
    ...files.flatMap((f) => [
      "--ATT",
      `Content-Type: ${f.type}; name="${f.name}"`,
      `Content-Disposition: attachment; filename="${f.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      f.data.toString("base64"),
    ]),
    "--ATT--",
  ]);
}

describe("reading attachments", () => {
  const files = [
    { name: "statement.pdf", type: "application/pdf", data: pdf(["BT 72 720 Td (Net pay: $1,234.56 for Sebastian) Tj ET"]) },
    { name: "photo.png", type: "image/png", data: png },
    { name: "letter.docx", type: "application/octet-stream", data: docx(["Welcome aboard!", "Start date: Monday"]) },
    { name: "budget.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: xlsx([["Item", "Cost"], ["Rent", 1200]]) },
    { name: "notes.csv", type: "text/csv", data: Buffer.from("a,b\n1,2") },
    { name: "archive.zip", type: "application/zip", data: Buffer.from("PK\x03\x04junk") },
    { name: "scan.pdf", type: "application/pdf", data: pdf(["BT /F1 12 Tf 72 720 Td <000300040005000600070008000900> Tj ET"]) },
  ];

  async function setupWithFiles() {
    const ctx = await setup();
    ctx.fake.deliver(ctx.personal, withAttachments("hr@example.com", PERSONAL, "Documents", files), { id: "docs" });
    const raw = async (args: Record<string, unknown>) =>
      (await ctx.client.callTool({ name: "get_attachment", arguments: { account: "personal", messageId: "docs", ...args } })) as any;
    return { ...ctx, raw };
  }

  test("get_message lists attachments with a stable partId", async () => {
    const { call } = await setupWithFiles();
    const res = await call("get_message", { account: "personal", messageId: "docs" });
    assert.deepEqual(
      res.json.attachments.map((a: any) => [a.filename, typeof a.partId]),
      files.map((f) => [f.name, "string"]),
    );
  });

  test("a PDF comes back as extracted text only", async () => {
    const { raw } = await setupWithFiles();
    const res = await raw({ filename: "statement.pdf" });
    assert.equal(res.isError, undefined, res.content[0].text);
    const meta = JSON.parse(res.content[0].text);
    assert.equal(meta.mimeType, "application/pdf");
    assert.match(meta.extracted, /extracted/);
    assert.equal(res.content[1].text, "Net pay: $1,234.56 for Sebastian");
    assert.equal(res.content.length, 2);
  });

  test("a PDF without readable text comes back as the file itself", async () => {
    const { raw } = await setupWithFiles();
    const res = await raw({ filename: "scan.pdf" });
    assert.match(JSON.parse(res.content[0].text).note, /No readable text.*The PDF file is attached/);
    assert.equal(res.content[1].type, "resource");
    assert.equal(res.content[1].resource.mimeType, "application/pdf");
    assert.ok(Buffer.from(res.content[1].resource.blob, "base64").subarray(0, 4).equals(Buffer.from("%PDF")));
  });

  test("an image comes back as an image", async () => {
    const { raw } = await setupWithFiles();
    const res = await raw({ filename: "photo.png" });
    assert.equal(res.content[1].type, "image");
    assert.equal(res.content[1].mimeType, "image/png");
    assert.ok(Buffer.from(res.content[1].data, "base64").equals(png));
  });

  test("Word and Excel files come back as text, even when Gmail labels them octet-stream", async () => {
    const { raw, call } = await setupWithFiles();
    const word = await raw({ filename: "LETTER.DOCX" });
    assert.equal(JSON.parse(word.content[0].text).mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(word.content[1].text, "Welcome aboard!\nStart date: Monday");
    const parts = (await call("get_message", { account: "personal", messageId: "docs" })).json.attachments;
    const sheet = await raw({ partId: parts.find((a: any) => a.filename === "budget.xlsx").partId });
    assert.match(sheet.content[1].text, /Item\tCost\nRent\t1200/);
    const csv = await raw({ filename: "notes.csv", maxChars: 3 });
    assert.equal(csv.content[1].text, "a,b");
    assert.match(JSON.parse(csv.content[0].text).truncated, /more characters not shown/);
  });

  test("unsupported files and unknown names are explained", async () => {
    const { raw } = await setupWithFiles();
    const zipFile = await raw({ filename: "archive.zip" });
    assert.match(JSON.parse(zipFile.content[0].text).note, /can't be read as text/);
    const missing = await raw({ filename: "nope.pdf" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Its attachments: statement\.pdf \(partId \d+\), photo\.png/);
  });
});

describe("bulk changes", () => {
  async function setupInbox() {
    const ctx = await setup();
    // Two promotions in each account, plus the regular mail from setup().
    for (const [mb, email] of [
      [ctx.personal, PERSONAL],
      [ctx.work, WORK],
    ] as const) {
      for (let i = 1; i <= 2; i++) {
        fake(ctx).deliver(mb, crlf([`From: deals${i}@shop.example`, `To: ${email}`, `Subject: Sale ${i}`, "", "50% off"]), {
          id: `${email.split("@")[0].replace(/\./g, "")}-promo${i}`, // Gmail IDs have no dots
          labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        });
      }
    }
    return ctx;
  }
  const fake = (ctx: { fake: FakeGmail }) => ctx.fake;
  const labelsOf = (mb: FakeMailbox, id: string) => mb.messages.get(id)!.labelIds!;

  test("a dry run counts and previews matches in every account without changing anything", async () => {
    const { call, fake: f, personal } = await setupInbox();
    const res = await call("bulk_update", { query: "category:promotions", action: "archive", dryRun: true });
    assert.equal(res.isError, false, res.text);
    const byAccount = Object.fromEntries(res.json.accounts.map((a: any) => [a.account, a]));
    assert.equal(byAccount[PERSONAL].wouldChange, 2);
    assert.equal(byAccount[WORK].wouldChange, 2);
    assert.deepEqual(byAccount[PERSONAL].preview.map((p: any) => p.subject).sort(), ["Sale 1", "Sale 2"]);
    assert.equal(f.batchModifyCalls.length, 0);
    assert.ok(labelsOf(personal, "mepersonal-promo1").includes("INBOX"));
  });

  test("archive and mark read apply to just the matching emails, in one call per account", async () => {
    const { call, fake: f, personal, work } = await setupInbox();
    const res = await call("bulk_update", { query: "category:promotions", action: "archive" });
    assert.deepEqual(res.json.accounts.map((a: any) => a.changed), [2, 2]);
    assert.equal(f.batchModifyCalls.length, 2);
    assert.ok(!labelsOf(personal, "mepersonal-promo1").includes("INBOX"));
    assert.ok(!labelsOf(work, "me-promo2").includes("INBOX"));
    assert.ok(labelsOf(personal, "p1").includes("INBOX"), "non-promotions stay in the inbox");

    await call("bulk_update", { account: "work", threadIds: ["wt1"], action: "mark_read" });
    assert.ok(!labelsOf(work, "w1").includes("UNREAD"));
    assert.ok(labelsOf(work, "w2").includes("UNREAD"));
  });

  test("labels are looked up by name in each account; a missing one is reported per account", async () => {
    const { call, work } = await setupInbox();
    const res = await call("bulk_update", { query: "category:promotions", action: "add_labels", labelIds: ["reports"] });
    const byAccount = Object.fromEntries(res.json.accounts.map((a: any) => [a.account, a]));
    assert.equal(byAccount[WORK].changed, 2);
    assert.ok(labelsOf(work, "me-promo1").includes("Label_7"));
    assert.match(byAccount[PERSONAL].error, /Label "reports" not found in me\.personal@gmail\.com/);
  });

  test("bulk_trash moves matches to Trash; drafts are never touched", async () => {
    const { call, personal } = await setupInbox();
    await call("create_draft", { account: "personal", to: ["x@example.com"], subject: "Sale draft", body: "d" });
    const res = await call("bulk_trash", { account: "personal", query: "", action: "trash" });
    assert.equal(res.isError, false, res.text);
    for (const [id, msg] of personal.messages) {
      if (msg.labelIds!.includes("DRAFT")) assert.ok(!msg.labelIds!.includes("TRASH"), `draft ${id} untouched`);
      else assert.ok(msg.labelIds!.includes("TRASH"), `${id} trashed`);
    }
  });

  test("maxEmails caps the change and says more are left", async () => {
    const { call } = await setupInbox();
    const res = await call("bulk_update", { account: "work", query: "category:promotions", action: "mark_read", maxEmails: 1 });
    assert.equal(res.json.changed, 1);
    assert.match(res.json.more, /More emails match than the limit of 1/);
  });

  test("exactly one way of choosing emails is required, and IDs need their account", async () => {
    const { call } = await setupInbox();
    const none = await call("bulk_update", { action: "archive" });
    assert.match(none.text, /exactly one of `query`, `threadIds` or `messageIds`/);
    const noLabels = await call("bulk_update", { query: "x", action: "add_labels" });
    assert.match(noLabels.text, /needs `labelIds`/);
    const idsWithoutAccount = await call("bulk_update", { messageIds: ["p1"], action: "star" });
    assert.match(idsWithoutAccount.text, /pass `account`/);
  });

  test("a bulk change across five accounts stays well under Cloudflare's 50-call limit", async () => {
    const ctx = await setupInbox();
    for (let i = 3; i <= 5; i++) {
      const email = `extra${i}@example.com`;
      const mb = ctx.fake.addMailbox(email, `rt-${i}`);
      await ctx.store.upsert({ email, refreshToken: `rt-${i}`, scopes: [], addedAt: "" });
      for (let t = 0; t < 30; t++) {
        ctx.fake.deliver(mb, crlf([`From: s${t}@shop.example`, `To: ${email}`, `Subject: Deal ${t}`, "", "x"]), {
          labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
        });
      }
    }
    ctx.fake.outboundCalls = 0;
    const res = await ctx.call("bulk_update", { query: "category:promotions", action: "archive" });
    assert.equal(res.json.accounts.length, 5);
    assert.ok(res.json.accounts.every((a: any) => a.changed > 0), res.text);
    assert.ok(ctx.fake.outboundCalls <= 20, `made ${ctx.fake.outboundCalls} calls`);
  });
});

describe("fixes from the second review", () => {
  test("IDs that aren't plain Gmail IDs are rejected before any request", async () => {
    const { call, fake, work } = await setup();
    const before = fake.requests.length;
    const res = await call("delete_draft", { account: "work", draftId: "../labels/Label_7" });
    assert.equal(res.isError, true);
    assert.match(res.text, /Invalid draft ID "\.\.\/labels\/Label_7"/);
    assert.ok(work.labels.some((l) => l.id === "Label_7"), "the label is untouched");
    for (const [tool, args] of [
      ["get_thread", { threadId: "wt1/../../labels" }],
      ["get_message", { messageId: "w1?format=raw" }],
      ["trash_message", { messageId: ".." }],
      ["bulk_update", { messageIds: ["w1", "../threads/wt1"], action: "archive" }],
    ] as const) {
      const r = await call(tool, { account: "work", ...args });
      assert.equal(r.isError, true, `${tool} ${r.text}`);
      assert.match(r.text, /Invalid (thread|message) ID/);
    }
    assert.equal(fake.requests.length, before, "nothing reached Gmail");
    // Real IDs look like these and still work.
    const draft = await call("create_draft", { account: "work", to: ["a@example.com"], body: "x" });
    assert.match(draft.json.id, /^r-/);
    assert.equal((await call("get_draft", { account: "work", draftId: ` ${draft.json.id} ` })).isError, false);
  });

  test("threads and drafts Gmail keeps refusing are skipped and listed, not the whole account", async () => {
    const { call, fake, work } = await setup();
    fake.failAlways.set("threads/wt1", 429);
    const res = await call("search_threads", { account: "work" });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.threads.map((t: any) => t.id), ["wt2"]);
    assert.deepEqual(res.json.unavailable.threadIds, ["wt1"]);
    assert.match(res.json.unavailable.error, /429/);

    // Bulk changes by thread skip it too, and say so.
    const bulk = await call("bulk_update", { account: "work", threadIds: ["wt1", "wt2"], action: "mark_read" });
    assert.equal(bulk.isError, false, bulk.text);
    assert.equal(bulk.json.changed, 1);
    assert.deepEqual(bulk.json.unavailable.threadIds, ["wt1"]);
    assert.ok(work.messages.get("w1")!.labelIds!.includes("UNREAD"));

    // When nothing at all comes back, it's still an error.
    fake.failAlways.set("threads/wt2", 429);
    const none = await call("search_threads", { account: "work" });
    assert.equal(none.isError, true);
    fake.failAlways.clear();

    const d1 = await call("create_draft", { account: "work", to: ["a@example.com"], subject: "One", body: "1" });
    await call("create_draft", { account: "work", to: ["b@example.com"], subject: "Two", body: "2" });
    fake.failAlways.set(`drafts/${d1.json.id}`, 503);
    const drafts = await call("list_drafts", { account: "work", view: "DRAFT_VIEW_FULL" });
    assert.equal(drafts.isError, false, drafts.text);
    assert.deepEqual(drafts.json.drafts.map((d: any) => d.subject), ["Two"]);
    assert.deepEqual(drafts.json.unavailable.draftIds, [d1.json.id]);
  });

  test("an account whose page fails is retried on the next page instead of being dropped", async () => {
    const { call, fake, personal, work } = await setup();
    for (const mb of [personal, work]) {
      mb.pageSize = 1;
      for (let t = 0; t < 2; t++) fake.deliver(mb, crlf(["From: s@x.example", `To: ${mb.email}`, `Subject: T${t}`, "", "x"]), { threadId: `${mb === work ? "w" : "p"}x${t}` });
    }
    const page1 = await call("search_threads", {});
    const workPage1 = page1.json.threads.find((t: any) => t.account === WORK).id;
    fake.failAlways.set("threads", 500);
    const failed = await call("search_threads", { pageToken: page1.json.nextPageToken });
    assert.deepEqual(failed.json.errors.map((e: any) => e.account), [PERSONAL, WORK], failed.text);
    assert.deepEqual(failed.json.accountsWithMore, [PERSONAL, WORK]);
    assert.ok(failed.json.nextPageToken, "the token still continues both accounts");
    fake.failAlways.clear();
    const page2 = await call("search_threads", { pageToken: failed.json.nextPageToken });
    assert.deepEqual(page2.json.threads.map((t: any) => t.account).sort(), [PERSONAL, WORK].sort());
    const workPage2 = page2.json.threads.find((t: any) => t.account === WORK).id;
    assert.notEqual(workPage2, workPage1, "it continues where page 1 stopped");
  });

  test("excluding Spam or Trash in a bulk query doesn't pull in the other", async () => {
    const { call, fake, personal } = await setup();
    fake.deliver(personal, crlf(["From: x@shop.example", `To: ${PERSONAL}`, "Subject: Old sale", "", "x"]), {
      id: "trashed1",
      labelIds: ["TRASH", "CATEGORY_PROMOTIONS"],
    });
    fake.deliver(personal, crlf(["From: y@shop.example", `To: ${PERSONAL}`, "Subject: Sale", "", "x"]), {
      id: "promo1",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    const dry = await call("bulk_update", { account: "personal", query: "category:promotions -in:spam", action: "move_to_inbox", dryRun: true });
    assert.equal(dry.json.wouldChange, 1, dry.text);
    await call("bulk_update", { account: "personal", query: "category:promotions -in:spam", action: "move_to_inbox" });
    assert.ok(personal.messages.get("trashed1")!.labelIds!.includes("TRASH"), "the trashed email stays in Trash");
    assert.ok(personal.messages.get("promo1")!.labelIds!.includes("INBOX"));
    // Asking for Trash still works.
    await call("bulk_update", { account: "personal", query: "category:promotions in:trash", action: "move_to_inbox" });
    assert.ok(!personal.messages.get("trashed1")!.labelIds!.includes("TRASH"));
    const lists = fake.requests.filter((r) => r.path === "messages");
    assert.deepEqual(lists.map((r) => r.query.get("includeSpamTrash")), [null, null, "true"]);
  });

  describe("bulk changes only pick emails that still need the change", () => {
    const unread = (mb: FakeMailbox) => [...mb.messages.values()].filter((m) => m.labelIds!.includes("UNREAD")).map((m) => m.id);
    function promos(ctx: Ctx, n: number, labelIds = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]) {
      for (let i = 0; i < n; i++) {
        ctx.fake.deliver(ctx.work, crlf([`From: deals${i}@shop.example`, `To: ${WORK}`, `Subject: Sale ${i}`, "", "x"]), {
          id: `promo${i}`,
          labelIds: [...labelIds],
        });
      }
    }

    test("running a capped change again continues with the rest, and counts are real", async () => {
      const ctx = await setup();
      promos(ctx, 3);
      ctx.work.messages.get("promo0")!.labelIds = ["CATEGORY_PROMOTIONS"]; // already read and archived
      const dry = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "mark_read", dryRun: true });
      assert.equal(dry.json.wouldChange, 2, "the email that's already read isn't counted");
      const first = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "mark_read", maxEmails: 1 });
      assert.equal(first.json.changed, 1);
      assert.match(first.json.more, /Run the same change again to continue/);
      const second = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "mark_read", maxEmails: 1 });
      assert.equal(second.json.changed, 1);
      assert.equal(second.json.more, undefined);
      assert.deepEqual(unread(ctx.work).filter((id) => id.startsWith("promo")), []);
      assert.deepEqual(ctx.fake.batchModifyCalls.map((c) => c.ids.length), [1, 1], "each email changed once");
      const third = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "mark_read" });
      assert.equal(third.json.changed, 0);
      const archive = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "archive", dryRun: true });
      assert.equal(archive.json.wouldChange, 2, "only emails still in the inbox");
      const queries = ctx.fake.requests.filter((r) => r.path === "messages").map((r) => r.query.get("q"));
      assert.deepEqual(queries.slice(0, 2), ["(category:promotions) is:unread -in:draft", "(category:promotions) is:unread -in:draft"]);
      assert.equal(queries.at(-1), "(category:promotions) in:inbox -in:draft");
    });

    test("user labels are searched by their quoted name, or matched by ID when removing one", async () => {
      const ctx = await setup();
      promos(ctx, 2);
      ctx.work.labels.push({ id: "Label_9", name: "My Label", type: "user" });
      const added = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "add_labels", labelIds: ["my label"] });
      assert.equal(added.json.changed, 2, added.text);
      const again = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "add_labels", labelIds: ["My Label", "Reports"] });
      assert.equal(again.json.changed, 2, "they still lack Reports");
      const removed = await ctx.call("bulk_update", { account: "work", query: "", action: "remove_labels", labelIds: ["My Label"] });
      assert.equal(removed.json.changed, 2);
      // Two user labels to remove can't be matched by ID, and a name search could miss: the search isn't narrowed.
      const removedBoth = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "remove_labels", labelIds: ["Label_9", "Reports"] });
      assert.equal(removedBoth.json.changed, 2);
      const capped = await ctx.call("bulk_update", { account: "work", query: "", action: "remove_labels", labelIds: ["Label_9", "Reports"], dryRun: true, maxEmails: 1 });
      assert.match(capped.json.more, /Running it again would pick the same emails, so raise maxEmails or narrow the query/);
      const lists = ctx.fake.requests.filter((r) => r.path === "messages");
      assert.deepEqual(
        lists.map((r) => [r.query.get("q"), r.query.getAll("labelIds").join(",")]),
        [
          ['(category:promotions) -label:"My Label" -in:draft', ""],
          ['(category:promotions) (-label:"My Label" OR -label:"Reports") -in:draft', ""],
          ["-in:draft", "Label_9"],
          ["(category:promotions) -in:draft", ""],
          ["-in:draft", ""],
        ],
      );
      assert.ok(ctx.work.messages.get("promo0")!.labelIds!.every((l) => l !== "Label_9" && l !== "Label_7"));
    });

    test("by ID, emails over the limit are returned to pass next time; duplicates count once", async () => {
      const ctx = await setup();
      promos(ctx, 3);
      const ids = ["promo0", "promo1", "promo0", "promo2"];
      const first = await ctx.call("bulk_trash", { account: "work", messageIds: ids, action: "trash", maxEmails: 2 });
      assert.equal(first.json.changed, 2);
      assert.deepEqual(first.json.remainingMessageIds, ["promo2"]);
      assert.match(first.json.more, /messageIds set to remainingMessageIds/);
      const second = await ctx.call("bulk_trash", { account: "work", messageIds: first.json.remainingMessageIds, action: "trash", maxEmails: 2 });
      assert.equal(second.json.changed, 1);
      assert.equal(second.json.more, undefined);
      assert.ok(["promo0", "promo1", "promo2"].every((id) => ctx.work.messages.get(id)!.labelIds!.includes("TRASH")));

      // Threads: only emails that still need the change, each thread once, the rest handed back.
      for (const [id, labels] of [["t-a", ["INBOX", "UNREAD"]], ["t-b", ["INBOX"]], ["t-c", ["INBOX", "UNREAD"]]] as const) {
        ctx.fake.deliver(ctx.work, crlf(["From: a@example.com", `To: ${WORK}`, "Subject: T", "", "x"]), { id, threadId: "T1", labelIds: [...labels] });
      }
      ctx.fake.deliver(ctx.work, crlf(["From: a@example.com", `To: ${WORK}`, "Subject: U", "", "x"]), { id: "u-a", threadId: "T2" });
      const t1 = await ctx.call("bulk_update", { account: "work", threadIds: ["T1", "T1", "T2"], action: "mark_read", maxEmails: 2 });
      assert.equal(t1.json.changed, 2);
      assert.deepEqual(t1.json.remainingThreadIds, ["T2"]);
      const t2 = await ctx.call("bulk_update", { account: "work", threadIds: t1.json.remainingThreadIds, action: "mark_read", maxEmails: 2 });
      assert.equal(t2.json.changed, 1);
      assert.equal(t2.json.remainingThreadIds, undefined);
      assert.deepEqual(ctx.fake.batchModifyCalls.slice(-2).map((c) => c.ids), [["t-a", "t-c"], ["u-a"]]);
    });

    test("a change that fails partway reports what was changed, as a normal result", async () => {
      const ctx = await setup();
      promos(ctx, 1500);
      let calls = 0;
      ctx.fake.intercept = (method, path) => (path === "messages/batchModify" && ++calls > 1 ? 500 : undefined);
      const res = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "archive", maxEmails: 2000 });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.json.changed, 1000);
      assert.equal(res.json.notChanged, 500);
      assert.match(res.json.error, /Stopped after changing 1000 of 1500 emails: .*\(500\).* Run the same change again to finish\./);
      const archived = [...ctx.work.messages.values()].filter((m) => m.id.startsWith("promo") && !m.labelIds!.includes("INBOX"));
      assert.equal(archived.length, 1000);
      ctx.fake.intercept = undefined;
      const rest = await ctx.call("bulk_update", { account: "work", query: "category:promotions", action: "archive", maxEmails: 2000 });
      assert.equal(rest.json.changed, 500);

      // By thread, the threads not finished are handed back, and running them again does the rest.
      for (let i = 0; i < 1200; i++) {
        ctx.fake.deliver(ctx.work, crlf(["From: list@example.com", `To: ${WORK}`, "Subject: Digest", "", "x"]), { id: `big${i}`, threadId: "BIG" });
      }
      calls = 0;
      ctx.fake.intercept = (method, path) => (path === "messages/batchModify" && ++calls > 1 ? 500 : undefined);
      const byThread = await ctx.call("bulk_update", { account: "work", threadIds: ["BIG"], action: "mark_read", maxEmails: 2000 });
      assert.equal(byThread.isError, false, byThread.text);
      assert.equal(byThread.json.changed, 1000);
      assert.deepEqual(byThread.json.remainingThreadIds, ["BIG"]);
      assert.match(byThread.json.error, /threadIds set to remainingThreadIds to finish/);
      ctx.fake.intercept = undefined;
      const finish = await ctx.call("bulk_update", { account: "work", threadIds: byThread.json.remainingThreadIds, action: "mark_read", maxEmails: 2000 });
      assert.equal(finish.json.changed, 200);

      // If the very first call fails, nothing changed and it's a plain error.
      ctx.fake.intercept = (method, path) => (path === "messages/batchModify" ? 500 : undefined);
      const failed = await ctx.call("bulk_update", { account: "work", messageIds: ["promo0"], action: "star" });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /batchModify failed \(500\)/);
    });

    test("2,000 emails in each of five accounts fit Cloudflare's 50-call limit with room for retries", async () => {
      const ctx = await setup();
      for (let i = 3; i <= 5; i++) {
        const email = `extra${i}@example.com`;
        ctx.fake.addMailbox(email, `rt-${i}`);
        await ctx.store.upsert({ email, refreshToken: `rt-${i}`, scopes: [], addedAt: "" });
      }
      for (const mb of ctx.fake.mailboxes) {
        for (let t = 0; t < 2100; t++) {
          ctx.fake.deliver(mb, crlf([`From: s${t}@shop.example`, `To: ${mb.email}`, "Subject: Deal", "", "x"]), {
            id: `${mb.refreshToken.replace(/\W/g, "")}m${t}`,
            labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
          });
        }
      }
      ctx.fake.outboundCalls = 0;
      const dry = await ctx.call("bulk_update", { query: "category:promotions", action: "archive", maxEmails: 2000, dryRun: true });
      assert.deepEqual(dry.json.accounts.map((a: any) => a.wouldChange), [2000, 2000, 2000, 2000, 2000], dry.text);
      assert.ok(dry.json.accounts.every((a: any) => /Run the same change again/.test(a.more)));
      // Per account: token refresh, 4 searches of 500, 1 preview batch. No label list, no extra search.
      assert.equal(ctx.fake.outboundCalls, 5 * 6, `dry run made ${ctx.fake.outboundCalls} calls`);
      ctx.fake.outboundCalls = 0;
      const real = await ctx.call("bulk_update", { query: "category:promotions", action: "archive", maxEmails: 2000 });
      assert.deepEqual(real.json.accounts.map((a: any) => a.changed), [2000, 2000, 2000, 2000, 2000]);
      // Per account: 4 searches of 500 and 2 batchModify calls of 1,000 (tokens are cached now).
      assert.equal(ctx.fake.outboundCalls, 5 * 6, `made ${ctx.fake.outboundCalls} calls`);
      assert.ok(ctx.fake.requests.every((r) => r.path !== "labels"));
      assert.ok(ctx.fake.requests.filter((r) => r.path === "messages").every((r) => r.query.get("maxResults") === "500"));
    });
  });

  test("an attachment asked for by an older attachmentId keeps its name and type", async () => {
    const { call, client, fake, work } = await setup();
    const csv = (name: string, body: string) => [
      "--B",
      `Content-Type: text/csv; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      body,
    ];
    fake.deliver(
      work,
      crlf([
        "From: a@example.com", `To: ${WORK}`, "Subject: Data", 'Content-Type: multipart/mixed; boundary="B"', "",
        "--B", "Content-Type: text/plain", "", "See attached",
        ...csv("short.csv", "a,b"), ...csv("longer.csv", "a,b\r\n1,2"),
        "--B--",
      ]),
      { id: "csv1" },
    );
    // Gmail hands out a new attachmentId on every read; the one Claude saw earlier still downloads.
    const [, data] = [...work.attachments.entries()].find(([, d]) => Buffer.from(d, "base64url").toString() === "a,b\r\n1,2")!;
    work.attachments.set("csv1/OLDID", data);
    const res = await call("get_attachment", { account: "work", messageId: "csv1", attachmentId: "OLDID" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.filename, "longer.csv");
    assert.equal(res.json.mimeType, "text/csv");
    const full = (await client.callTool({ name: "get_attachment", arguments: { account: "work", messageId: "csv1", attachmentId: "OLDID" } })) as {
      content: { text: string }[];
    };
    assert.equal(full.content[1].text, "a,b\n1,2", "read as text, not refused as an unknown file type");
  });

  test("a send that fails with a server or network error says it may have gone out", async () => {
    const { call, fake } = await setup();
    fake.failOnce.set("messages/send", 503);
    const sent = await call("send_message", { account: "work", to: ["x@example.com"], body: "hi" });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /\(503\).*may have been sent anyway: check the Sent folder/);

    fake.intercept = (method, path) => {
      if (path === "messages/send") throw new TypeError("fetch failed");
      return undefined;
    };
    const reply = await call("reply", { account: "personal", messageId: "p1", body: "Sure" });
    assert.match(reply.text, /^fetch failed\. The email may have been sent anyway/);
    fake.intercept = undefined;

    const draft = await call("create_draft", { account: "work", to: ["a@example.com"], body: "d" });
    fake.failOnce.set("drafts/send", 500);
    const fromDraft = await call("send_message", { account: "work", draftId: draft.json.id });
    assert.match(fromDraft.text, /may have been sent anyway/);

    // Errors Gmail returns before sending anything don't suggest that.
    fake.failAlways.set("messages/send", 400);
    const refused = await call("forward", { account: "work", messageId: "w1", to: ["x@example.com"] });
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.text, /may have been sent/);
  });

  test("forwarding or keeping attachments over 25 MB is refused before downloading them", async () => {
    const { call, fake, work } = await setup();
    const big = (id: string, labelIds: string[]) => {
      work.messages.set(id, {
        id,
        threadId: id,
        labelIds,
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers: [{ name: "Subject", value: "Video" }, { name: "From", value: "a@example.com" }, { name: "To", value: WORK }],
          body: { size: 0 },
          parts: [
            { partId: "0", mimeType: "text/plain", filename: "", headers: [], body: { data: Buffer.from("see").toString("base64url"), size: 3 } },
            { partId: "1", mimeType: "video/mp4", filename: "a.mp4", headers: [], body: { attachmentId: "ATT1", size: 20 * 1048576 } },
            { partId: "2", mimeType: "video/mp4", filename: "b.mp4", headers: [], body: { attachmentId: "ATT2", size: 10 * 1048576 } },
          ],
        },
      });
    };
    big("v1", ["INBOX"]);
    fake.batchCalls = 0;
    const fwd = await call("forward", { account: "work", messageId: "v1", to: ["x@example.com"] });
    assert.equal(fwd.isError, true);
    assert.match(fwd.text, /attachments add up to 30\.0 MB, more than the 25 MB Gmail allows.*Forward it in Gmail instead \(https:\/\/mail\.google\.com/);
    big("v2", ["DRAFT"]);
    work.drafts.set("r-big", "v2");
    const upd = await call("update_draft", { account: "work", draftId: "r-big", subject: "Video!" });
    assert.match(upd.text, /This draft's attachments add up to 30\.0 MB.*Pass `attachments` to replace them/);
    assert.equal(fake.batchCalls, 0, "nothing was downloaded");
    assert.ok(!fake.requests.some((r) => r.path.includes("/attachments/")));
    assert.equal(fake.sentBy(WORK).length, 0);
  });
});

describe("smaller thread views", () => {
  test("with bodies, get_thread gives the subject once and drops each message's snippet and threadId", async () => {
    const { call, fake, personal } = await setup();
    for (const [id, subject] of [["p2", "Re: Lunch?"], ["p3", "Change of plans"]]) {
      fake.deliver(personal, crlf([`From: alice@example.com`, `To: ${PERSONAL}`, `Subject: ${subject}`, "", `Body of ${id}`]), { id, threadId: "pt1" });
    }
    const res = await call("get_thread", { account: "personal", threadId: "pt1" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.subject, "Lunch?");
    assert.deepEqual(res.json.messages.map((m: any) => m.subject), [undefined, undefined, "Change of plans"]);
    for (const m of res.json.messages) {
      assert.equal(m.snippet, undefined);
      assert.equal(m.threadId, undefined);
      assert.match(m.viewUrl, /#all\/p\d$/);
      assert.ok(m.plaintextBody);
    }
    const full = await call("get_thread", { account: "personal", threadId: "pt1", messageFormat: "FULL_CONTENT" });
    assert.equal(full.json.subject, "Lunch?");
    assert.equal(full.json.messages[0].snippet, undefined);

    // Without bodies the snippet is the content, so nothing changes there.
    const minimal = await call("get_thread", { account: "personal", threadId: "pt1", messageFormat: "MINIMAL" });
    assert.equal(minimal.json.subject, undefined);
    assert.deepEqual(minimal.json.messages.map((m: any) => m.subject), ["Lunch?", "Re: Lunch?", "Change of plans"]);
    assert.ok(minimal.json.messages.every((m: any) => m.snippet && m.threadId === "pt1"));
  });
});

describe("combined search timeline", () => {
  test("problems with one account are listed at the top, with the account", async () => {
    const { call, fake } = await setup();
    fake.failAlways.set("threads/wt1", 429);
    const res = await call("search_threads", {});
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.threads.map((t: any) => t.id), ["wt2", "pt1"]);
    assert.deepEqual(res.json.unavailable, [{ account: WORK, threadIds: ["wt1"], error: res.json.unavailable[0].error }]);
    assert.match(res.json.unavailable[0].error, /429/);
    // list_drafts and list_labels stay grouped by account.
    const drafts = await call("list_drafts", {});
    assert.ok(Array.isArray(drafts.json.accounts));
  });
});

describe("unsubscribe", () => {
  /** Delivers a list email with the given unsubscribe headers. */
  function listMail(ctx: Ctx, mb: FakeMailbox, id: string, from: string, subject: string, unsub?: { header: string; oneClick?: boolean }) {
    ctx.fake.deliver(
      mb,
      crlf([
        `From: ${from}`,
        `To: ${mb.email}`,
        `Subject: ${subject}`,
        ...(unsub ? [`List-Unsubscribe: ${unsub.header}`] : []),
        ...(unsub?.oneClick ? ["List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
        "",
        "Deals!",
      ]),
      { id, labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] },
    );
  }

  async function storeMail() {
    const ctx = await setup();
    const levis = { header: "<https://unsub.levi.com/u?t=abc>, <mailto:unsub@levi.com>", oneClick: true };
    listMail(ctx, ctx.work, "levi1", "Levi's <news@e.levi.com>", "Old sale", levis);
    listMail(ctx, ctx.work, "levi2", "Levi's <news@e.levi.com>", "Jeans", levis);
    listMail(ctx, ctx.work, "levi3", "Levi's <news@e.levi.com>", "Newest sale", levis);
    listMail(ctx, ctx.work, "nord1", "Nordstrom <hello@nordstrom.com>", "Fall", { header: "<mailto:leave@nordstrom.com?subject=Remove%20me&body=Please%20remove>" });
    listMail(ctx, ctx.work, "nord2", "Nordstrom <hello@nordstrom.com>", "Winter", { header: "<mailto:leave@nordstrom.com?subject=Remove%20me&body=Please%20remove>" });
    listMail(ctx, ctx.work, "exp1", "Experian <alerts@experian.com>", "Your score", { header: "<https://www.experian.com/unsubscribe?id=9>" });
    listMail(ctx, ctx.work, "li1", "LinkedIn <jobs@linkedin.com>", "New jobs");
    return ctx;
  }

  test("a dry run shows one plan per sender and does nothing", async () => {
    const ctx = await storeMail();
    const res = await ctx.call("unsubscribe", { account: "work", query: "category:promotions", dryRun: true });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.dryRun, true);
    assert.deepEqual(
      res.json.senders.map((p: any) => [p.sender, p.method, p.emailsScanned]),
      [
        ["news@e.levi.com", "one-click", 3],
        ["hello@nordstrom.com", "email", 2],
        ["jobs@linkedin.com", "none", 1],
        ["alerts@experian.com", "link", 1],
      ],
    );
    const [levi, nord, linkedin, experian] = res.json.senders;
    assert.deepEqual(levi, {
      account: WORK,
      sender: "news@e.levi.com",
      name: "Levi's",
      method: "one-click",
      via: "unsub.levi.com",
      emailsScanned: 3,
      newestSubject: "Newest sale",
      newestDate: levi.newestDate,
    });
    assert.match(levi.newestDate, /^2026-/);
    assert.equal(nord.to, "leave@nordstrom.com");
    assert.equal(experian.link, "https://www.experian.com/unsubscribe?id=9");
    assert.match(linkedin.note, /bulk_trash or bulk_update, or set up a Gmail filter/);
    assert.match(res.json.note, /get their OK/);
    assert.equal(ctx.web.requests.length, 0);
    assert.equal(ctx.fake.sentBy(WORK).length, 0);
  });

  test("a real run posts the one-click request, emails mailto senders and hands back links", async () => {
    const ctx = await storeMail();
    const res = await ctx.call("unsubscribe", { account: "work", query: "category:promotions" });
    assert.equal(res.isError, false, res.text);
    const byResult = Object.fromEntries(res.json.senders.map((r: any) => [r.sender, r]));
    assert.equal(byResult["news@e.levi.com"].result, "unsubscribed");
    assert.equal(byResult["hello@nordstrom.com"].result, "unsubscribe email sent");
    assert.equal(byResult["alerts@experian.com"].result, "open this link");
    assert.equal(byResult["alerts@experian.com"].link, "https://www.experian.com/unsubscribe?id=9");
    assert.equal(byResult["jobs@linkedin.com"].result, "no unsubscribe option");
    assert.deepEqual(res.json.summary, { unsubscribed: 1, emailsSent: 1, linksToOpen: 1, noOption: 1, failed: 0 });
    assert.match(res.json.note, /bulk_update \(archive\) or bulk_trash/);

    // One POST per sender (three Levi's emails, one request), RFC 8058 style; links are never opened.
    assert.deepEqual(ctx.web.requests, [
      {
        url: "https://unsub.levi.com/u?t=abc",
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: "List-Unsubscribe=One-Click",
        redirect: "manual",
        hasSignal: true,
      },
    ]);
    const [sent] = ctx.fake.sentBy(WORK);
    const mime = inspectMime(sent.raw);
    assert.equal(mime.get("To"), "leave@nordstrom.com");
    assert.equal(mime.get("Subject"), "Remove me");
    assert.equal(mime.parts[0].text, "Please remove");
  });

  test("a mailto without a subject gets \"unsubscribe\"; failures say why", async () => {
    const ctx = await setup();
    listMail(ctx, ctx.work, "a1", "a@list.example", "A", { header: "<mailto:off@list.example>" });
    listMail(ctx, ctx.work, "b1", "b@shop.example", "B", { header: "<https://shop.example/u>", oneClick: true });
    listMail(ctx, ctx.work, "c1", "c@store.example", "C", { header: "<https://store.example/u>", oneClick: true });
    listMail(ctx, ctx.work, "d1", "d@redirect.example", "D", { header: "<https://redirect.example/u>", oneClick: true });
    ctx.web.answers.set("https://shop.example/", 500);
    ctx.web.answers.set("https://store.example/", "timeout");
    ctx.web.answers.set("https://redirect.example/", 302);
    const res = await ctx.call("unsubscribe", { account: "work", query: "category:promotions" });
    const by = Object.fromEntries(res.json.senders.map((r: any) => [r.sender, r]));
    assert.equal(inspectMime(ctx.fake.sentBy(WORK)[0].raw).get("Subject"), "unsubscribe");
    assert.equal(by["b@shop.example"].result, "failed");
    assert.match(by["b@shop.example"].reason, /answered 500/);
    assert.equal(by["b@shop.example"].link, "https://shop.example/u");
    assert.match(by["c@store.example"].reason, /didn't answer within 10 seconds/);
    assert.equal(by["d@redirect.example"].result, "unsubscribed", "a redirect counts as done, and isn't followed");
    assert.equal(ctx.web.requests.filter((r) => r.url.startsWith("https://redirect.example")).length, 1);
  });

  test("one-click addresses on IP addresses, local names or private networks are refused", async () => {
    const ctx = await setup();
    const oneClick = (url: string, mailto?: string) => ({ header: [`<${url}>`, ...(mailto ? [`<mailto:${mailto}>`] : [])].join(", "), oneClick: true });
    listMail(ctx, ctx.work, "i1", "a@one.example", "A", oneClick("https://10.0.0.5/u"));
    listMail(ctx, ctx.work, "i2", "b@two.example", "B", oneClick("https://0x7f.1/u"));
    listMail(ctx, ctx.work, "i3", "c@three.example", "C", oneClick("https://localhost/u"));
    listMail(ctx, ctx.work, "i4", "d@four.example", "D", oneClick("https://[::1]/u"));
    listMail(ctx, ctx.work, "i5", "e@five.example", "E", oneClick("https://printer.local/u"));
    listMail(ctx, ctx.work, "i6", "f@six.example", "F", oneClick("https://unsub.rebind.example/u"));
    listMail(ctx, ctx.work, "i7", "g@seven.example", "G", oneClick("https://192.168.1.1/u", "off@seven.example"));
    listMail(ctx, ctx.work, "i8", "h@eight.example", "H", oneClick("http://plain.example/u"));
    ctx.web.dns.set("unsub.rebind.example", ["203.0.113.7", "169.254.169.254"]);
    const dry = await ctx.call("unsubscribe", { account: "work", query: "", dryRun: true, maxSenders: 20 });
    const by = Object.fromEntries(dry.json.senders.map((r: any) => [r.sender, r]));
    for (const sender of ["a@one.example", "b@two.example", "d@four.example"]) {
      assert.equal(by[sender].method, "refused", sender);
      assert.match(by[sender].reason, /IP address/);
    }
    assert.match(by["b@two.example"].reason, /127\.0\.0\.1/);
    assert.match(by["c@three.example"].reason, /local network name \(localhost\)/);
    assert.match(by["e@five.example"].reason, /local network name \(printer\.local\)/);
    assert.match(by["f@six.example"].reason, /unsub\.rebind\.example leads to a private network address \(169\.254\.169\.254\)/);
    assert.equal(by["g@seven.example"].method, "email", "the mailto option is used instead");
    assert.match(by["g@seven.example"].note, /one-click address wasn't used/);
    assert.equal(by["h@eight.example"].method, "link", "plain http is never posted to");
    const real = await ctx.call("unsubscribe", { account: "work", query: "", maxSenders: 20 });
    assert.ok(real.json.senders.filter((r: any) => r.method === "refused").every((r: any) => r.result === "failed" && r.reason));
    assert.equal(ctx.web.requests.length, 0, "nothing was contacted");
  });

  test("senders are grouped per account, and maxSenders counts across accounts, busiest first", async () => {
    const ctx = await setup();
    const oc = (host: string) => ({ header: `<https://${host}/u>`, oneClick: true });
    for (const [mb, prefix] of [[ctx.personal, "p"], [ctx.work, "w"]] as const) {
      listMail(ctx, mb, `${prefix}s1`, "news@same.example", "S1", oc("same.example"));
      listMail(ctx, mb, `${prefix}s2`, "news@same.example", "S2", oc("same.example"));
    }
    listMail(ctx, ctx.work, "w3", "x@three.example", "3a", oc("three.example"));
    listMail(ctx, ctx.work, "w4", "x@three.example", "3b", oc("three.example"));
    listMail(ctx, ctx.work, "w5", "x@three.example", "3c", oc("three.example"));
    listMail(ctx, ctx.personal, "p6", "y@one.example", "1", oc("one.example"));
    const res = await ctx.call("unsubscribe", { query: "category:promotions", maxSenders: 3, dryRun: true });
    assert.deepEqual(
      res.json.senders.map((p: any) => [p.account, p.sender, p.emailsScanned]),
      [
        [WORK, "x@three.example", 3],
        [PERSONAL, "news@same.example", 2], // same count and date: in account order
        [WORK, "news@same.example", 2],
      ],
    );
    assert.match(res.json.moreSenders, /1 more sender\(s\) weren't included \(maxSenders is 3\).*query in nextRuns, or raise maxSenders/);
    assert.deepEqual(res.json.nextRuns, [{ account: PERSONAL, query: "(category:promotions) from:y@one.example" }]);
    const next = await ctx.call("unsubscribe", { ...res.json.nextRuns[0], dryRun: true });
    assert.deepEqual(next.json.senders.map((p: any) => [p.account, p.sender]), [[PERSONAL, "y@one.example"]]);
    const bad = await ctx.call("unsubscribe", { query: "x", messageIds: ["w3"] });
    assert.match(bad.text, /exactly one of `query` or `messageIds`/);
    const byId = await ctx.call("unsubscribe", { account: "work", messageIds: ["w3", "w4"], dryRun: true });
    assert.deepEqual(byId.json.senders.map((p: any) => [p.sender, p.emailsScanned]), [["x@three.example", 2]]);
  });

  test("five accounts with 20 senders stay under 40 Gmail and web calls", async () => {
    const ctx = await setup();
    for (let i = 3; i <= 5; i++) {
      const email = `extra${i}@example.com`;
      ctx.fake.addMailbox(email, `rt-${i}`);
      await ctx.store.upsert({ email, refreshToken: `rt-${i}`, scopes: [], addedAt: "" });
    }
    for (const [n, mb] of ctx.fake.mailboxes.entries()) {
      for (let s = 0; s < 6; s++) {
        for (let k = 0; k < 10; k++) {
          listMail(ctx, mb, `a${n}s${s}k${k}`, `news@sender${s}.example`, `Deal ${k}`, { header: `<https://sender${s}.example/u/${n}>`, oneClick: true });
        }
      }
    }
    ctx.fake.outboundCalls = 0;
    const res = await ctx.call("unsubscribe", { query: "category:promotions", maxSenders: 20 });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.summary.unsubscribed, 20);
    // 50 newest emails per account: 5 senders each, 25 in all.
    assert.match(res.json.moreSenders, /^5 more sender\(s\) weren't included \(maxSenders is 20\)\. .*query in nextRuns\.$/);
    assert.deepEqual(res.json.nextRuns, [
      {
        account: "extra5@example.com",
        query: "(category:promotions) (from:news@sender5.example OR from:news@sender4.example OR from:news@sender3.example OR from:news@sender2.example OR from:news@sender1.example)",
      },
    ]);
    // Per account: a token, one search and one metadata batch (50 emails); then one request per sender.
    assert.equal(ctx.fake.outboundCalls, 5 * 3);
    assert.equal(ctx.web.requests.length, 20);
    assert.ok(ctx.fake.outboundCalls + ctx.web.requests.length <= 40);
  });
});

describe("cheaper forwarding", () => {
  test("large attachments are fetched on their own and re-attached unchanged", async () => {
    const { call, fake, work } = await setup();
    const big = Buffer.from(Array.from({ length: 300_001 }, (_, i) => (i * 131 + (i >> 9)) & 0xff));
    const small = Buffer.from("small file\r\n");
    const file = (name: string, type: string, data: Buffer) => [
      "--B",
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      data.toString("base64"),
    ];
    fake.deliver(
      work,
      crlf([
        "From: a@example.com", `To: ${WORK}`, "Subject: Files", 'Content-Type: multipart/mixed; boundary="B"', "",
        "--B", "Content-Type: text/plain", "", "Two files",
        ...file("big.bin", "application/octet-stream", big),
        ...file("small.txt", "text/plain", small),
        "--B--",
      ]),
      { id: "files1" },
    );
    fake.batchCalls = 0;
    fake.requests.length = 0;
    const res = await call("forward", { account: "work", messageId: "files1", to: ["x@example.com"] });
    assert.equal(res.isError, false, res.text);
    const [sent] = fake.sentBy(WORK);
    const parts = inspectMime(sent.raw).parts.filter((p) => p.filename);
    assert.deepEqual(parts.map((p) => p.filename), ["big.bin", "small.txt"]);
    // inspectMime decodes as UTF-8 text, so compare the raw base64 instead.
    const body = (name: string) => sent.raw.split(`filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1].split("\r\n--")[0];
    assert.equal(Buffer.from(body("big.bin").replace(/\r\n/g, ""), "base64").equals(big), true);
    assert.ok(body("big.bin").split("\r\n").every((line) => line.length <= 76));
    assert.equal(Buffer.from(body("small.txt").replace(/\r\n/g, ""), "base64").toString(), small.toString());
    const direct = fake.requests.filter((r) => r.path.includes("/attachments/"));
    assert.equal(direct.length, 2, "both downloaded");
    assert.equal(fake.batchCalls, 1, "the small one in a batch, the large one on its own");
    assert.ok(fake.largestBody > 400_000, "the upload went out as bytes");
  });

  test("the hosted connector's lower limit is explained before anything is downloaded", async () => {
    const note = "The connector's owner can raise this limit with MAX_FORWARD_MB.";
    const { call, fake, work } = await setup({ maxAttachmentBytes: 2 * 1048576, maxAttachmentNote: note });
    const payload = (size: number) => ({
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [{ name: "Subject", value: "Slides" }, { name: "From", value: "a@example.com" }, { name: "To", value: WORK }],
      body: { size: 0 },
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", headers: [], body: { data: Buffer.from("see").toString("base64url"), size: 3 } },
        { partId: "1", mimeType: "application/pdf", filename: "deck.pdf", headers: [], body: { attachmentId: "ATT1", size } },
      ],
    });
    work.messages.set("s1", { id: "s1", threadId: "s1", labelIds: ["INBOX"], payload: payload(3.4 * 1048576) });
    fake.batchCalls = 0;
    const fwd = await call("forward", { account: "work", messageId: "s1", to: ["x@example.com"] });
    assert.equal(fwd.isError, true);
    assert.equal(
      fwd.text,
      "This email's attachments add up to 3.4 MB, more than the 2 MB this connector re-attaches, so it can't be forwarded with them from here. " +
        `Forward it in Gmail instead (https://mail.google.com/mail/?authuser=me%40work.example#all/s1), which sends large files as Google Drive links. ${note}`,
    );
    work.messages.set("d1", { id: "d1", threadId: "d1", labelIds: ["DRAFT"], payload: payload(3.4 * 1048576) });
    work.drafts.set("r-slides", "d1");
    const upd = await call("update_draft", { account: "work", draftId: "r-slides", subject: "Deck" });
    assert.equal(upd.text, `This draft's attachments add up to 3.4 MB, more than the 2 MB this connector re-attaches. Pass \`attachments\` to replace them, or edit the draft in Gmail. ${note}`);
    assert.equal(fake.batchCalls, 0);
    assert.ok(!fake.requests.some((r) => r.path.includes("/attachments/")), "nothing was downloaded");
    // Under the limit it goes through, and over 25 MB Gmail's own limit is what's explained.
    work.messages.set("s2", { id: "s2", threadId: "s2", labelIds: ["INBOX"], payload: payload(30 * 1048576) });
    const huge = await call("forward", { account: "work", messageId: "s2", to: ["x@example.com"] });
    assert.match(huge.text, /30\.0 MB, more than the 25 MB Gmail allows in one email/);
    assert.doesNotMatch(huge.text, /MAX_FORWARD_MB/);
  });
});

