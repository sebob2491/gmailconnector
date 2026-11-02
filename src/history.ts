/**
 * The activity log and undo.
 *
 * Every tool call that changes something (listed in LOGGED_TOOLS) is recorded with a short human
 * summary: never email bodies, attachments or tokens; recipients, subjects and queries are kept
 * (it is the owner's own log), cut to about 200 characters. Label changes (archive, trash, spam,
 * labels) also record exactly which emails gained and lost which labels, so undo_last_change can
 * put them back.
 *
 * The log is one JSON value: one KV key on the hosted connector (one write per logged call),
 * activity.json next to accounts.json locally. Writing it never fails a tool.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sameEmail, type AccountSource } from "./accounts.js";
import { LABEL_CHANGES, type LabelChange, type Mailbox } from "./mailbox.js";

// ---------- entries ----------

export interface UndoRecord {
  /** What changed, per account and per group of emails that changed the same way. */
  changes: LabelChange[];
  /** Set when only some of the changed emails were recorded (see MAX_UNDO_IDS). */
  partial?: string;
}

export interface HistoryEntry {
  id: string;
  /** ISO 8601, UTC. */
  time: string;
  tool: string;
  accounts: string[];
  summary: string;
  outcome: "ok" | "partial" | "error";
  /** The error, short (with "partial", what went wrong for the rest). */
  error?: string;
  /** What was created, for reversing it by hand (a filter, draft or label ID). */
  ref?: string;
  /** For label changes: how to undo them. */
  undo?: UndoRecord;
  /** The undo data was dropped to keep the log within its size limit. */
  undoDropped?: boolean;
  /** Set once the change has been undone, with the undo's own entry. */
  undone?: { time: string; by: string };
  /** On an undo_last_change entry: the entry it undid. */
  undoes?: string;
}

export interface HistoryStore {
  /**
   * Adds an entry (one write). With `markUndone`, the same write marks that earlier entry as undone
   * by this one.
   */
  append(entry: HistoryEntry, opts?: { markUndone?: string }): Promise<void>;
  /** The latest `limit` entries, newest first. */
  recent(limit: number): Promise<HistoryEntry[]>;
  clear(): Promise<void>;
}

/** Entries kept. */
export const MAX_ENTRIES = 100;
/** Most bytes the stored log may take; beyond it, undo data and then the oldest entries go first. */
export const MAX_LOG_BYTES = 128 * 1024;
/** Most email IDs one entry records for undo. */
export const MAX_UNDO_IDS = 2000;
/** Longest summary, query or error kept. */
const MAX_TEXT = 200;
/** Gmail deletes emails in Trash and Spam for good after this many days. */
const TRASH_DAYS = 30;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * Keeps a log within `maxEntries` and `maxBytes` (as JSON): first the undo data of the oldest
 * changes that have it goes (their entries stay, with `undoDropped`), then the oldest entries. The
 * newest entry is always kept.
 */
export function trimEntries(entries: HistoryEntry[], maxEntries = MAX_ENTRIES, maxBytes = MAX_LOG_BYTES): HistoryEntry[] {
  const list = entries.slice(-maxEntries);
  const sizes = list.map((e) => byteLength(JSON.stringify(e)));
  let total = 2 + sizes.reduce((a, b) => a + b + 1, 0);
  for (let i = 0; i < list.length - 1 && total > maxBytes; i++) {
    if (!list[i].undo) continue;
    const { undo: _undo, ...rest } = list[i];
    list[i] = { ...rest, undoDropped: true };
    const size = byteLength(JSON.stringify(list[i]));
    total -= sizes[i] - size;
    sizes[i] = size;
  }
  let start = 0;
  while (start < list.length - 1 && total > maxBytes) total -= sizes[start++] + 1;
  return list.slice(start);
}

const isEntry = (value: unknown): value is HistoryEntry =>
  value !== null &&
  typeof value === "object" &&
  ["id", "time", "tool", "summary"].every((k) => typeof (value as Record<string, unknown>)[k] === "string");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A log kept as one JSON array (oldest first) wherever read/write/remove put it. Updates from this
 * object run one at a time; a failed write is tried once more, after `retryDelayMs`, on a fresh
 * read.
 */
