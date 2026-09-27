import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountStore } from "../src/accountStore.js";
import { TokenProvider } from "../src/gmailClient.js";
import { createServer } from "../src/server.js";
import { FakeGmail, parseHeaders, type FakeMailbox } from "./fakeGmail.js";

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
  store: AccountStore;
  client: Client;
  personal: FakeMailbox;
  work: FakeMailbox;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;
}

async function setup(opts: { accounts?: "both" | "personal"; defaultAccount?: string } = {}): Promise<Ctx> {
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

  const server = createServer({
    store,
    fetchImpl: fake.fetch,
    tokens: new TokenProvider(async () => ({ clientId: "cid", clientSecret: "secret" }), fake.fetch),
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
  return { fake, store, client, personal, work, call };
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
  test("mirrors the Gmail connector's tools plus list_accounts", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "create_draft",
      "create_label",
      "delete_draft",
      "delete_label",
      "forward",
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
      { email: PERSONAL, alias: "personal", isDefault: false },
      { email: WORK, alias: "work", isDefault: true },
    ]);
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
  test("searches every account when `account` is omitted, grouped per account", async () => {
    const { call, fake } = await setup();
    const res = await call("search_threads", { query: "report OR lunch" });
    assert.equal(res.isError, false, res.text);
    const byAccount = Object.fromEntries(res.json.accounts.map((a: any) => [a.account, a]));
    assert.deepEqual(Object.keys(byAccount).sort(), [WORK, PERSONAL].sort());
    assert.equal(byAccount[PERSONAL].threads[0].messages[0].subject, "Lunch?");
    assert.deepEqual(
      byAccount[WORK].threads.map((t: any) => t.messages[0].subject),
      ["Benefits", "Q3 report"],
    );
    assert.match(byAccount[WORK].threads[0].viewUrl, /authuser=me%40work\.example#all\/wt2$/);
    const qs = fake.requests.filter((r) => r.path === "threads").map((r) => r.query.get("q"));
    assert.deepEqual(qs, ["(report OR lunch) -in:draft", "(report OR lunch) -in:draft"]);
  });

  test("a single account returns a flat result", async () => {
    const { call } = await setup();
    const res = await call("search_threads", { account: "personal" });
    assert.equal(res.json.account, PERSONAL);
    assert.equal(res.json.threads.length, 1);
    assert.equal(res.json.threads[0].totalMessages, 1);
    assert.equal(res.json.threads[0].messages[0].sender, "Alice <alice@example.com>");
    assert.deepEqual(res.json.threads[0].messages[0].toRecipients, [PERSONAL, '"Doe, Bob" <bob@example.com>']);
  });

  test("the combined page token continues only the accounts that have more", async () => {
    const { call, fake, work } = await setup();
    work.pageSize = 1;
    const first = await call("search_threads", {});
    assert.ok(first.json.nextPageToken.startsWith("multi:"));
    const workGroup = first.json.accounts.find((a: any) => a.account === WORK);
    assert.equal(workGroup.hasMore, true);
    assert.equal(workGroup.threads.length, 1);

    fake.requests.length = 0;
    const second = await call("search_threads", { pageToken: first.json.nextPageToken });
    assert.deepEqual(second.json.accounts.map((a: any) => a.account), [WORK]);
    assert.equal(second.json.accounts[0].threads[0].id, "wt1");
    assert.equal(second.json.nextPageToken, undefined);
    assert.ok(fake.requests.every((r) => r.email === WORK));
  });

  test("one failing account doesn't hide the others' results", async () => {
    const { call, fake } = await setup();
    fake.revoked.add("rt-personal");
    const res = await call("search_threads", {});
    assert.equal(res.isError, false);
    const personal = res.json.accounts.find((a: any) => a.account === PERSONAL);
    const work = res.json.accounts.find((a: any) => a.account === WORK);
    assert.match(personal.error, /Re-link/);
    assert.equal(work.threads.length, 2);
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
    assert.equal(mime.get("To"), "alice@example.com");
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
    assert.equal(mime.get("To"), "alice@example.com");
    assert.equal(mime.get("Cc"), "bob@example.com, carol@example.com");
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
    assert.equal(mime.get("To"), "boss@work.example");
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
