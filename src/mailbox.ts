import { Buffer } from "node:buffer";
import { GmailApiError, GmailClient, type BatchResult } from "./gmailClient.js";
import { AuthError } from "./google.js";
import {
  METADATA_HEADERS,
  apiFormat,
  bareAddress,
  bodyText,
  extractContent,
  formatMessage,
  header,
  parseMailboxes,
  recipientsFrom,
  viewUrl,
  type ApiMessage,
  type AttachmentInfo,
  type ExtractedContent,
  type FormatOptions,
  type FormattedMessage,
  type MessageFormat,
} from "./format.js";
import {
  Base64UrlData,
  buildMimeChunks,
  decodeBase64,
  escapeHtml,
  htmlToText,
  isValidAddress,
  MAX_ATTACHMENT_BYTES,
  MimeError,
  type MimeChunk,
  type OutgoingAttachment,
  type OutgoingMessage,
  type Recipient,
} from "./mime.js";

export interface AttachmentInput {
  content: string;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: AttachmentInput[];
}

export type ThreadView = "THREAD_VIEW_MINIMAL" | "THREAD_VIEW_METADATA_ONLY";
export type DraftView = "DRAFT_VIEW_METADATA_ONLY" | "DRAFT_VIEW_FULL";

export const LABEL_COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: "#000000", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: "#434343", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: "#666666", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: "#cccccc", textColor: "#000000" },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: "#ffffff", textColor: "#000000" },
  LABEL_COLOR_PRESET_RED: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: "#ffad47", textColor: "#000000" },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: "#fad165", textColor: "#000000" },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: "#16a765", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: "#43d692", textColor: "#000000" },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: "#f691b2", textColor: "#000000" },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: "#822111", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: "#a46a21", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: "#076239", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: "#1c4587", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: "#41236d", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: "#83334c", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: "#7a4706", textColor: "#ffffff" },
};

const LABEL_LIST_VISIBILITY: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MESSAGE_LIST_VISIBILITY: Record<string, string> = { SHOW: "show", HIDE: "hide" };

export interface LabelInput {
  displayName?: string;
  colorPreset?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
}

interface ApiLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { backgroundColor?: string; textColor?: string };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toAttachments(inputs: AttachmentInput[] | undefined): OutgoingAttachment[] {
  return (inputs ?? []).map((a) => ({
    content: decodeBase64(a.content),
    filename: a.filename,
    mimeType: a.mimeType,
    inline: a.inline,
  }));
}

/**
 * Gmail IDs (messages, threads, drafts, labels, attachments) only use URL-safe characters. Checking
 * them keeps an ID such as "../labels/Label_1" from turning a call into one on another API path.
 */
function checkId(id: string, what: string): string {
  const clean = id.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new MimeError(
      `Invalid ${what} ID ${JSON.stringify(id.slice(0, 100))}: Gmail IDs only contain letters, digits, "-" and "_". Use the ID exactly as a tool returned it.`,
    );
  }
  return clean;
}

type Failed = { id: string; error: GmailApiError };

/**
 * Pairs batch results with their IDs. Items deleted since they were listed (404) are dropped, and
 * items Gmail still didn't return after the retry round (e.g. rate limits) are reported as failed
 * rather than failing the whole call. Only when nothing came back at all is the error thrown.
 */
function settle<T>(ids: string[], results: BatchResult<T>[]): { found: { id: string; value: T }[]; failed: Failed[] } {
  const found: { id: string; value: T }[] = [];
  const failed: Failed[] = [];
  ids.forEach((id, i) => {
    const r = results[i];
    if (r.ok) found.push({ id, value: r.value });
    else if (r.error.status !== 404) failed.push({ id, error: r.error });
  });
  if (failed.length && !found.length) throw failed[0].error;
  return { found, failed };
}

/** The `unavailable` part of a result: what was skipped, and why. */
function unavailable(key: "threadIds" | "draftIds", failed: Failed[]) {
  if (!failed.length) return {};
  return { unavailable: { [key]: failed.map((f) => f.id), error: failed[0].error.message } };
}