export abstract class JsonHistoryStore implements HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(protected readonly options: { retryDelayMs?: number; maxEntries?: number; maxBytes?: number } = {}) {}

  protected abstract read(): Promise<string | null | undefined>;
  protected abstract write(text: string): Promise<void>;
  protected abstract remove(): Promise<void>;

  /** Every entry, oldest first. An unreadable log reads as empty. */
  async entries(): Promise<HistoryEntry[]> {
    const text = await this.read();
    if (!text) return [];
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) ? value.filter(isEntry) : [];
    } catch {
      console.warn("The activity log couldn't be read; starting a new one.");
      return [];
    }
  }

  async recent(limit: number): Promise<HistoryEntry[]> {
    return (await this.entries()).slice(-Math.max(0, limit)).reverse();
  }

  append(entry: HistoryEntry, opts: { markUndone?: string } = {}): Promise<void> {
    return this.update((list) => [
      ...list.map((e) => (e.id === opts.markUndone ? { ...e, undone: { time: entry.time, by: entry.id } } : e)),
      entry,
    ]);
  }

  clear(): Promise<void> {
    return this.serially(() => this.remove());
  }

  private update(change: (list: HistoryEntry[]) => HistoryEntry[]): Promise<void> {
    return this.serially(async () => {
      for (let attempt = 0; ; attempt++) {
        const next = trimEntries(change(await this.entries()), this.options.maxEntries, this.options.maxBytes);
        try {
          await this.write(JSON.stringify(next));
          return;
        } catch (err) {
          if (attempt >= 1) throw err;
          await sleep(this.options.retryDelayMs ?? 0);
        }
      }
    });
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** The part of a Workers KV namespace the log uses. */
export interface KvLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const HISTORY_KV_KEY = "gmail:history";

/**
 * The hosted connector's log: one KV key, so a logged call costs one read and one write (the free
 * plan allows 1,000 writes a day). KV takes at most one write per second to a key, so a failed
 * write is tried again a little over a second later.
 */
export class KvHistoryStore extends JsonHistoryStore {
  constructor(
    private readonly kv: KvLike,
    options: { retryDelayMs?: number; maxEntries?: number; maxBytes?: number } = {},
  ) {
    super({ retryDelayMs: 1100, ...options });
  }

  protected read() {
    return this.kv.get(HISTORY_KV_KEY, "text");
  }
  protected write(text: string) {
    return this.kv.put(HISTORY_KV_KEY, text);
  }
  protected remove() {
    return this.kv.delete(HISTORY_KV_KEY);
  }
}

/** A log in memory (tests, and anything that doesn't need it kept). */
export class MemoryHistoryStore extends JsonHistoryStore {
  text: string | null = null;
  protected async read() {
    return this.text;
  }
  protected async write(text: string) {
    this.text = text;
  }
  protected async remove() {
    this.text = null;
  }
}

// ---------- describing tool calls ----------

/** Collapses whitespace and cuts `text` to `max` characters. */
export function clip(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const quoted = (text: string) => `'${clip(text, 120)}'`;
const joinList = (items: string[], max = 3) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

type Args = Record<string, any>;
/** What a target's emails looked like before the call: labels by message ID, and a few subjects. */
interface Snapshot {
  mailbox: Mailbox;
  labels: Map<string, string[]>;
  subjects: string[];
  targets: { messageIds: string[]; threadIds: string[] };
}

interface ActionSpec {
  /** Calls that change nothing (dry runs, previews) aren't logged. */
  skip?: (args: Args) => boolean;
  summary: (args: Args, raw: any, snap: Snapshot | undefined) => string;
  /**
   * "labels": reads the target emails' labels before and after the call (single messages and
   * threads), so the record holds exactly what changed; "subject": reads the target's subject
   * before (for the summary). Changes reported by bulkModify are recorded either way.
   */
  read?: "labels" | "subject";
  /** What was created, to reverse it by hand. */
  ref?: (raw: any) => string | undefined;
}

/** How a target reads in a summary: its subject when known, else its ID. */
function target(args: Args, snap: Snapshot | undefined): string {
  const subject = snap?.subjects[0];
  const thread = strings(args.threadId).length + strings(args.threadIds).length > 0;
  const ids = [...strings(args.messageId), ...strings(args.messageIds), ...strings(args.threadId), ...strings(args.threadIds)];
  if (ids.length > 1) return count(ids.length, thread ? "thread" : "email");
  if (subject) return `${thread ? "thread " : ""}${quoted(subject)}`;
  return `${thread ? "thread" : "message"} ${ids[0] ?? "?"}`;
}

/** Recipients for a summary: To, then how many more in Cc/Bcc. */
function recipients(args: Args): string {
  const to = strings(args.to);
  const more = strings(args.cc).length + strings(args.bcc).length;
  const shown = to.length ? joinList(to) : "";
  if (!shown) return more ? count(more, "Cc/Bcc recipient") : "(no recipients)";
  return more ? `${shown} (+${more} Cc/Bcc)` : shown;
}

const BULK_VERBS: Record<string, (n: string, labels: string) => string> = {
  archive: (n) => `Archived ${n}`,
  move_to_inbox: (n) => `Moved ${n} to the inbox`,
  mark_read: (n) => `Marked ${n} as read`,
  mark_unread: (n) => `Marked ${n} as unread`,
  star: (n) => `Starred ${n}`,
  unstar: (n) => `Unstarred ${n}`,
  add_labels: (n, labels) => `Added ${labels} to ${n}`,
  remove_labels: (n, labels) => `Removed ${labels} from ${n}`,
  trash: (n) => `Moved ${n} to Trash`,
  spam: (n) => `Reported ${n} as spam`,
};

/** A number in a result: the field itself, or its sum over `accounts`. */
function total(raw: any, key: string): number | undefined {
  if (typeof raw?.[key] === "number") return raw[key];
  if (!Array.isArray(raw?.accounts)) return undefined;
  return raw.accounts.reduce((n: number, a: any) => n + (typeof a?.[key] === "number" ? a[key] : 0), 0);
}

function bulkSummary(args: Args, raw: any): string {
  const changed = total(raw, "changed");
  const n = changed === undefined ? "emails" : count(changed, "email");
  const verb = BULK_VERBS[args.action] ?? ((x: string) => `${args.action} on ${x}`);
  const where =
    typeof args.query === "string"
      ? args.query.trim()
        ? ` matching ${args.query}`
        : " (all mail)"
      : strings(args.threadIds).length
        ? ` in ${count(strings(args.threadIds).length, "thread")}`
        : "";
  return verb(n, joinList(strings(args.labelIds))) + where;
}

const FILTER_ACTION_NAMES: Record<string, string> = {
  archive: "archive",
  markRead: "mark read",
  star: "star",
  markImportant: "mark important",
  neverImportant: "never important",
  trash: "trash",
  neverSpam: "never spam",
};

function filterActions(actions: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(actions ?? {})) {
    if (value === true && FILTER_ACTION_NAMES[key]) parts.push(FILTER_ACTION_NAMES[key]);
    else if (key === "addLabels") parts.push(`label ${joinList(strings(value))}`);
    else if (key === "removeLabels") parts.push(`remove label ${joinList(strings(value))}`);
    else if (key === "category" && typeof value === "string") parts.push(`category ${value}`);
    else if (key === "forward" && typeof value === "string") parts.push(`forward to ${value}`);
  }
  return parts.join(", ") || "?";
}

/** A filter's criteria as a search, e.g. "from:linkedin.com has:attachment". */
function filterCriteria(criteria: Record<string, unknown> | undefined): string {
  const c = criteria ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (value === undefined || value === "" || value === false) continue;
    if (key === "from" || key === "to" || key === "subject") parts.push(`${key}:${String(value)}`);
    else if (key === "query") parts.push(String(value));
    else if (key === "negatedQuery") parts.push(`-(${String(value)})`);
    else if (key === "hasAttachment") parts.push("has:attachment");
    else if (key === "size") parts.push(`${c.sizeComparison === "smaller" ? "smaller" : "larger"}:${String(value)}`);
  }
  return parts.join(" ") || "?";
}

