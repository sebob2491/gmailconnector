import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountStore, FileHistoryStore } from "../src/accountStore.js";
import { setRetryWait, TokenProvider } from "../src/gmailClient.js";
import {
  capChanges,
  HISTORY_KV_KEY,
  KvHistoryStore,
  LOGGED_TOOLS,
  MAX_LOG_BYTES,
  MemoryHistoryStore,
  trimEntries,
  type HistoryEntry,
  type HistoryStore,
  type KvLike,
} from "../src/history.js";
import { labelNameCache, sendAsCache } from "../src/mailbox.js";
import { createServer } from "../src/server.js";
import { FakeGmail, type FakeMailbox } from "./fakeGmail.js";

const PERSONAL = "me.personal@gmail.com";
const WORK = "me@work.example";

const tmpDirs: string[] = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
setRetryWait(async () => undefined);

const crlf = (lines: string[]) => lines.join("\r\n");

/** A Workers KV stand-in that counts writes. */
class CountingKv implements KvLike {
  data = new Map<string, string>();
  puts = 0;
  deletes = 0;
  failPuts = 0;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }
    this.puts++;
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.deletes++;
    this.data.delete(key);
  }
}

/** A log that can't be written. */
class BrokenHistory implements HistoryStore {
  attempts = 0;
  async append() {
    this.attempts++;
    throw new Error("disk full");
  }
  async recent() {
    return [];
  }
  async clear() {}
}

function promo(fake: FakeGmail, mb: FakeMailbox, id: string, subject: string, opts: { threadId?: string; labelIds?: string[] } = {}) {
  fake.deliver(
    mb,
    crlf([`From: News <news@shop.example>`, `To: ${mb.email}`, `Subject: ${subject}`, "Content-Type: text/plain", "", `Secret body of ${id}`]),
    { id, threadId: opts.threadId ?? `t-${id}`, labelIds: opts.labelIds ?? ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] },
  );
}