/** True when the query asks for drafts (`in:draft`), but not when it excludes them (`-in:draft`). */
function mentionsDrafts(query: string | undefined): boolean {
  return /(?:^|[\s({])(?:in|is):drafts?\b/i.test(query ?? "");
}

/**
 * True when the query asks for Spam or Trash (`in:spam`, `in:trash`, `in:anywhere`), but not when it
 * excludes them (`-in:spam`): Gmail leaves both out unless a search asks for them.
 */
function mentionsSpamTrash(query: string): boolean {
  return /(?:^|[\s({])in:(?:spam|trash|anywhere)\b/i.test(query);
}

/** Joins `References` with the message's own Message-ID, per RFC 5322 threading rules. */
function referencesFor(part: ApiMessage["payload"]): string | undefined {
  const rfcId = header(part, "Message-ID");
  return [header(part, "References"), rfcId].filter(Boolean).join(" ") || undefined;
}

function replySubject(subject: string | undefined): string {
  const s = subject ?? "";
  return /^re:/i.test(s) ? s : `Re: ${s}`.trim();
}

const THREAD_PREVIEW_MESSAGES = 5;
/** How many matching emails a bulk dry run lists. */
const BULK_PREVIEW = 10;
/** Draft bodies in list_drafts are previews; get_draft has the full text. */
const LIST_BODY_CHARS = 2_000;

/** "Re: Fwd: Lunch?" → "lunch?" so replies can be matched to their thread's subject. */
function normalizeSubject(subject: string | undefined): string {
  // Reply/forward prefixes, plus tags mail systems add in front, e.g. "Re: [EXTERNAL]Re: Plans".
  return (subject ?? "").replace(/^\s*(((re|fwd?|aw|sv|antw)\s*(\[\d+\])?\s*:|\[[^\]]{1,20}\])\s*)+/i, "").trim().toLowerCase();
}

export interface BulkSelector {
  query?: string;
  threadIds?: string[];
  messageIds?: string[];
}

/** The emails a bulk change will touch, plus what's left over beyond maxEmails. */
type Selection = {
  ids: string[];
  /** More emails need the change than `max`. */
  more: boolean;
  unavailable?: Record<string, unknown>;
} & (
  | { kind: "query"; /** Changed emails stop matching, so running the change again continues. */ resumable: boolean }
  | { kind: "threads"; remainingThreadIds: string[]; threadOf: Map<string, string> }
  | { kind: "messages"; remainingMessageIds: string[] }
);

/**
 * Says how to continue a bulk change that didn't cover everything: emails beyond maxEmails, and
 * `notDone` emails a failed run didn't get to. ID selections get the IDs to pass next time.
 */
function bulkLeftOver(selection: Selection, max: number, notDone: string[] = []) {
  const limit = `maxEmails can go up to 2,000.`;
  if (selection.kind === "query") {
    if (!selection.more) return {};
    return {
      more: selection.resumable
        ? `More emails match than the limit of ${max}; each run changes the newest ${max}. Run the same change again to continue (emails already changed no longer match). ${limit}`
        : `More emails match than the limit of ${max}; each run changes the newest ${max}. Running it again would pick the same emails, so raise maxEmails or narrow the query. ${limit}`,
    };
  }
  if (selection.kind === "threads") {
    const remainingThreadIds = [...new Set([...notDone.map((id) => selection.threadOf.get(id)!), ...selection.remainingThreadIds])];
    if (!remainingThreadIds.length) return {};
    return {
      ...(selection.more
        ? { more: `These threads hold more than ${max} emails to change; each run changes ${max}. To continue, run it again with threadIds set to remainingThreadIds. ${limit}` }
        : {}),
      remainingThreadIds,
    };
  }
  const remainingMessageIds = [...notDone, ...selection.remainingMessageIds];
  if (!remainingMessageIds.length) return {};
  return {
    ...(selection.more
      ? { more: `Only ${max} of the given emails are changed per run (maxEmails). To continue, run it again with messageIds set to remainingMessageIds. ${limit}` }
      : {}),
    remainingMessageIds,
  };
}

/** Label IDs Gmail defines itself. Bulk actions that only use these don't need the label list. */
const SYSTEM_LABEL_IDS = new Set(["INBOX", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "SENT", "DRAFT", "CHAT"]);

function isSystemLabelId(ref: string): boolean {
  return SYSTEM_LABEL_IDS.has(ref) || /^CATEGORY_[A-Z]+$/.test(ref);
}

/** Gmail search operators for system labels (search doesn't take their IDs). */
const SYSTEM_LABEL_SEARCH: Record<string, string> = {
  INBOX: "in:inbox",
  UNREAD: "is:unread",
  STARRED: "is:starred",
  IMPORTANT: "is:important",
  TRASH: "in:trash",
  SPAM: "in:spam",
  SENT: "in:sent",
  CATEGORY_PERSONAL: "category:primary",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/** A Gmail search term for emails carrying `label`, or undefined if search can't express it. */
function labelSearchTerm(label: ApiLabel): string | undefined {
  if (SYSTEM_LABEL_SEARCH[label.id]) return SYSTEM_LABEL_SEARCH[label.id];
  if (label.type === "system" || isSystemLabelId(label.id) || label.name.includes('"')) return undefined;
  // Search finds a user label by its full name ("Projects/Alpha"); the quotes keep spaces in it.
  return `label:"${label.name}"`;
}

/**
 * Narrows a bulk search to the emails a label change would alter: those missing a label to add or
 * carrying a label to remove. Returns undefined when a label can't be expressed in a search, and
 * the search is then left as it is (it still finds every email that needs the change).
 */
function changeFilter(add: ApiLabel[], remove: ApiLabel[], includeSpamTrash: boolean): { q?: string; labelIds?: string[] } | undefined {
  // Without in:spam/in:trash in the query, Spam and Trash aren't searched, so there's nothing to take
  // them off. (Kept when they're all there is, so the filter still says what the change does.)
  let removing = remove;
  const outside = remove.filter((l) => l.id !== "SPAM" && l.id !== "TRASH");
  if (!includeSpamTrash && (add.length || outside.length)) removing = outside;
  // One user label to remove is matched by its ID, which doesn't depend on how search reads its name.
  if (!add.length && removing.length === 1 && !isSystemLabelId(removing[0].id)) return { labelIds: [removing[0].id] };
  const terms: string[] = [];
  for (const label of add) {
    const term = labelSearchTerm(label);
    if (!term) return undefined;
    terms.push(`-${term}`);
  }
  for (const label of removing) {
    // A user label is only ever searched for as "-label:…": if search read its name differently, that
    // would match everything (still correct), whereas "label:…" would match nothing and change nothing.
    const term = isSystemLabelId(label.id) ? labelSearchTerm(label) : undefined;
    if (!term) return undefined;
    terms.push(term);
  }
  if (!terms.length) return undefined;
  // In parentheses so the OR can't pair up with the user's own search terms.
  return { q: terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})` };
}

// ---------- unsubscribing ----------

/** Headers a sender scan needs (defined here rather than in format.ts, which other tools share). */
const UNSUBSCRIBE_HEADERS = ["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id"];

/** One sender found by scanSenders, with their newest email among those scanned. */
export interface SenderGroup {
  address: string;
  name?: string;
  /** How many of the scanned emails came from this sender. */
  count: number;
  newest: {
    id: string;
    subject: string;
    date?: string;
    time: number;
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
    listId?: string;
  };
}

/** The ways a sender's List-Unsubscribe header (RFC 2369, RFC 8058) offers to unsubscribe. */
export interface UnsubscribeOptions {
  /** An https URL that takes a one-click POST (RFC 8058). */
  oneClick?: string;
  /** An address to email, with the subject and body the sender asks for. */
  mailto?: { to: string; subject: string; body: string };
  /** A web page the user has to open themselves. */
  link?: string;
}

export function unsubscribeOptions(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): UnsubscribeOptions {
  if (!listUnsubscribe) return {};
  // Entries are <uri>, comma separated; a few senders leave out the angle brackets.
  const bracketed = [...listUnsubscribe.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
  const uris = (bracketed.length ? bracketed : listUnsubscribe.split(",")).map((u) => u.trim()).filter(Boolean);
  const out: UnsubscribeOptions = {};
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      continue;
    }
    if (url.protocol === "https:" || url.protocol === "http:") {
      out.link ??= url.href;
      // RFC 8058: one-click needs https and the List-Unsubscribe-Post header.
      if (url.protocol === "https:" && /^\s*List-Unsubscribe=One-Click\s*$/i.test(listUnsubscribePost ?? "")) out.oneClick ??= url.href;
    } else if (url.protocol === "mailto:" && !out.mailto) {
      let to = "";
      try {
        to = decodeURIComponent(url.pathname).split(",")[0].trim();
      } catch {
        continue;
      }
      if (!isValidAddress(to)) continue;
      out.mailto = {
        to,
        subject: url.searchParams.get("subject")?.trim() || "unsubscribe",
        body: url.searchParams.get("body") ?? "unsubscribe",
      };
    }
  }
  return out;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain"];

/**
 * Why a one-click unsubscribe URL must not be contacted, or undefined if it may. Only https to a
 * named public host is allowed: no IP addresses (which also covers every private and link-local
 * range) and no local names. A name that resolves to a private address is checked separately.
 */
export function unsafeUnsubscribeHost(url: URL): string | undefined {
  if (url.protocol !== "https:") return "it isn't an https address";
  // The URL parser already turned forms like 0x7f.1 or 2130706433 into 127.0.0.1.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return `it points to an IP address (${host}), not a website`;
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return `it points to a local network name (${host}), not a website`;
  }
  return undefined;
}

/** True for loopback, private, link-local, shared (CGNAT), multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("::ffff:");
}

export interface MailboxOptions {
  /**
   * Most attachment bytes forward and update_draft will re-attach (below Gmail's 25 MB when the
   * hosted connector's CPU and memory limits are tighter). A message for the user goes with it.
   */
  maxAttachmentBytes?: number;
  maxAttachmentNote?: string;
}

/** Attachments at least this large are fetched on their own, as bytes, instead of in a batch. */
const DIRECT_FETCH_BYTES = 64 * 1024;
/** At most this many are fetched on their own (the largest); the rest share a batch call. */
const MAX_DIRECT_FETCHES = 8;

/**
 * The base64url text of an attachments.get answer, sliced out of the raw JSON without parsing it
 * (base64url has no characters JSON would escape). Falls back to parsing for any other shape.
 */
export function attachmentDataOf(json: Uint8Array): Uint8Array {
  const view = Buffer.from(json.buffer, json.byteOffset, json.byteLength);
  const key = view.indexOf('"data"');
  if (key >= 0) {
    let start = key + 6;
    while (start < json.length && (json[start] === 0x20 || json[start] === 0x3a || json[start] === 0x0a || json[start] === 0x0d || json[start] === 0x09)) start++;
    const end = json[start] === 0x22 ? view.indexOf(0x22, start + 1) : -1;
    if (end > start) return json.subarray(start + 1, end);
  }
  return Buffer.from((JSON.parse(new TextDecoder().decode(json)) as { data?: string }).data ?? "", "latin1");
}

/** All Gmail operations for a single linked account. */
export class Mailbox {
  constructor(
    readonly client: GmailClient,
    private readonly options: MailboxOptions = {},
  ) {}

  get email(): string {
    return this.client.email;
  }

  private loader(messageId: string) {
    return async (attachmentId: string) =>
      (await this.client.request("GET", `messages/${checkId(messageId, "message")}/attachments/${checkId(attachmentId, "attachment")}`))
        .data as string;
  }

  private format(msg: ApiMessage, format: MessageFormat, opts: FormatOptions = {}): Promise<FormattedMessage> {
    return formatMessage(msg, format, this.email, this.loader(msg.id), opts);
  }

  /**
   * Trims a message for search results: no per-message threadId or link (the thread has them), and
   * no recipient list when the email went only to this account.
   */
  private searchSummary(m: FormattedMessage) {
    const { threadId: _t, viewUrl: _v, ...rest } = m;
    const self = this.email.toLowerCase();
    if (rest.toRecipients?.length === 1 && bareAddress(rest.toRecipients[0]) === self && !rest.ccRecipients) {
      delete rest.toRecipients;
    }
    return rest;
  }

  // ---------- threads & messages ----------

  async searchThreads(opts: {
    query?: string;
    pageSize?: number;
    pageToken?: string;
    includeTrash?: boolean;
    view?: ThreadView;
  }) {
    const includeDrafts = mentionsDrafts(opts.query);
    const q = opts.query?.trim()
      ? includeDrafts
        ? opts.query
        : `(${opts.query}) -in:draft`
      : "-in:draft";
    const list = await this.client.request("GET", "threads", {
      query: {
        q,
        maxResults: Math.min(Math.max(opts.pageSize ?? 20, 1), 50),
        pageToken: opts.pageToken,
        includeSpamTrash: opts.includeTrash || undefined,
      },
    });
    const format: MessageFormat = opts.view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const ids = (list.threads ?? []) as { id: string }[];
    const fetched = await this.client.batchGet<{ messages?: ApiMessage[] }>(
      ids.map((t) => ({ path: `threads/${t.id}`, query: { format: "metadata", metadataHeaders: METADATA_HEADERS } })),
    );
    const { found, failed } = settle(ids.map((t) => t.id), fetched);
    const threads = await mapLimit(found, 8, async ({ id, value: thread }) => {
      let messages = (thread.messages ?? []) as ApiMessage[];
      if (!includeDrafts) messages = messages.filter((m) => !m.labelIds?.includes("DRAFT"));
      const recent = messages.slice(-THREAD_PREVIEW_MESSAGES);
      const summaries = (await Promise.all(recent.map((m) => this.format(m, format)))).map((m) => this.searchSummary(m));
      const link = viewUrl(this.email, `all/${id}`);
      // Most threads hold one email: show it flat instead of a thread wrapping a one-item list.
      if (summaries.length === 1) {
        const { id: messageId, ...message } = summaries[0];
        return { id, ...(messageId !== id ? { messageId } : {}), totalMessages: 1, ...message, viewUrl: link };
      }
      // Replies repeat the subject with "Re:"; list it once for the thread.
      const subject = summaries[0]?.subject;
      const base = normalizeSubject(subject);
      return {
        id,
        ...(subject !== undefined ? { subject } : {}),
        totalMessages: messages.length,
        ...(messages.length > recent.length ? { omittedOlderMessages: messages.length - recent.length } : {}),
        viewUrl: link,
        messages: summaries.map(({ subject: s, ...m }) => (s !== undefined && normalizeSubject(s) !== base ? { subject: s, ...m } : m)),
      };
    });
    return {
      threads,
      ...unavailable("threadIds", failed),
      ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
    };
  }

  async getThread(threadId: string, format: MessageFormat, opts: FormatOptions = {}) {
    if (format === "RAW") throw new MimeError("RAW format is not supported for threads; use get_message instead.");
    const thread = await this.client.request("GET", `threads/${checkId(threadId, "thread")}`, {
      query: { format: apiFormat(format), metadataHeaders: format === "MINIMAL" || format === "METADATA_ONLY" ? METADATA_HEADERS : undefined },
    });
    const messages = ((thread.messages ?? []) as ApiMessage[]).filter((m) => !m.labelIds?.includes("DRAFT"));
    // The first message keeps any quote: what it quotes isn't in this thread.
    const formatted = await Promise.all(messages.map((m, i) => this.format(m, format, i === 0 ? { ...opts, hideQuotedHistory: false } : opts)));
    const base = {
      id: thread.id as string,
      viewUrl: viewUrl(this.email, `all/${thread.id}`),
    };
    if (format !== "PLAIN_TEXT" && format !== "FULL_CONTENT") return { ...base, messages: formatted };
    // With bodies, each message's snippet only repeats its body, and its threadId is the thread's id.
    // The subject is given once for the thread, and on a message only when it changes.
    const subject = formatted[0]?.subject;
    const topic = normalizeSubject(subject);
    return {
      id: base.id,
      ...(subject !== undefined ? { subject } : {}),
      viewUrl: base.viewUrl,
      messages: formatted.map(({ snippet: _s, threadId: _t, subject: s, ...m }) =>
        s !== undefined && normalizeSubject(s) !== topic ? { subject: s, ...m } : m,
      ),
    };
  }

  async getRawMessage(messageId: string, format: "full" | "metadata" = "full"): Promise<ApiMessage> {
    return this.client.request("GET", `messages/${checkId(messageId, "message")}`, {
      query: { format, metadataHeaders: format === "metadata" ? METADATA_HEADERS : undefined },
    });
  }

  async getMessage(messageId: string, format: MessageFormat, opts: FormatOptions = {}) {
    const msg: ApiMessage = await this.client.request("GET", `messages/${checkId(messageId, "message")}`, {
      query: { format: apiFormat(format), metadataHeaders: apiFormat(format) === "metadata" ? METADATA_HEADERS : undefined },
    });
    return this.format(msg, format, opts);
  }

  /**
   * Downloads every attachment of a message so it can be re-attached (forwarding, draft edits),
   * keeping each as Gmail's base64url text so it is never decoded and encoded again. Attachments
   * over the limit are refused from their listed sizes before downloading anything. Large ones are
   * fetched on their own as bytes (no batch text to split, no JSON to parse); small ones share a batch.
   */
  private async downloadAttachments(
    msg: ApiMessage,
    content: ExtractedContent,
    tooBig: (size: string, limit: string, note?: string) => string,
  ): Promise<OutgoingAttachment[]> {
    const total = content.attachments.reduce((sum, a) => sum + a.size, 0);
    const size = `${(total / 1048576).toFixed(1)} MB`;
    if (total > MAX_ATTACHMENT_BYTES) throw new MimeError(tooBig(size, "25 MB Gmail allows in one email"));
    const limit = this.options.maxAttachmentBytes;
    if (limit !== undefined && total > limit) {
      const limitMb = Math.round((limit / 1048576) * 10) / 10;
      throw new MimeError(tooBig(size, `${limitMb} MB this connector re-attaches`, this.options.maxAttachmentNote));
    }
    const withIds = content.attachments.filter((a) => a.id);
    const direct = new Set(
      [...withIds]
        .filter((a) => a.size >= DIRECT_FETCH_BYTES)
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_DIRECT_FETCHES),
    );
    const batched = withIds.filter((a) => !direct.has(a));
    const dataById = new Map<string, Uint8Array>();
    const [fetched] = await Promise.all([
      this.client.batchGet<{ data: string }>(batched.map((a) => ({ path: `messages/${msg.id}/attachments/${a.id}` }))),
      mapLimit([...direct], 4, async (a) => {
        dataById.set(a.id!, attachmentDataOf(await this.client.getBytes(`messages/${msg.id}/attachments/${a.id}`)));
      }),
    ]);
    batched.forEach((a, i) => {
      const r = fetched[i];
      if (!r.ok) throw r.error;
      dataById.set(a.id!, Buffer.from(r.value.data, "latin1"));
    });
    return content.attachments.map((a) => {
      const data = a.id ? dataById.get(a.id)! : Buffer.from(findPart(msg, a.partId)?.body?.data ?? "", "latin1");
      return {
        content: new Base64UrlData(data),
        filename: a.filename,
        mimeType: a.mimeType,
        inline: a.inline && Boolean(a.contentId),
        contentId: a.contentId,
      };
    });
  }

  // ---------- sending ----------

  /**
   * Uploads a message. The request body is assembled first, so the chunks it came from (and any
   * attachment text they point to) can be freed while it is being sent.
   */
  private async upload(method: string, path: string, metadata: unknown, mime: MimeChunk[]) {
    const upload = GmailClient.uploadBody(metadata, mime);
    mime.length = 0;
    return this.client.request(method, path, { upload });
  }

  /** Threading headers and default recipients for replying to `messageId`. */
  async replyContext(messageId: string, replyAll = false) {
    const original = await this.getRawMessage(messageId, "full");
    const p = original.payload;
    const self = this.email.toLowerCase();
    const from = header(p, "From") ?? "";
    const toHeader = header(p, "To");
    const ccHeader = header(p, "Cc");
    // Derived recipients skip anything that isn't a real address (e.g. "undisclosed-recipients:;").
    const sentBySelf = bareAddress(from) === self;
    const to = sentBySelf ? recipientsFrom(toHeader) : recipientsFrom(header(p, "Reply-To") || from);
    const toAddresses = to.map((m) => m.address);
    const cc = replyAll
      ? recipientsFrom(sentBySelf ? ccHeader : [toHeader, ccHeader].filter(Boolean).join(", "), [self, ...toAddresses])
      : [];
    const content = await extractContent(p, this.loader(original.id));
    return {
      original,
      threadId: original.threadId,
      inReplyTo: header(p, "Message-ID"),
      references: referencesFor(p),
      subject: replySubject(header(p, "Subject")),
      to,
      cc,
      quote: {
        attribution: `On ${header(p, "Date") ?? "an earlier date"}, ${from} wrote:`,
        text: bodyText(content),
        html: content.html,
      },
    };
  }

  private withQuote(
    input: ComposeInput,
    quote: { attribution: string; text: string; html?: string },
  ): { text?: string; html?: string } {
    const quotedText = `${quote.attribution}\n${quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n")}`;
    const text = `${input.body ?? (input.htmlBody ? htmlToText(input.htmlBody) : "")}\n\n${quotedText}`;
    if (!input.htmlBody) return { text };
    const quotedHtml = quote.html ?? escapeHtml(quote.text).replace(/\n/g, "<br>");
    const html =
      `${input.htmlBody}<br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(quote.attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${quotedHtml}</blockquote></div>`;
    return { text, html };
  }

  async sendMessage(input: ComposeInput & { draftId?: string; replyThreadId?: string; replyToMessageId?: string }) {
    if (input.draftId) {
      const id = checkId(input.draftId, "draft");
      const sent = await this.sendMail(() => this.client.request("POST", "drafts/send", { json: { id } }));
      return this.sentResult(sent);
    }
    const to = input.to ?? [];
    if (!to.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc (or a draftId).");
    }
    const msg: OutgoingMessage = {
      to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.body,
      html: input.htmlBody,
      attachments: toAttachments(input.attachments),
    };
    let threadId = input.replyThreadId;
    if (input.replyToMessageId) {
      const ctx = await this.replyContext(input.replyToMessageId);
      msg.inReplyTo = ctx.inReplyTo;
      msg.references = ctx.references;
      msg.subject ||= ctx.subject;
      threadId = ctx.threadId;
    } else if (input.replyThreadId) {
      // Gmail only threads a message that also carries In-Reply-To/References and a matching
      // subject, so take them from the thread's latest message.
      const thread = await this.client.request("GET", `threads/${checkId(input.replyThreadId, "thread")}`, {
        query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
      });
      const last = ((thread.messages ?? []) as ApiMessage[]).filter((m) => !m.labelIds?.includes("DRAFT")).at(-1);
      if (last) {
        msg.inReplyTo = header(last.payload, "Message-ID");
        msg.references = referencesFor(last.payload);
        msg.subject ||= replySubject(header(last.payload, "Subject"));
      }
    }
    const upload = GmailClient.uploadBody(threadId ? { threadId } : {}, buildMimeChunks(msg));
    const sent = await this.sendMail(() => this.client.request("POST", "messages/send", { upload }));
    return this.sentResult(sent);
  }

  async reply(input: ComposeInput & { messageId: string; replyAll?: boolean }) {
    if (!input.body && !input.htmlBody) throw new MimeError("Provide body or htmlBody for the reply.");
    const ctx = await this.replyContext(input.messageId, input.replyAll);
    const { text, html } = this.withQuote(input, ctx.quote);
    const mime = buildMimeChunks({
      to: input.to?.length ? input.to : ctx.to,
      cc: input.cc?.length ? input.cc : ctx.cc,
      bcc: input.bcc,
      subject: ctx.subject,
      text,
      html,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
    });
    const upload = GmailClient.uploadBody({ threadId: ctx.threadId }, mime);
    const sent = await this.sendMail(() => this.client.request("POST", "messages/send", { upload }));
    return this.sentResult(sent);
  }

  async forward(input: {
    messageId: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    forwardText?: string;
    htmlBody?: string;
  }) {
    if (!input.to?.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc.");
    }
    const original = await this.getRawMessage(input.messageId, "full");
    const p = original.payload;
    const content = await extractContent(p, this.loader(original.id));
    const origText = bodyText(content);
    const meta: [string, string | undefined][] = [
      ["From", header(p, "From")],
      ["Date", header(p, "Date")],
      ["Subject", header(p, "Subject")],
      ["To", header(p, "To")],
      ["Cc", header(p, "Cc")],
    ];
    const present = meta.filter((m): m is [string, string] => Boolean(m[1]));
    const intro = input.forwardText ?? (input.htmlBody ? htmlToText(input.htmlBody) : "");
    const text =
      `${intro}\n\n---------- Forwarded message ---------\n` +
      present.map(([k, v]) => `${k}: ${v}`).join("\n") +
      `\n\n${origText}`;
    const introHtml = input.htmlBody ?? escapeHtml(input.forwardText ?? "").replace(/\n/g, "<br>");
    const html =
      `${introHtml}<br><br><div class="gmail_quote">---------- Forwarded message ---------<br>` +
      present.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`).join("") +
      `<br>${content.html ?? escapeHtml(origText).replace(/\n/g, "<br>")}</div>`;
    const subject = header(p, "Subject") ?? "";
    const mime = buildMimeChunks({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`.trim(),
      text,
      html,
      inReplyTo: header(p, "Message-ID"),
      references: referencesFor(p),
      attachments: await this.downloadAttachments(
        original,
        content,
        (size, limit, note) =>
          `This email's attachments add up to ${size}, more than the ${limit}, so it can't be forwarded with them from here. ` +
          `Forward it in Gmail instead (${viewUrl(this.email, `all/${original.id}`)}), which sends large files as Google Drive links.` +
          (note ? ` ${note}` : ""),
      ),
    });
    // Only the assembled bytes stay alive while sending: the attachment text they were built from can go.
    const upload = GmailClient.uploadBody({ threadId: original.threadId }, mime);
    mime.length = 0;
    const sent = await this.sendMail(() => this.client.request("POST", "messages/send", { upload }));
    return this.sentResult(sent);
  }

  /**
   * Runs a send (messages/send or drafts/send). Those aren't retried after a server or network error,
   * because the email may have gone out anyway; the error then says so, so it isn't sent twice.
   */
  private async sendMail<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      // Rate limits (429), bad requests and sign-in problems are refused before anything is sent.
      const unsure = err instanceof GmailApiError ? err.status >= 500 : !(err instanceof AuthError || err instanceof MimeError);
      if (!unsure) throw err;
      const message =
        `${(err as Error).message.replace(/\.?$/, ".")} The email may have been sent anyway: check the Sent folder ` +
        `(search_threads with "in:sent newer_than:1d") before trying again, so it isn't sent twice.`;
      throw err instanceof GmailApiError ? new GmailApiError(err.status, message) : new Error(message);
    }
  }

  private sentResult(sent: { id: string; threadId: string; labelIds?: string[] }) {
    return {
      id: sent.id,
      threadId: sent.threadId,
      labelIds: sent.labelIds ?? [],
      viewUrl: viewUrl(this.email, `all/${sent.id}`),
    };
  }

  // ---------- drafts ----------

  private draftUrl(messageId: string): string {
    return viewUrl(this.email, `drafts?compose=${messageId}`);
  }

  private draftResult(draft: { id: string; message: { id: string; threadId: string } }) {
    return {
      id: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId,
      viewUrl: this.draftUrl(draft.message.id),
    };
  }

  private async formatDraft(draft: { id: string; message: ApiMessage }, format: MessageFormat, opts: FormatOptions = {}) {
    const { id: messageId, viewUrl: _v, ...rest } = await this.format(draft.message, format, opts);
    return { id: draft.id, messageId, ...rest, viewUrl: this.draftUrl(messageId) };
  }

  async listDrafts(opts: { query?: string; pageSize?: number; pageToken?: string; view?: DraftView }) {
    const list = await this.client.request("GET", "drafts", {
      query: { q: opts.query, maxResults: Math.min(Math.max(opts.pageSize ?? 20, 1), 50), pageToken: opts.pageToken },
    });
    const full = opts.view === "DRAFT_VIEW_FULL";
    const ids = (list.drafts ?? []) as { id: string }[];
    const fetched = await this.client.batchGet<{ id: string; message: ApiMessage }>(
      ids.map((d) => ({ path: `drafts/${d.id}`, query: { format: full ? "full" : "metadata" } })),
    );
    // Drafts deleted or sent since they were listed are dropped.
    const { found, failed } = settle(ids.map((d) => d.id), fetched);
    const drafts = await mapLimit(found, 8, async ({ value: draft }) => {
      // A list shows a preview of each draft; get_draft returns the whole thing.
      const formatted = await this.formatDraft(draft, full ? "PLAIN_TEXT" : "METADATA_ONLY", { maxBodyChars: LIST_BODY_CHARS });
      if (full) {
        const { htmlBody: _h, snippet: _s, attachments: _a, labelIds: _l, ...rest } = formatted as FormattedMessage;
        return rest;
      }
      const { labelIds: _l, ...rest } = formatted as FormattedMessage;
      return rest;
    });
    return {
      drafts,
      ...unavailable("draftIds", failed),
      ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
    };
  }

  async getDraft(draftId: string, format: MessageFormat, opts: FormatOptions = {}) {
    // drafts.get has no metadataHeaders parameter; metadata format returns every header.
    const draft = await this.client.request("GET", `drafts/${checkId(draftId, "draft")}`, { query: { format: apiFormat(format) } });
    return this.formatDraft(draft, format, opts);
  }

  async createDraft(input: ComposeInput & { replyToMessageId?: string }) {
    const msg: OutgoingMessage = {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.body,
      html: input.htmlBody,
      attachments: toAttachments(input.attachments),
    };
    let threadId: string | undefined;
    if (input.replyToMessageId) {
      const ctx = await this.replyContext(input.replyToMessageId);
      Object.assign(msg, this.withQuote(input, ctx.quote));
      msg.inReplyTo = ctx.inReplyTo;
      msg.references = ctx.references;
      msg.subject = input.subject || ctx.subject;
      if (!input.to?.length) msg.to = ctx.to;
      threadId = ctx.threadId;
    }
    const draft = await this.upload("POST", "drafts", { message: threadId ? { threadId } : {} }, buildMimeChunks(msg));
    return this.draftResult(draft);
  }

  /**
   * Merge-updates a draft: non-empty fields replace the draft's values, omitted ones are kept.
   * Existing attachments are kept unless `attachments` is given (pass [] to remove them all).
   */
  async updateDraft(input: ComposeInput & { draftId: string }) {
    const draftId = checkId(input.draftId, "draft");
    const existing = await this.client.request("GET", `drafts/${draftId}`, { query: { format: "full" } });
    const msg = existing.message as ApiMessage;
    const p = msg.payload;
    const content = await extractContent(p, this.loader(msg.id));
    // Keep the draft's recipients (with their display names) unless new ones are given.
    const pick = (value: string[] | undefined, headerName: string): Recipient[] =>
      value?.length ? value : recipientsFrom(header(p, headerName));
    const bodyChanged = Boolean(input.body || input.htmlBody);
    const inReplyTo = header(p, "In-Reply-To");
    // Keep a chosen send-as address; without From, Gmail would send from the primary address.
    const from = parseMailboxes(header(p, "From")).find((m) => isValidAddress(m.address));
    const mime = buildMimeChunks({
      from,
      to: pick(input.to, "To"),
      cc: pick(input.cc, "Cc"),
      bcc: pick(input.bcc, "Bcc"),
      subject: input.subject || header(p, "Subject") || "",
      text: bodyChanged ? input.body : content.text,
      html: bodyChanged ? input.htmlBody : content.html,
      inReplyTo,
      references: header(p, "References"),
      attachments: input.attachments
        ? toAttachments(input.attachments)
        : await this.downloadAttachments(
            msg,
            content,
            (size, limit, note) =>
              `This draft's attachments add up to ${size}, more than the ${limit}. Pass \`attachments\` to replace them, or edit the draft in Gmail.` +
              (note ? ` ${note}` : ""),
          ),
    });
    const draft = await this.upload("PUT", `drafts/${draftId}`, { id: draftId, message: { threadId: msg.threadId } }, mime);
    return this.draftResult(draft);
  }

  async deleteDraft(draftId: string) {
    await this.client.request("DELETE", `drafts/${checkId(draftId, "draft")}`);
    return { deleted: draftId };
  }

  // ---------- labels ----------

  async listLabels() {
    const res = await this.client.request("GET", "labels");
    const labels = ((res.labels ?? []) as ApiLabel[])
      .map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        ...(l.color ? { color: l.color } : {}),
        ...(l.labelListVisibility ? { labelListVisibility: l.labelListVisibility } : {}),
        ...(l.messageListVisibility ? { messageListVisibility: l.messageListVisibility } : {}),
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
    return { labels };
  }

  private labelBody(input: LabelInput) {
    return {
      ...(input.displayName ? { name: input.displayName } : {}),
      ...(input.colorPreset && LABEL_COLOR_PRESETS[input.colorPreset] ? { color: LABEL_COLOR_PRESETS[input.colorPreset] } : {}),
      ...(input.labelListVisibility && LABEL_LIST_VISIBILITY[input.labelListVisibility]
        ? { labelListVisibility: LABEL_LIST_VISIBILITY[input.labelListVisibility] }
        : {}),
      ...(input.messageListVisibility && MESSAGE_LIST_VISIBILITY[input.messageListVisibility]
        ? { messageListVisibility: MESSAGE_LIST_VISIBILITY[input.messageListVisibility] }
        : {}),
    };
  }

  async createLabel(input: LabelInput & { displayName: string; autoCreateParentLabels?: boolean }) {
    let name = input.displayName.split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (!name) throw new MimeError("displayName must not be empty.");
    const created: string[] = [];
    if (input.autoCreateParentLabels !== false && name.includes("/")) {
      const labels = ((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[];
      const existing = new Map(labels.map((l) => [l.name.toLowerCase(), l.name]));
      const segments = name.split("/");
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        const actual = existing.get(parent.toLowerCase());
        if (actual) {
          // Gmail nests by exact name, so reuse the existing label's capitalization.
          segments.splice(0, i, ...actual.split("/"));
          continue;
        }
        await this.client.request("POST", "labels", { json: { name: parent } });
        existing.set(parent.toLowerCase(), parent);
        created.push(parent);
      }
      name = segments.join("/");
    }
    const label: ApiLabel = await this.client.request("POST", "labels", {
      json: { labelListVisibility: "labelShow", messageListVisibility: "show", ...this.labelBody(input), name },
    });
    return { ...label, ...(created.length ? { createdParentLabels: created } : {}) };
  }

  async updateLabel(labelRef: string, input: LabelInput) {
    const [labelId] = await this.resolveLabelIds([labelRef]);
    return this.client.request("PATCH", `labels/${labelId}`, { json: this.labelBody(input) });
  }

  async deleteLabel(labelRef: string) {
    const [labelId] = await this.resolveLabelIds([labelRef]);
    await this.client.request("DELETE", `labels/${labelId}`);
    return { deleted: labelId };
  }

  /** Accepts label IDs or display names (case-insensitive) and returns IDs for this account. */
  async resolveLabelIds(refs: string[] | undefined, known?: ApiLabel[]): Promise<string[]> {
    return (await this.resolveLabels(refs, known)).map((l) => l.id);
  }

  /** Like resolveLabelIds, returning the labels themselves. */
  async resolveLabels(refs: string[] | undefined, known?: ApiLabel[]): Promise<ApiLabel[]> {
    if (!refs?.length) return [];
    const labels = known ?? (((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[]);
    return refs.map((ref) => {
      const byId = labels.find((l) => l.id === ref);
      if (byId) return byId;
      const byName = labels.find((l) => l.name.toLowerCase() === ref.trim().toLowerCase());
      if (byName) return byName;
      throw new MimeError(`Label "${ref}" not found in ${this.email}. Use list_labels to see this account's labels.`);
    });
  }

  async modify(kind: "messages" | "threads", id: string, add: string[] | undefined, remove: string[] | undefined) {
    const labels = add?.length || remove?.length
      ? (((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[])
      : [];
    const addLabelIds = await this.resolveLabelIds(add, labels);
    const removeLabelIds = await this.resolveLabelIds(remove, labels);
    if (!addLabelIds.length && !removeLabelIds.length) throw new MimeError("Provide at least one label to add or remove.");
    return this.modifyIds(kind, id, addLabelIds, removeLabelIds);
  }

  async modifyIds(kind: "messages" | "threads", id: string, addLabelIds: string[], removeLabelIds: string[]) {
    const what = kind === "messages" ? "message" : "thread";
    const res = await this.client.request("POST", `${kind}/${checkId(id, what)}/modify`, { json: { addLabelIds, removeLabelIds } });
    return this.modifyResult(kind, res);
  }

  // ---------- attachments ----------

  /**
   * Downloads one attachment. Identify it by `partId` (stable), `filename`, or `attachmentId`;
   * with none of these, a message's only attachment is used.
   */
  async getAttachment(messageId: string, ref: { partId?: string; filename?: string; attachmentId?: string }) {
    const msg = await this.getRawMessage(messageId, "full");
    const { attachments } = await extractContent(msg.payload, this.loader(msg.id));
    const byName = ref.filename?.trim().toLowerCase();
    const attachment =
      (ref.partId !== undefined && attachments.find((a) => a.partId === ref.partId)) ||
      (byName && attachments.find((a) => a.filename.toLowerCase() === byName)) ||
      (ref.attachmentId && attachments.find((a) => a.id === ref.attachmentId)) ||
      (!ref.partId && !byName && !ref.attachmentId && attachments.length === 1 ? attachments[0] : undefined);
    // Gmail issues new attachment IDs on every read, but old ones keep working, so a stale ID is still
    // usable. Its name and type are recovered from the attachment of the same size (or the only one),
    // since the file's type decides how it can be read.
    if (!attachment && ref.attachmentId) {
      const bytes = Buffer.from((await this.loader(msg.id)(ref.attachmentId)) as string, "base64url");
      const sameSize = attachments.filter((a) => a.size === bytes.length);
      const match = sameSize.length === 1 ? sameSize[0] : attachments.length === 1 ? attachments[0] : undefined;
      const fallback: AttachmentInfo = { id: ref.attachmentId, filename: "attachment", mimeType: "application/octet-stream", size: bytes.length, inline: false };
      return {
        info: match ?? fallback,
        bytes,
        message: msg,
      };
    }
    if (!attachment) {
      const list = attachments.map((a) => `${a.filename} (partId ${a.partId})`).join(", ") || "none";
      throw new MimeError(`No matching attachment on message ${messageId}. Its attachments: ${list}.`);
    }
    const data = attachment.id
      ? await this.loader(msg.id)(attachment.id)
      : (findPart(msg, attachment.partId)?.body?.data ?? "");
    return { info: attachment, bytes: Buffer.from(data, "base64url"), message: msg };
  }

  // ---------- unsubscribing ----------

  /**
   * Finds who sent the newest emails matching a search (or the given emails): one entry per sender
   * address, with that sender's newest email and how many of the scanned emails came from them.
   * Drafts and emails this account sent itself are skipped. At most `limit` emails are scanned.
   */
  async scanSenders(sel: { query?: string; messageIds?: string[] }, limit: number) {
    let ids: string[];
    if (sel.query !== undefined) {
      const page = await this.client.request("GET", "messages", {
        query: {
          q: sel.query.trim() ? `(${sel.query}) -in:draft` : "-in:draft",
          maxResults: limit,
          includeSpamTrash: mentionsSpamTrash(sel.query) || undefined,
        },
      });
      ids = ((page.messages ?? []) as { id: string }[]).map((m) => m.id);
    } else {
      ids = [...new Set((sel.messageIds ?? []).map((id) => checkId(id, "message")))].slice(0, limit);
    }
    const fetched = await this.client.batchGet<ApiMessage>(
      ids.map((id) => ({ path: `messages/${id}`, query: { format: "metadata", metadataHeaders: UNSUBSCRIBE_HEADERS } })),
    );
    const { found, failed } = settle(ids, fetched);
    const self = this.email.toLowerCase();
    const senders = new Map<string, SenderGroup>();
    let scanned = 0;
    for (const { value: msg } of found) {
      if (msg.labelIds?.includes("DRAFT")) continue;
      const from = parseMailboxes(header(msg.payload, "From"))[0];
      const address = from?.address.toLowerCase();
      if (!address || address === self) continue;
      scanned++;
      const time = Number(msg.internalDate ?? 0);
      const group = senders.get(address) ?? { address, count: 0, newest: { id: "", subject: "", time: -1 } };
      group.count++;
      if (time > group.newest.time) {
        group.name = from.name;
        group.newest = {
          id: msg.id,
          subject: (header(msg.payload, "Subject") ?? "").trim(),
          date: msg.internalDate ? new Date(time).toISOString() : header(msg.payload, "Date"),
          time,
          listUnsubscribe: header(msg.payload, "List-Unsubscribe"),
          listUnsubscribePost: header(msg.payload, "List-Unsubscribe-Post"),
          listId: header(msg.payload, "List-Id"),
        };
      }
      senders.set(address, group);
    }
    return { senders: [...senders.values()], scanned, ...(failed.length ? { unavailable: failed.map((f) => f.id) } : {}) };
  }

  /** Sends the unsubscribe email a sender's List-Unsubscribe header asks for (mailto:). */
  async sendUnsubscribeEmail(mail: { to: string; subject: string; body: string }) {
    const upload = GmailClient.uploadBody({}, buildMimeChunks({ to: [mail.to], subject: mail.subject, text: mail.body }));
    return this.sentResult(await this.sendMail(() => this.client.request("POST", "messages/send", { upload })));
  }

  // ---------- bulk changes ----------

  /**
   * Finds the emails a bulk change applies to: those matching a Gmail search, the emails of the
   * given threads, or the given emails. Drafts are never included, and at most `max` are returned.
   * Searches and threads only yield emails the change would alter (see changeFilter), so counts are
   * real and, for a search, running the change again continues where the last run stopped.
   */
  async selectMessages(sel: BulkSelector, change: { add: ApiLabel[]; remove: ApiLabel[] }, max: number): Promise<Selection> {
    if (sel.query !== undefined) {
      const includeSpamTrash = mentionsSpamTrash(sel.query);
      const filter = changeFilter(change.add, change.remove, includeSpamTrash);
      const q = [sel.query.trim() ? `(${sel.query})` : "", filter?.q, "-in:draft"].filter(Boolean).join(" ");
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await this.client.request("GET", "messages", {
          query: {
            q,
            labelIds: filter?.labelIds,
            maxResults: Math.min(500, max - ids.length),
            pageToken,
            includeSpamTrash: includeSpamTrash || undefined,
          },
        });
        ids.push(...((page.messages ?? []) as { id: string }[]).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      // A next page means more match; no need to fetch it just to be sure.
      return { kind: "query", ids, more: Boolean(pageToken), resumable: filter !== undefined };
    }
    if (sel.threadIds?.length) {
      const threadIds = [...new Set(sel.threadIds.map((id) => checkId(id, "thread")))];
      const fetched = await this.client.batchGet<{ messages?: ApiMessage[] }>(
        threadIds.map((id) => ({ path: `threads/${id}`, query: { format: "minimal" } })),
      );
      const { found, failed } = settle(threadIds, fetched);
      const add = change.add.map((l) => l.id);
      const remove = change.remove.map((l) => l.id);
      const needsChange = (m: ApiMessage) => {
        const has = new Set(m.labelIds ?? []);
        return !has.has("DRAFT") && (add.some((id) => !has.has(id)) || remove.some((id) => has.has(id)));
      };
      const ids: string[] = [];
      const threadOf = new Map<string, string>();
      const remainingThreadIds: string[] = [];
      for (const { id: threadId, value } of found) {
        const pending = (value.messages ?? []).filter(needsChange).map((m) => m.id);
        const room = max - ids.length;
        for (const id of pending.slice(0, room)) {
          ids.push(id);
          threadOf.set(id, threadId);
        }
        if (pending.length > room) remainingThreadIds.push(threadId);
      }
      return { kind: "threads", ids, more: remainingThreadIds.length > 0, remainingThreadIds, threadOf, ...unavailable("threadIds", failed) };
    }
    const ids = [...new Set((sel.messageIds ?? []).map((id) => checkId(id, "message")))];
    return { kind: "messages", ids: ids.slice(0, max), more: ids.length > max, remainingMessageIds: ids.slice(max) };
  }

  /** Adds and removes labels on many messages using Gmail's batchModify (1,000 messages per call). */
  async bulkModify(sel: BulkSelector, change: { add: string[]; remove: string[] }, opts: { max: number; dryRun: boolean }) {
    // Check IDs before any call, so a bad one doesn't leave the change half done.
    sel.threadIds?.forEach((id) => checkId(id, "thread"));
    sel.messageIds?.forEach((id) => checkId(id, "message"));
    // System labels (INBOX, UNREAD, …) need no lookup; only names and user labels do.
    const refs = [...change.add, ...change.remove];
    const labels = refs.every(isSystemLabelId)
      ? refs.map((id): ApiLabel => ({ id, name: id, type: "system" }))
      : (((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[]);
    const add = await this.resolveLabels(change.add, labels);
    const remove = await this.resolveLabels(change.remove, labels);
    const selection = await this.selectMessages(sel, { add, remove }, opts.max);
    const { ids } = selection;
    const extra = { ...bulkLeftOver(selection, opts.max), ...(selection.unavailable ? { unavailable: selection.unavailable } : {}) };
    if (opts.dryRun) {
      const sample = ids.slice(0, BULK_PREVIEW);
      const fetched = await this.client.batchGet<ApiMessage>(
        sample.map((id) => ({ path: `messages/${id}`, query: { format: "metadata", metadataHeaders: ["Subject", "From", "Date"] } })),
      );
      const preview = fetched.flatMap((r) =>
        r.ok
          ? [
              {
                subject: (header(r.value.payload, "Subject") ?? "").trim(),
                sender: header(r.value.payload, "From"),
                date: r.value.internalDate ? new Date(Number(r.value.internalDate)).toISOString() : undefined,
              },
            ]
          : [],
      );
      return { dryRun: true, wouldChange: ids.length, ...extra, preview };
    }
    const addLabelIds = add.map((l) => l.id);
    const removeLabelIds = remove.map((l) => l.id);
    let changed = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      try {
        await this.client.request("POST", "messages/batchModify", { json: { ids: chunk, addLabelIds, removeLabelIds } });
      } catch (err) {
        if (!changed) throw err;
        // Part of the change went through: say exactly how much, and how to finish.
        const left = ids.slice(i);
        const finish =
          selection.kind === "query"
            ? "Run the same change again to finish."
            : `Run it again with ${selection.kind === "threads" ? "threadIds set to remainingThreadIds" : "messageIds set to remainingMessageIds"} to finish.`;
        return {
          changed,
          notChanged: left.length,
          error: `Stopped after changing ${changed} of ${ids.length} emails: ${(err as Error).message} ${finish}`,
          ...extra,
          ...bulkLeftOver(selection, opts.max, left),
        };
      }
      changed += chunk.length;
    }
    return { changed, ...extra };
  }

  async trash(kind: "messages" | "threads", id: string, untrash = false) {
    const what = kind === "messages" ? "message" : "thread";
    const res = await this.client.request("POST", `${kind}/${checkId(id, what)}/${untrash ? "untrash" : "trash"}`);
    return this.modifyResult(kind, res);
  }

  private modifyResult(kind: "messages" | "threads", res: any) {
    if (kind === "messages") return { id: res.id, threadId: res.threadId, labelIds: res.labelIds ?? [] };
    return {
      id: res.id,
      messages: ((res.messages ?? []) as ApiMessage[]).map((m) => ({ id: m.id, labelIds: m.labelIds ?? [] })),
    };
  }
}

function findPart(msg: ApiMessage, partId: string | undefined) {
  if (partId === undefined) return undefined;
  const stack = msg.payload ? [msg.payload] : [];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.partId === partId) return part;
    stack.push(...(part.parts ?? []));
  }
  return undefined;
}