/** change_labels: what it does, for summaries ("Archived 'Sale'", "Added Receipts to 3 emails"). */
function changeLabelsSummary(args: Args, _raw: unknown, snap: Snapshot | undefined): string {
  const add = strings(args.add);
  const remove = strings(args.remove);
  const what = target(args, snap);
  const only = (list: string[], id: string) => list.length === 1 && list[0].toUpperCase() === id;
  if (!add.length && only(remove, "INBOX")) return `Archived ${what}`;
  if (!add.length && only(remove, "UNREAD")) return `Marked ${what} as read`;
  if (!remove.length && only(add, "UNREAD")) return `Marked ${what} as unread`;
  if (!remove.length && only(add, "STARRED")) return `Starred ${what}`;
  if (!add.length && only(remove, "STARRED")) return `Unstarred ${what}`;
  if (!remove.length) return `Added ${joinList(add)} to ${what}`;
  if (!add.length) return `Removed ${joinList(remove)} from ${what}`;
  return `Changed labels on ${what}: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join(" ")}`;
}

const MOVE_VERBS: Record<string, (what: string) => string> = {
  trash: (w) => `Moved ${w} to Trash`,
  out_of_trash: (w) => `Restored ${w} from Trash`,
  spam: (w) => `Reported ${w} as spam`,
  not_spam: (w) => `Moved ${w} out of Spam`,
  inbox: (w) => `Moved ${w} to the inbox`,
};