async function setup(opts: { history?: HistoryStore } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-history-test-"));
  tmpDirs.push(dir);
  sendAsCache.clear();
  labelNameCache.clear();
  const store = new AccountStore(dir);
  const fake = new FakeGmail();
  const personal = fake.addMailbox(PERSONAL, "rt-personal");
  const work = fake.addMailbox(WORK, "rt-work");
  await store.upsert({ email: PERSONAL, alias: "personal", refreshToken: "rt-personal", scopes: [], addedAt: "" });
  await store.upsert({ email: WORK, alias: "work", refreshToken: "rt-work", scopes: [], addedAt: "" });
  personal.labels.push({ id: "Label_9", name: "Receipts", type: "user" });
  promo(fake, personal, "n1", "Sale 1");
  promo(fake, personal, "n2", "Sale 2");
  promo(fake, personal, "n3", "Sale 3");
  // A two-email thread, and an email already out of the inbox.
  promo(fake, personal, "c1", "Chat", { threadId: "ct", labelIds: ["INBOX"] });
  promo(fake, personal, "c2", "Re: Chat", { threadId: "ct", labelIds: ["INBOX", "UNREAD"] });
  promo(fake, personal, "old", "Old news", { labelIds: [] });
  promo(fake, work, "w1", "Work promo");

  const history = opts.history ?? new MemoryHistoryStore();
  const server = createServer({
    store,
    fetchImpl: fake.fetch,
    tokens: new TokenProvider(async () => ({ clientId: "cid", clientSecret: "secret" }), fake.fetch),
    history,
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
  const labels = (mb: FakeMailbox, id: string) => [...(mb.messages.get(id)!.labelIds ?? [])].sort();
  return { fake, store, client, personal, work, history, call, labels };
}

describe("activity log", () => {
  test("logs changes with short summaries, never email bodies, and skips reads and dry runs", async () => {
    const { call, history } = await setup();
    assert.equal((await call("search_threads", { query: "Sale" })).isError, false);
    assert.equal((await call("get_message", { account: "personal", messageId: "n1" })).isError, false);
    assert.equal((await call("bulk_update", { account: "personal", query: "category:promotions", action: "archive", dryRun: true })).isError, false);
    assert.deepEqual(await history.recent(10), [], "reads and dry runs aren't logged");

    const sent = await call("send_message", {
      account: "personal",
      to: ["bob@example.com"],
      subject: "Re: Q3 report",
      body: "THE SECRET BODY nobody should log",
    });
    assert.equal(sent.isError, false, sent.text);
    await call("create_filter", { account: "personal", criteria: { from: "linkedin.com" }, actions: { archive: true } });
    await call("create_filter", { account: "personal", criteria: { from: "x.com" }, actions: { archive: true }, preview: true });
    await call("bulk_update", { account: "personal", query: "category:promotions", action: "archive" });
    await call("trash_message", { account: "personal", messageId: "n1" });
    const failed = await call("delete_draft", { account: "personal", draftId: "nope" });
    assert.equal(failed.isError, true);

    const log = await call("recent_activity", {});
    assert.equal(log.isError, false, log.text);
    const entries = log.json.entries;
    assert.deepEqual(
      entries.map((e: any) => e.summary),
      [
        "Deleted draft nope",
        "Moved 'Sale 1' to Trash",
        "Archived 3 emails matching category:promotions",
        "Created filter: from:linkedin.com → archive",
        "Sent to bob@example.com: 'Re: Q3 report'",
      ],
    );
    assert.equal(entries[0].outcome, "error");
    assert.match(entries[0].error, /draft/i);
    assert.deepEqual(entries[4].accounts, [PERSONAL]);
    assert.equal(entries[1].undoable, true);
    assert.equal(entries[2].undoable, true);
    assert.equal(entries[2].emailsRecorded, 3);
    assert.equal(entries[3].undoable, undefined, "a filter isn't undoable here");
    assert.match(entries[0].time, /^\d{4}-\d\d-\d\dT/);
    assert.doesNotMatch(log.text, /SECRET|Secret body/);
    assert.doesNotMatch(JSON.stringify(await history.recent(100)), /SECRET|Secret body/);
    assert.doesNotMatch(log.text, /"messageIds"/, "recent_activity doesn't list email IDs");
  });

  test("the table covers today's change tools and the future change_labels / move_to", () => {
    for (const name of [
      "change_labels", "move_to", "send_message", "reply", "forward", "create_draft", "update_draft", "delete_draft",
      "bulk_update", "bulk_trash", "unsubscribe", "create_filter", "delete_filter", "create_label", "update_label",
      "delete_label", "label_message", "unlabel_message", "label_thread", "unlabel_thread", "update_message_labels",
      "trash_message", "trash_thread", "untrash_message", "untrash_thread", "mark_message_spam", "mark_thread_spam",
      "unmark_message_spam", "unmark_thread_spam",
    ]) {
      assert.ok(Object.hasOwn(LOGGED_TOOLS, name), name);
    }
    for (const name of ["search_threads", "get_message", "list_labels", "recent_activity", "undo_last_change"]) {
      assert.ok(!Object.hasOwn(LOGGED_TOOLS, name), name);
    }
  });

  test("a log that can't be written never breaks a tool", async () => {
    const history = new BrokenHistory();
    const { call, personal, labels } = await setup({ history });
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const archived = await call("bulk_update", { account: "personal", query: "category:promotions", action: "archive" });
      assert.equal(archived.isError, false, archived.text);
      assert.equal(archived.json.changed, 3);
      assert.deepEqual(labels(personal, "n1"), ["CATEGORY_PROMOTIONS", "UNREAD"]);
      const labeled = await call("label_message", { account: "personal", messageId: "n2", labelIds: ["Receipts"] });
      assert.equal(labeled.isError, false, labeled.text);
    } finally {
      console.warn = warn;
    }
    assert.equal(history.attempts, 2);
    assert.equal(warnings.length, 2);
    assert.match(String(warnings[0][0]), /activity log/);
  });

  test("results look the same with logging on (no undo data shown to Claude)", async () => {
    const { call } = await setup();
    const res = await call("bulk_update", { account: "personal", messageIds: ["n1", "n2"], action: "mark_read" });
    assert.deepEqual(res.json, { account: PERSONAL, action: "mark_read", changed: 2 });
  });

  test("a hosted (KV) log costs exactly one write per logged call, none for reads", async () => {
    const kv = new CountingKv();
    const { call } = await setup({ history: new KvHistoryStore(kv, { retryDelayMs: 0 }) });
    await call("search_threads", {});
    await call("list_labels", {});
    await call("recent_activity", {});
    await call("bulk_trash", { account: "personal", query: "category:promotions", action: "trash", dryRun: true });
    assert.equal(kv.puts, 0);
    await call("bulk_update", { account: "personal", query: "category:promotions", action: "archive" });
    assert.equal(kv.puts, 1);
    await call("label_thread", { account: "personal", threadId: "ct", labelIds: ["STARRED"] });
    assert.equal(kv.puts, 2);
    await call("undo_last_change", {});
    assert.equal(kv.puts, 3, "an undo is one write too: its own entry and the mark on the undone one");
    const stored = JSON.parse(kv.data.get(HISTORY_KV_KEY)!) as HistoryEntry[];
    assert.equal(stored.length, 3);
    assert.equal(stored[1].undone?.by, stored[2].id);
  });

  test("a KV write that fails (e.g. two writes to the key within a second) is tried again once", async () => {
    const kv = new CountingKv();
    const store = new KvHistoryStore(kv, { retryDelayMs: 0 });
    kv.failPuts = 1;
    await store.append(entry("a"));
    assert.equal((await store.recent(5)).length, 1);
    kv.failPuts = 2;
    await assert.rejects(store.append(entry("b")), /429/);
    assert.deepEqual((await store.recent(5)).map((e) => e.id), ["a"]);
  });

  test("the log keeps 100 entries within its size limit, dropping old undo data first", async () => {
    const store = new MemoryHistoryStore();
    for (let i = 0; i < 120; i++) await store.append(entry(`e${i}`));
    const all = await store.recent(1000);
    assert.equal(all.length, 100);
    assert.equal(all[0].id, "e119");
    assert.equal(all.at(-1)!.id, "e20");

    // Big undo records: 2,000 IDs each, about 40 KB.
    const big = (id: string) => entry(id, Array.from({ length: 2000 }, (_, i) => `18f${id}${String(i).padStart(10, "0")}`));
    const kv = new CountingKv();
    const capped = new KvHistoryStore(kv, { retryDelayMs: 0 });
    for (let i = 0; i < 10; i++) await capped.append(entry(`small${i}`));
    for (let i = 0; i < 6; i++) await capped.append(big(`big${i}`));
    const text = kv.data.get(HISTORY_KV_KEY)!;
    assert.ok(new TextEncoder().encode(text).length <= MAX_LOG_BYTES, `${text.length} bytes`);
    const kept = await capped.recent(100);
    assert.equal(kept.length, 16, "every entry is still listed");
    assert.ok(kept[0].undo, "the newest keeps its undo data");
    const dropped = kept.filter((e) => e.undoDropped).map((e) => e.id);
    assert.ok(dropped.includes("big0") && !dropped.includes("big5"), dropped.join());

    // When undo data alone isn't enough, the oldest entries go.
    const trimmed = trimEntries([...Array.from({ length: 50 }, (_, i) => entry(`x${i}`, [], "y".repeat(3000)))], 100, 64 * 1024);
    assert.ok(trimmed.length < 50 && trimmed.at(-1)!.id === "x49");
    assert.ok(new TextEncoder().encode(JSON.stringify(trimmed)).length <= 64 * 1024);
  });

  test("the local log is activity.json next to accounts.json, readable only by the user", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-history-file-"));
    tmpDirs.push(dir);
    const store = new FileHistoryStore(dir);
    await store.append(entry("one"));
    assert.equal(store.file, path.join(dir, "activity.json"));
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(store.file, "utf8"))[0].id, "one");
    await store.clear();
    assert.deepEqual(await store.recent(5), []);
  });

  test("more than 2,000 changed emails: the first 2,000 are kept and the entry says it's partly undoable", () => {
    const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const record = capChanges([
      { account: PERSONAL, messageIds: ids(1500, "a"), added: [], removed: ["INBOX"] },
      { account: WORK, messageIds: ids(1500, "b"), added: [], removed: ["INBOX"] },
    ]);
    assert.deepEqual(record.changes.map((c) => c.messageIds.length), [1500, 500]);
    assert.match(record.partial!, /Only 2,000 of the 3,000/);
    assert.equal(capChanges([{ account: PERSONAL, messageIds: ids(10, "c"), added: ["TRASH"], removed: [] }]).partial, undefined);
  });
});