function moveSummary(args: Args, _raw: unknown, snap: Snapshot | undefined): string {
  const what = target(args, snap);
  return (MOVE_VERBS[String(args.destination)] ?? ((w: string) => `Moved ${w}`))(what);
}

/** The tools whose calls are logged, by name. */
export const LOGGED_TOOLS: Record<string, ActionSpec> = {
  send_message: {
    summary: (a) => (a.draftId ? `Sent draft ${a.draftId}` : `Sent to ${recipients(a)}: ${quoted(a.subject ?? "(no subject)")}`),
  },
  reply: {
    read: "subject",
    summary: (a, _r, s) => `Replied${a.replyAll ? " to all" : ""} to ${target(a, s)}${strings(a.to).length ? ` (to ${recipients(a)})` : ""}`,
  },
  forward: { read: "subject", summary: (a, _r, s) => `Forwarded ${target(a, s)} to ${recipients(a)}` },
  create_draft: {
    summary: (a) =>
      a.replyToMessageId && !strings(a.to).length
        ? `Created a reply draft to message ${a.replyToMessageId}`
        : `Created draft to ${recipients(a)}: ${quoted(a.subject ?? "(no subject)")}`,
    ref: (r) => r?.id,
  },
  update_draft: { summary: (a) => `Updated draft ${a.draftId}${a.subject ? `: ${quoted(a.subject)}` : ""}` },
  delete_draft: { summary: (a) => `Deleted draft ${a.draftId}` },
  bulk_update: { skip: (a) => Boolean(a.dryRun), summary: bulkSummary },
  bulk_trash: { skip: (a) => Boolean(a.dryRun), summary: bulkSummary },
  unsubscribe: {
    skip: (a) => Boolean(a.dryRun),
    summary: (a, r) => {
      if (!Array.isArray(r?.senders)) return `Unsubscribe from senders ${a.query !== undefined ? `matching ${a.query}` : `of ${count(strings(a.messageIds).length, "email")}`}`;
      const done = r.senders.filter((s: any) => s.result === "unsubscribed" || s.result === "unsubscribe email sent").map((s: any) => String(s.sender));
      const failed = r.senders.filter((s: any) => s.result === "failed").length;
      const links = r.senders.filter((s: any) => s.result === "open this link").length;
      return (
        `Unsubscribed from ${count(done.length, "sender")}${done.length ? ` (${joinList(done)})` : ""}` +
        (links ? `; ${count(links, "sender")} need a link opened` : "") +
        (failed ? `; ${failed} failed` : "")
      );
    },
  },
  create_filter: {
    skip: (a) => Boolean(a.preview),
    summary: (a) => `Created filter: ${filterCriteria(a.criteria)} → ${filterActions(a.actions)}`,
    ref: (r) => r?.created?.id,
  },
  delete_filter: {
    summary: (a, r) => `Deleted filter ${a.filterId}${r?.deleted ? `: ${filterCriteria(r.deleted.criteria)} → ${filterActions(r.deleted.actions)}` : ""}`,
  },
  create_label: { summary: (a) => `Created label ${quoted(a.displayName ?? "")}`, ref: (r) => r?.id },
  update_label: {
    summary: (a) => `Updated label ${quoted(a.labelId ?? "")}${a.displayName ? ` (renamed to ${quoted(a.displayName)})` : ""}`,
  },
  delete_label: { summary: (a) => `Deleted label ${quoted(a.labelId ?? "")}` },
  change_labels: { read: "labels", summary: changeLabelsSummary },
  move_to: { read: "labels", summary: moveSummary },
};

/** How to reverse what can't be undone here, by tool. */
const MANUAL_REVERSAL: Record<string, (entry: HistoryEntry) => string> = {
  send_message: () => "Sent email can't be recalled. If needed, send a follow-up.",
  reply: () => "Sent email can't be recalled. If needed, send a follow-up.",
  forward: () => "Sent email can't be recalled. If needed, send a follow-up.",
  unsubscribe: () => "Unsubscribing can't be undone from here: to get those emails again, subscribe again on each sender's website.",
  create_filter: (e) => `Delete the filter with delete_filter${e.ref ? ` (filterId ${e.ref}, account ${e.accounts[0]})` : ""}.`,
  delete_filter: () => "Create the filter again with create_filter, with the criteria and actions in this entry's summary.",
  create_label: (e) => `Delete the label with delete_label${e.ref ? ` (labelId ${e.ref})` : ""}.`,
  update_label: () => "Change it back with update_label.",
  delete_label: () => "Create the label again with create_label. Gmail doesn't keep which emails had it, so they can't be relabeled automatically.",
  create_draft: (e) => `Delete the draft with delete_draft${e.ref ? ` (draftId ${e.ref})` : ""}.`,
  update_draft: () => "The draft's earlier content wasn't kept; edit it again with update_draft.",
  delete_draft: () => "A deleted draft can't be recovered.",
};

/** The emails a call targets by ID (for "labels" reads). */
function targetsOf(args: Args) {
  return {
    messageIds: [...strings(args.messageId), ...strings(args.messageIds)],
    threadIds: [...strings(args.threadId), ...strings(args.threadIds)],
  };
}

/** Most messages + threads whose labels are read before and after a call (two batch calls). */
const MAX_READ_TARGETS = 50;

/** Per message, what was added and removed between two reads, grouped like bulkModify's changes. */
function diffSnapshots(account: string, before: Map<string, string[]>, after: Map<string, string[]>): LabelChange[] {
  const groups = new Map<string, LabelChange>();
  for (const [id, had] of before) {
    const has = after.get(id);
    if (!has) continue;
    const added = has.filter((l) => !had.includes(l)).sort();
    const removed = had.filter((l) => !has.includes(l)).sort();
    if (!added.length && !removed.length) continue;
    const key = JSON.stringify([added, removed]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { account, messageIds: [], added, removed }));
    group.messageIds.push(id);
  }
  return [...groups.values()];
}

/** The label changes bulkModify reported in a result (also per account). */
function reportedChanges(raw: any): LabelChange[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const found: LabelChange[] = [];
  let reported = false;
  for (const part of [raw, ...(Array.isArray(raw.accounts) ? raw.accounts : [])]) {
    const changes = part?.[LABEL_CHANGES];
    if (Array.isArray(changes)) {
      reported = true;
      found.push(...changes);
    }
  }
  return reported ? found : undefined;
}

/** Keeps at most `max` email IDs across the changes, saying how many weren't kept. */
export function capChanges(changes: LabelChange[], max = MAX_UNDO_IDS): UndoRecord {
  const all = changes.reduce((n, c) => n + c.messageIds.length, 0);
  if (all <= max) return { changes };
  let room = max;
  const kept: LabelChange[] = [];
  for (const c of changes) {
    if (!room) break;
    kept.push({ ...c, messageIds: c.messageIds.slice(0, room) });
    room -= Math.min(room, c.messageIds.length);
  }
  return {
    changes: kept,
    partial: `Only ${max.toLocaleString("en-US")} of the ${all.toLocaleString("en-US")} changed emails were recorded, so undo puts back those ${max.toLocaleString("en-US")} only.`,
  };
}