describe("undo", () => {
  test("archiving 3 emails with bulk_update, then undo, puts them back in the inbox", async () => {
    const { call, personal, labels, fake } = await setup();
    const archived = await call("bulk_update", { account: "personal", messageIds: ["n1", "n2", "n3"], action: "archive" });
    assert.equal(archived.json.changed, 3);
    for (const id of ["n1", "n2", "n3"]) assert.ok(!labels(personal, id).includes("INBOX"));

    const before = fake.batchModifyCalls.length;
    const undone = await call("undo_last_change", {});
    assert.equal(undone.isError, false, undone.text);
    assert.equal(undone.json.undone, "Archived 3 emails");
    assert.equal(undone.json.restored, 3);
    for (const id of ["n1", "n2", "n3"]) assert.deepEqual(labels(personal, id), ["CATEGORY_PROMOTIONS", "INBOX", "UNREAD"]);
    assert.deepEqual(fake.batchModifyCalls.slice(before), [{ ids: ["n1", "n2", "n3"], addLabelIds: ["INBOX"], removeLabelIds: [] }]);

    const log = (await call("recent_activity", {})).json.entries;
    assert.equal(log[0].tool, "undo_last_change");
    assert.equal(log[0].summary, "Undid: Archived 3 emails (3 emails restored)");
    assert.equal(log[0].undoes, log[1].id);
    assert.ok(log[1].undone, "the archive is marked undone");
    assert.equal(log[1].undoable, undefined);

    const again = await call("undo_last_change", {});
    assert.equal(again.isError, true);
    assert.match(again.text, /Nothing to undo/);
    const same = await call("undo_last_change", { entryId: log[1].id });
    assert.equal(same.isError, true);
    assert.match(same.text, /already undone/);
  });

  test("only what actually changed is undone: an email already out of the inbox stays out", async () => {
    const { call, personal, labels } = await setup();
    await call("bulk_update", { account: "personal", messageIds: ["n1", "old"], action: "archive" });
    await call("undo_last_change", {});
    assert.ok(labels(personal, "n1").includes("INBOX"));
    assert.deepEqual(labels(personal, "old"), [], "it wasn't in the inbox before");
  });

  test("bulk_trash, then undo, takes the emails out of Trash", async () => {
    const { call, personal, labels } = await setup();
    const trashed = await call("bulk_trash", { account: "personal", query: "category:promotions", action: "trash" });
    assert.equal(trashed.json.changed, 3, trashed.text);
    assert.ok(labels(personal, "n2").includes("TRASH"));
    const undone = await call("undo_last_change", {});
    assert.equal(undone.json.restored, 3, undone.text);
    for (const id of ["n1", "n2", "n3"]) assert.ok(!labels(personal, id).includes("TRASH"), id);
    assert.ok(labels(personal, "n2").includes("INBOX"));
  });

  test("reporting spam, then undo, takes it out of Spam and back to the inbox", async () => {
    const { call, personal, labels } = await setup();
    await call("bulk_trash", { account: "personal", messageIds: ["n1", "old"], action: "spam" });
    assert.deepEqual(labels(personal, "n1"), ["CATEGORY_PROMOTIONS", "SPAM", "UNREAD"]);
    await call("undo_last_change", {});
    assert.deepEqual(labels(personal, "n1"), ["CATEGORY_PROMOTIONS", "INBOX", "UNREAD"]);
    assert.deepEqual(labels(personal, "old"), [], "not put in the inbox: it wasn't there");
  });

  test("adding a label to one email, then undo, removes just that label", async () => {
    const { call, personal, labels } = await setup();
    const res = await call("label_message", { account: "personal", messageId: "n2", labelIds: ["Receipts", "UNREAD"] });
    assert.equal(res.isError, false, res.text);
    assert.ok(labels(personal, "n2").includes("Label_9"));
    const log = (await call("recent_activity", {})).json.entries;
    assert.equal(log[0].summary, "Added Receipts, UNREAD to 'Sale 2'");
    const undone = await call("undo_last_change", {});
    assert.equal(undone.json.restored, 1);
    assert.deepEqual(labels(personal, "n2"), ["CATEGORY_PROMOTIONS", "INBOX", "UNREAD"], "UNREAD stays: it was there before");
  });

  test("a whole thread trashed, then undone, comes back message by message", async () => {
    const { call, personal, labels } = await setup();
    await call("trash_thread", { account: "personal", threadId: "ct" });
    assert.ok(labels(personal, "c1").includes("TRASH") && labels(personal, "c2").includes("TRASH"));
    const log = (await call("recent_activity", {})).json.entries;
    assert.equal(log[0].summary, "Moved thread 'Chat' to Trash");
    assert.equal(log[0].emailsRecorded, 2);
    await call("undo_last_change", { entryId: log[0].id });
    assert.deepEqual(labels(personal, "c1"), ["INBOX"]);
    assert.deepEqual(labels(personal, "c2"), ["INBOX", "UNREAD"]);
  });

  test("undo picks the latest change not yet undone, skipping what can't be undone", async () => {
    const { call, personal, labels } = await setup();
    await call("bulk_update", { account: "personal", messageIds: ["n1"], action: "star" });
    await call("send_message", { account: "personal", to: ["a@example.com"], subject: "Hi", body: "x" });
    const undone = await call("undo_last_change", {});
    assert.equal(undone.json.undone, "Starred 1 email");
    assert.ok(!labels(personal, "n1").includes("STARRED"));
  });

  test("sends, unsubscribes, filters and labels are refused, with how to reverse them by hand", async () => {
    const { call } = await setup();
    await call("create_filter", { account: "personal", criteria: { from: "linkedin.com" }, actions: { archive: true } });
    await call("send_message", { account: "personal", to: ["a@example.com"], subject: "Hi", body: "x" });
    const [sent, filter] = (await call("recent_activity", {})).json.entries;
    const refusedFilter = await call("undo_last_change", { entryId: filter.id });
    assert.equal(refusedFilter.isError, true);
    assert.match(refusedFilter.text, /Created filter: from:linkedin\.com → archive.*can't be undone here\. Delete the filter with delete_filter \(filterId \S+, account me\.personal@gmail\.com\)/);
    const refusedSend = await call("undo_last_change", { entryId: sent.id });
    assert.match(refusedSend.text, /can't be recalled/);
    assert.match((await call("undo_last_change", { entryId: "nope" })).text, /No activity entry nope/);
  });

  test("an account unlinked since the change is reported, not guessed at", async () => {
    const { call, store, work, labels } = await setup();
    await call("bulk_update", { account: "work", query: "", action: "archive" });
    assert.ok(!labels(work, "w1").includes("INBOX"));
    await store.remove("work");
    const undone = await call("undo_last_change", {});
    assert.equal(undone.isError, true);
    assert.match(undone.text, /me@work\.example is no longer linked/);
    assert.ok(!labels(work, "w1").includes("INBOX"));
    const log = (await call("recent_activity", {})).json.entries;
    assert.equal(log[0].outcome, "error");
    assert.equal(log[1].undoable, true, "still undoable once the account is linked again");
  });

  test("an old trash change: emails deleted for good are reported, the rest restored", async () => {
    const history = new MemoryHistoryStore();
    const { call, personal, labels } = await setup({ history });
    await call("bulk_trash", { account: "personal", messageIds: ["n1", "n2", "n3"], action: "trash" });
    // 40 days later Gmail has emptied part of the Trash.
    const stored = JSON.parse(history.text!) as HistoryEntry[];
    stored[0].time = new Date(Date.now() - 40 * 86_400_000).toISOString();
    history.text = JSON.stringify(stored);
    personal.messages.delete("n2");
    const undone = await call("undo_last_change", {});
    assert.equal(undone.isError, false, undone.text);
    assert.equal(undone.json.restored, 2);
    assert.match(undone.json.notes.join(" "), /over 30 days old/);
    assert.match(undone.json.notes.join(" "), /1 email no longer exists/);
    assert.ok(!labels(personal, "n1").includes("TRASH") && !labels(personal, "n3").includes("TRASH"));
  });

  test("a change across two accounts is undone in both", async () => {
    const { call, personal, work, labels } = await setup();
    const res = await call("bulk_update", { query: "category:promotions", action: "mark_read" });
    assert.equal(res.isError, false, res.text);
    const log = (await call("recent_activity", {})).json.entries;
    assert.deepEqual(log[0].accounts.sort(), [WORK, PERSONAL].sort());
    assert.equal(log[0].summary, "Marked 4 emails as read matching category:promotions");
    const undone = await call("undo_last_change", {});
    assert.equal(undone.json.restored, 4, undone.text);
    assert.ok(labels(personal, "n1").includes("UNREAD") && labels(work, "w1").includes("UNREAD"));
    assert.deepEqual(labels(personal, "c1"), ["INBOX"], "it was read already");
  });
});

function entry(id: string, messageIds: string[] = [], summary = `entry ${id}`): HistoryEntry {
  return {
    id,
    time: new Date().toISOString(),
    tool: "bulk_update",
    accounts: [PERSONAL],
    summary,
    outcome: "ok",
    ...(messageIds.length ? { undo: { changes: [{ account: PERSONAL, messageIds, added: [], removed: ["INBOX"] }] } } : {}),
  };
}