function newId(): string {
  const random = new Uint8Array(3);
  crypto.getRandomValues(random);
  return Date.now().toString(36) + [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The value a tool's result was made from (see withRawResult). */
const RAW_RESULT = Symbol("rawResult");

/**
 * Keeps the value a result's JSON was made from on the result, out of sight (not enumerable, not
 * serialized), so the log can read it, including what bulkModify reports under LABEL_CHANGES.
 */
export function withRawResult(result: CallToolResult, value: unknown): CallToolResult {
  Object.defineProperty(result, RAW_RESULT, { value, enumerable: false });
  return result;
}

const resultText = (result: CallToolResult | undefined) => {
  const first = result?.content?.[0];
  return first && first.type === "text" ? first.text : "";
};

/** The accounts a call acted on, from its result, else from its arguments. */
function accountsOf(args: Args, raw: any): string[] {
  const found = new Set<string>();
  if (typeof raw?.account === "string") found.add(raw.account);
  for (const list of [raw?.accounts, raw?.senders]) {
    if (Array.isArray(list)) for (const a of list) if (typeof a?.account === "string") found.add(a.account);
  }
  if (!found.size && typeof args.account === "string" && args.account.trim() && args.account.trim().toLowerCase() !== "all") found.add(args.account.trim());
  return [...found];
}

/** The first error a result reports beside its successes (a bulk change that stopped partway, an account that failed). */
function partialError(raw: any): string | undefined {
  if (typeof raw?.error === "string") return raw.error;
  for (const list of [raw?.accounts, raw?.errors]) {
    if (!Array.isArray(list)) continue;
    const failed = list.find((a: any) => typeof a?.error === "string");
    if (failed) return failed.account ? `${failed.account}: ${failed.error}` : failed.error;
  }
  return undefined;
}

/** What the log and undo use of the connector's account routing. */
export interface HistoryRouter {
  readonly store: AccountSource;
  one(ref: string | undefined): Promise<Mailbox>;
}

export interface HistoryContext {
  history: HistoryStore;
  router: HistoryRouter;
}

async function readTarget(ctx: HistoryContext, args: Args, spec: ActionSpec): Promise<Snapshot | undefined> {
  if (!spec.read) return undefined;
  const targets = spec.read === "subject" ? { messageIds: strings(args.messageId), threadIds: [] } : targetsOf(args);
  const n = targets.messageIds.length + targets.threadIds.length;
  if (!n || n > MAX_READ_TARGETS) return undefined;
  const mailbox = await ctx.router.one(args.account);
  const { labels, subjects } = await mailbox.labelSnapshot(targets, { subjects: true });
  return { mailbox, labels, subjects, targets };
}

/** The log entry for one call. */
async function describeCall(tool: string, spec: ActionSpec, args: Args, result: CallToolResult | undefined, snap: Snapshot | undefined): Promise<HistoryEntry> {
  const failed = !result || result.isError === true;
  const raw = failed ? undefined : (result as unknown as Record<symbol, unknown>)[RAW_RESULT];
  let changes = failed ? undefined : reportedChanges(raw);
  const summary = spec.summary(args, raw, snap);
  if (!failed && !changes && snap && spec.read === "labels") {
    try {
      const after = await snap.mailbox.labelSnapshot(snap.targets);
      changes = diffSnapshots(snap.mailbox.email, snap.labels, after.labels);
    } catch {
      changes = undefined; // the change happened; it just can't be undone from here
    }
  }
  const partial = failed ? undefined : partialError(raw);
  const error = failed ? resultText(result) || "The call failed." : partial;
  const ref = failed ? undefined : spec.ref?.(raw);
  return {
    id: newId(),
    time: new Date().toISOString(),
    tool,
    accounts: accountsOf(args, raw).length ? accountsOf(args, raw) : snap ? [snap.mailbox.email] : [],
    summary: clip(summary),
    outcome: failed ? "error" : partial ? "partial" : "ok",
    ...(error ? { error: clip(error) } : {}),
    ...(typeof ref === "string" ? { ref: clip(ref, 100) } : {}),
    ...(changes?.length ? { undo: capChanges(changes) } : {}),
  };
}

/**
 * Logs the calls of every tool in LOGGED_TOOLS registered on `server` from now on: wraps
 * registerTool, so it must run before those tools are registered. Logging never fails a call or
 * changes its result: anything that goes wrong is only warned about.
 */
export function logToolCalls(server: McpServer, ctx: HistoryContext): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...a: any[]) => unknown) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...a: any[]) => unknown) => {
    const spec = Object.hasOwn(LOGGED_TOOLS, name) ? LOGGED_TOOLS[name] : undefined;
    if (!spec) return register(name, config, cb);
    return register(name, config, async (...a: any[]) => {
      const args = (a[0] ?? {}) as Args;
      if (spec.skip?.(args)) return cb(...a);
      let snap: Snapshot | undefined;
      try {
        snap = await readTarget(ctx, args, spec);
      } catch {
        snap = undefined; // e.g. an unknown ID: the tool itself says so
      }
      let result: CallToolResult | undefined;
      try {
        result = (await cb(...a)) as CallToolResult;
        return result;
      } finally {
        try {
          await ctx.history.append(await describeCall(name, spec, args, result, snap));
        } catch (err) {
          console.warn(`Couldn't add ${name} to the activity log:`, err instanceof Error ? err.message : err);
        }
      }
    });
  };
}

// ---------- the tools ----------

class HistoryError extends Error {}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

/** An entry as recent_activity shows it: no email IDs. */
function showEntry(e: HistoryEntry) {
  const ids = e.undo?.changes.reduce((n, c) => n + c.messageIds.length, 0) ?? 0;
  return {
    id: e.id,
    time: e.time,
    tool: e.tool,
    ...(e.accounts.length ? { accounts: e.accounts } : {}),
    summary: e.summary,
    ...(e.outcome !== "ok" ? { outcome: e.outcome } : {}),
    ...(e.error ? { error: e.error } : {}),
    ...(e.undone ? { undone: e.undone.time } : e.undo ? { undoable: true, emailsRecorded: ids } : {}),
    ...(e.undo?.partial && !e.undone ? { partiallyUndoable: e.undo.partial } : {}),
    ...(e.undoDropped ? { undoDropped: "Its undo data was dropped to keep the log small." } : {}),
    ...(e.undoes ? { undoes: e.undoes } : {}),
  };
}

/** Why an entry can't be undone here, and how to reverse it by hand when that's possible. */
function refusal(e: HistoryEntry): string {
  const what = `"${e.summary}" (${e.tool}, ${e.time})`;
  if (e.undoes) return `${what} is itself an undo. To redo that change, run the original action again.`;
  if (e.undone) return `${what} was already undone at ${e.undone.time}.`;
  if (e.outcome === "error") return `${what} failed, so nothing changed and there is nothing to undo.`;
  if (e.undoDropped) {
    return `${what} can't be undone here any more: its undo data was dropped to keep the activity log small (newer changes keep theirs). Reverse it with bulk_update or bulk_trash instead.`;
  }
  const manual = MANUAL_REVERSAL[e.tool];
  if (manual) return `${what} can't be undone here. ${manual(e)}`;
  return `${what} can't be undone here: which emails it changed wasn't recorded. Reverse it with bulk_update (or the label tools) instead.`;
}

export function registerHistoryTools(server: McpServer, ctx: HistoryContext): void {
  const { history, router } = ctx;

  server.registerTool(
    "recent_activity",
    {
      title: "Recent activity",
      description:
        "Lists what this connector recently did in the user's Gmail accounts, newest first: sending, replying, forwarding, drafts, bulk and label changes, trash, spam, filters, labels and unsubscribes (not searches or reads). Each entry has `time` (UTC; convert to the user's timezone), `accounts`, a `summary`, `outcome` and `error` when it didn't fully work, and `undoable` when undo_last_change can reverse it. Use it to answer \"what did you do in my email today?\" and before undo_last_change. Email content is never logged.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(MAX_ENTRIES).optional().describe(`Entries to return (default 20, max ${MAX_ENTRIES}).`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const entries = await history.recent(args.limit ?? 20);
        return entries.length
          ? { entries: entries.map(showEntry) }
          : { entries: [], note: "Nothing has been logged yet (the log starts when changes are made through this connector)." };
      }),
  );

  server.registerTool(
    "undo_last_change",
    {
      title: "Undo a change",
      description:
        "Reverses a label change made through this connector: archiving, marking read/unread, starring, labeling, trashing or reporting spam (bulk_update, bulk_trash and the single-email tools), using the activity log. Without `entryId`, the most recent such change not yet undone. Before running it, call recent_activity, tell the user which change will be undone (its summary and time) and get their confirmation. Sent email, unsubscribes, filters, labels and drafts can't be undone here: the error says how to reverse them by hand.",
      inputSchema: z.strictObject({
        entryId: z.string().optional().describe("The `id` of an entry from recent_activity (default: the latest undoable change)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const entries = await history.recent(MAX_ENTRIES);
        const entry = args.entryId ? entries.find((e) => e.id === args.entryId) : entries.find((e) => e.undo && !e.undone && !e.undoes);
        if (!entry) {
          throw new HistoryError(
            args.entryId
              ? `No activity entry ${args.entryId}. The log keeps the latest ${MAX_ENTRIES}; see recent_activity.`
              : "Nothing to undo: no label, archive, trash or spam change in the activity log is waiting to be undone (see recent_activity).",
          );
        }
        if (!entry.undo || entry.undone || entry.undoes || entry.outcome === "error") throw new HistoryError(refusal(entry));

        const linked = (await router.store.load()).accounts;
        const notes: string[] = [];
        const results: Record<string, unknown>[] = [];
        let restored = 0;
        let missing = 0;
        let unfinished = 0;
        const errors: string[] = [];
        for (const change of entry.undo.changes) {
          if (!linked.some((a) => sameEmail(a.email, change.account))) {
            unfinished += change.messageIds.length;
            errors.push(`${change.account} is no longer linked, so its ${count(change.messageIds.length, "email")} can't be changed back. Link it again, then retry.`);
            continue;
          }
          try {
            const mb = await router.one(change.account);
            const r = await mb.revertLabelChange(change);
            restored += r.restored;
            missing += r.missing.length;
            if (r.error) {
              unfinished += r.notRestored ?? 0;
              errors.push(`${change.account}: ${r.error}`);
            }
            results.push({ account: change.account, restored: r.restored, ...(r.missing.length ? { gone: r.missing.length } : {}) });
          } catch (err) {
            unfinished += change.messageIds.length;
            errors.push(`${change.account}: ${(err as Error).message}`);
          }
        }

        const ageDays = (Date.now() - Date.parse(entry.time)) / 86_400_000;
        const trashOrSpam = entry.undo.changes.some((c) => c.added.includes("TRASH") || c.added.includes("SPAM"));
        if (trashOrSpam && ageDays > TRASH_DAYS) {
          notes.push(`This change is over ${TRASH_DAYS} days old: Gmail deletes emails in Trash and Spam for good after ${TRASH_DAYS} days, so some may be gone.`);
        }
        if (missing) notes.push(`${count(missing, "email")} no longer exist${missing === 1 ? "s" : ""} (deleted for good), so ${missing === 1 ? "it" : "they"} couldn't be restored.`);
        if (entry.undo.partial) notes.push(entry.undo.partial);
        const approximate = entry.undo.changes.filter((c) => c.approximate && c.removed.length);
        if (approximate.length) {
          const labels = [...new Set(approximate.flatMap((c) => c.removed))].join(", ");
          notes.push(`The emails' labels weren't all read before the change, so some may now have ${labels} without having had it before.`);
        }

        // Finished (nothing left that a retry could do): marked undone, so it isn't picked again.
        const finished = !errors.length;
        const outcome: HistoryEntry["outcome"] = finished ? "ok" : restored ? "partial" : "error";
        const undoEntry: HistoryEntry = {
          id: newId(),
          time: new Date().toISOString(),
          tool: "undo_last_change",
          accounts: [...new Set(entry.undo.changes.map((c) => c.account))],
          summary: clip(`Undid: ${entry.summary} (${count(restored, "email")} restored)`),
          outcome,
          ...(errors.length ? { error: clip(errors.join(" ")) } : {}),
          undoes: entry.id,
        };
        try {
          await history.append(undoEntry, finished ? { markUndone: entry.id } : {});
        } catch (err) {
          console.warn("Couldn't add the undo to the activity log:", err instanceof Error ? err.message : err);
          notes.push("The activity log couldn't be updated, so this change may still show as not undone.");
        }
        if (!restored && errors.length) throw new HistoryError(`Couldn't undo "${entry.summary}": ${errors.join(" ")}`);
        return {
          undone: entry.summary,
          entryId: entry.id,
          changedAt: entry.time,
          restored,
          ...(results.length > 1 ? { accounts: results } : {}),
          ...(unfinished ? { notRestored: unfinished } : {}),
          ...(errors.length ? { errors, retry: "Run undo_last_change again with this entryId to try the rest." } : {}),
          ...(notes.length ? { notes } : {}),
        };
      }),
  );
}
