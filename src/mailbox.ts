import { Buffer } from "node:buffer";
import { canonicalAddress, sameMailbox } from "./accounts.js";
import { GmailApiError, GmailClient, type BatchResult } from "./gmailClient.js";
import { AuthError } from "./google.js";
import {
  METADATA_HEADERS,
  apiFormat,
  bareAddress,
  bodyNotes,
  bodyText,
  compactMessage,
  extractContent,
  formatMessage,
  formatThread,
  header,
  isoTime,
  labelFlags,
  limitLength,
  parseMailboxes,
  preview,
  recipientsFrom,
  stripInvisible,
  userLabelIds,
  viewUrl,
  type ApiMessage,
  type ApiMessagePart,
  type AttachmentInfo,
  type ExtractedContent,
  type FormatOptions,
  type FormattedMessage,
  type MessageFormat,
} from "./format.js";
import {
  attachmentSize,
  Base64UrlData,
  buildMimeChunks,
  decodeBase64,
  escapeHtml,
  htmlToText,
  isValidAddress,
  latin1,
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
  /** Append the account's Gmail signature (see Mailbox.signature). */
  includeSignature?: boolean;
}

export type ThreadView = "THREAD_VIEW_MINIMAL" | "THREAD_VIEW_METADATA_ONLY";

export interface SearchOptions {
  query?: string;
  pageSize?: number;
  pageToken?: string;
  includeTrash?: boolean;
  view?: ThreadView;
  /** Leave out this many threads at the start of the page (ones a merged timeline already showed). */
  skip?: number;
}
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

// ---------- filters ----------

/** What a filter matches (users.settings.filters criteria). */
export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  /** Bytes, compared as sizeComparison says. */
  size?: number;
  sizeComparison?: "larger" | "smaller";
}

/** A filter's actions as the tools take and show them; each stands for a label change Gmail makes. */
export interface FilterActions {
  /** User labels to add, by name or ID; they must exist. */
  addLabels?: string[];
  archive?: boolean;
  markRead?: boolean;
  star?: boolean;
  markImportant?: boolean;
  neverImportant?: boolean;
  trash?: boolean;
  neverSpam?: boolean;
  category?: "primary" | "social" | "promotions" | "updates" | "forums";
}

interface ApiFilter {
  id: string;
  criteria?: FilterCriteria & { sizeComparison?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

/** The label change behind each yes/no action, as Gmail's filter settings make it. */
const FILTER_FLAGS: { action: keyof FilterActions; add?: string; remove?: string }[] = [
  { action: "archive", remove: "INBOX" },
  { action: "markRead", remove: "UNREAD" },
  { action: "star", add: "STARRED" },
  { action: "markImportant", add: "IMPORTANT" },
  { action: "neverImportant", remove: "IMPORTANT" },
  { action: "trash", add: "TRASH" },
  { action: "neverSpam", remove: "SPAM" },
];

/** At most this many existing emails are counted when previewing a filter. */
export const FILTER_PREVIEW_MAX = 500;

/** A Gmail search for what a filter matches, as Gmail's own "search" button for a filter builds it. */
export function filterQuery(c: FilterCriteria): string {
  const terms: string[] = [];
  if (c.from?.trim()) terms.push(`from:(${c.from.trim()})`);
  if (c.to?.trim()) terms.push(`to:(${c.to.trim()})`);
  if (c.subject?.trim()) terms.push(`subject:(${c.subject.trim()})`);
  if (c.query?.trim()) terms.push(`(${c.query.trim()})`);
  if (c.negatedQuery?.trim()) terms.push(`-{${c.negatedQuery.trim()}}`);
  if (c.hasAttachment) terms.push("has:attachment");
  if (c.size && c.sizeComparison) terms.push(`${c.sizeComparison}:${c.size}`);
  return terms.join(" ");
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

/**
 * Recipient arguments as given ("user@example.com") or with a display name ("Ann Lee <ann@example.com>",
 * which is kept for the header). A value that holds no address at all is passed on as it is, so the
 * address check names it.
 */
function recipients(values: string[] | undefined): Recipient[] | undefined {
  return values?.flatMap((value): Recipient[] => {
    const parsed = parseMailboxes(value);
    return parsed.length ? parsed : [value];
  });
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

/** The most messages, and threads, one change_labels or move_to call takes. */
export const MAX_CHANGE_MESSAGES = 100;
export const MAX_CHANGE_THREADS = 50;

/** Checks and de-duplicates the IDs a change_labels or move_to call names, within the per-call limit. */
function checkTargets(kind: "messages" | "threads", ids: string[]): string[] {
  const what = kind === "messages" ? "message" : "thread";
  const unique = [...new Set(ids.map((id) => checkId(id, what)))];
  const max = kind === "messages" ? MAX_CHANGE_MESSAGES : MAX_CHANGE_THREADS;
  if (!unique.length) throw new MimeError(`Give at least one ${what} ID.`);
  if (unique.length > max) throw new MimeError(`At most ${max} ${what} IDs per call (got ${unique.length}); for more, use bulk_update or bulk_trash.`);
  return unique;
}

export type MoveDestination = "trash" | "out_of_trash" | "spam" | "not_spam" | "inbox";

/** The label changes behind the moves that aren't Gmail's trash and untrash calls. */
const MOVES: Record<"spam" | "not_spam" | "inbox", { addLabelIds: string[]; removeLabelIds: string[] }> = {
  spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
  not_spam: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
  inbox: { addLabelIds: ["INBOX"], removeLabelIds: [] },
};

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

/** How many of a thread's most recent emails a search result lists. */
const THREAD_PREVIEW_MESSAGES = 3;
/** get_thread shortens the oldest bodies first once its bodies add up to more than this many characters. */
export const DEFAULT_THREAD_BUDGET = 60_000;
/** A body shortened to fit get_thread's budget keeps this many characters. */
const BUDGET_PREVIEW_CHARS = 200;

/** Links to a thread or message (`{id}`) and to a draft (`{messageId}`) in Gmail, for `{account}`. */
export const VIEW_URL_TEMPLATE = "https://mail.google.com/mail/?authuser={account}#all/{id}";
export const DRAFT_URL_TEMPLATE = "https://mail.google.com/mail/?authuser={account}#drafts?compose={messageId}";
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

/** What to tell Claude when an ID isn't found: it usually came from another account's results. */
export const WRONG_ACCOUNT_HINT = "IDs belong to one account; pass the account that returned them.";

/** The emails a bulk change will touch, plus what's left over beyond maxEmails. */
type Selection = {
  ids: string[];
  /** More emails need the change than `max`. */
  more: boolean;
  unavailable?: Record<string, unknown>;
} & (
  | { kind: "query"; /** Changed emails stop matching, so running the change again continues. */ resumable: boolean }
  | {
      kind: "threads";
      /** The given thread IDs, duplicates removed. */
      threadIds: string[];
      remainingThreadIds: string[];
      threadOf: Map<string, string>;
      /** Given IDs that don't exist in this account. */
      notFound: string[];
    }
  | { kind: "messages"; remainingMessageIds: string[] }
);

/** Lists of IDs to pass next time are returned in full up to this many; beyond that, their count and where they start. */
const REMAINING_LIST_MAX = 100;

/**
 * Says how to continue a bulk change that didn't cover everything: emails beyond maxEmails, and
 * `notDone` emails a failed run didn't get to. ID selections get the IDs to pass next time, or when
 * there are many, their count and where they start in the given list (which Claude still holds).
 * `resume` is the instruction itself, for messages that explain how to go on.
 */
function bulkLeftOver(selection: Selection, max: number, notDone: string[] = []): { fields: Record<string, unknown>; resume?: string } {
  const limit = `maxEmails can go up to 2,000.`;
  if (selection.kind === "query") {
    if (!selection.more) return { fields: {} };
    return {
      fields: {
        more: selection.resumable
          ? `More emails match than the limit of ${max}; each run changes the newest ${max}. Run the same change again to continue (emails already changed no longer match). ${limit}`
          : `More emails match than the limit of ${max}; each run changes the newest ${max}. Running it again would pick the same emails, so raise maxEmails or narrow the query. ${limit}`,
      },
    };
  }
  const threads = selection.kind === "threads";
  const given = threads ? selection.threadIds : [...selection.ids, ...selection.remainingMessageIds];
  const remaining = threads
    ? [...new Set([...notDone.map((id) => selection.threadOf.get(id)!), ...selection.remainingThreadIds])]
    : [...notDone, ...selection.remainingMessageIds];
  if (!remaining.length) return { fields: {} };
  // What's left is the given list from its first unfinished ID on (duplicates removed), so a long
  // list needn't be echoed back: Claude has it.
  const key = threads ? "threadIds" : "messageIds";
  const field = threads ? "remainingThreadIds" : "remainingMessageIds";
  const listed = remaining.length <= REMAINING_LIST_MAX;
  const which = listed ? field : `the ${remaining.length} IDs after the first ${given.indexOf(remaining[0])} you gave (duplicates removed)`;
  const resume = `run it again with ${key} set to ${which}`;
  const why = threads
    ? `These threads hold more than ${max} emails to change; each run changes ${max}.`
    : `Only ${max} of the given emails are changed per run (maxEmails).`;
  return {
    fields: {
      ...(selection.more ? { more: `${why} To continue, ${resume}. ${limit}` } : {}),
      ...(listed ? { [field]: remaining } : { remainingCount: remaining.length, remainingHint: `Pass ${which} as ${key} next time.` }),
    },
    resume,
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

// ---------- contacts ----------

/** Headers find_contact reads. */
const CONTACT_HEADERS = ["From", "To", "Cc", "Date"];
/** Recipients find_contact looks at per email (a mass mailing's thousands would only cost CPU time). */
const CONTACT_RECIPIENTS = 50;
/** How much of an address header find_contact parses: the start, cut at a comma (50 addresses or more). */
const CONTACT_HEADER_CHARS = 4 * 1024;

function contactHeader(msg: ApiMessage, name: string): string | undefined {
  const value = header(msg.payload, name);
  if (!value || value.length <= CONTACT_HEADER_CHARS) return value;
  const comma = value.lastIndexOf(",", CONTACT_HEADER_CHARS);
  return value.slice(0, comma > 0 ? comma : CONTACT_HEADER_CHARS);
}

/** Text for matching a query: lower case, without accents ("Angélica" matches "angelica"). */
export function foldText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * A find_contact query made safe to quote word by word in a Gmail search: a double quote can't be
 * escaped inside quotes, so quotes, backslashes and control characters become spaces. Empty if nothing is left.
 */
export function contactPhrase(query: string): string {
  return query
    .replace(/[\u0000-\u001f\u007f"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One address as seen in the emails find_contact scanned, in one account or merged across accounts. */
export interface ContactTally {
  /** The address as most recently written. */
  address: string;
  /** The display name most recently given with it, and when. */
  name?: string;
  nameTime: number;
  /** Every display name seen with it (up to 5), for matching the query. */
  names: string[];
  /** The newest email it was on (ms). */
  time: number;
  /** On emails the user sent, and on emails the user received. */
  sent: boolean;
  received: boolean;
  messages: number;
  accounts: string[];
}

/** Adds one sighting (or another account's tally) of an address to `tallies`, keyed by canonical address. */
export function addContact(tallies: Map<string, ContactTally>, t: ContactTally): void {
  const key = canonicalAddress(t.address);
  const known = tallies.get(key);
  if (!known) {
    tallies.set(key, { ...t, names: [...t.names], accounts: [...t.accounts] });
    return;
  }
  if (t.time > known.time) {
    known.time = t.time;
    known.address = t.address;
  }
  if (t.name && t.nameTime >= known.nameTime) {
    known.name = t.name;
    known.nameTime = t.nameTime;
  }
  for (const n of t.names) if (known.names.length < 5 && !known.names.includes(n)) known.names.push(n);
  for (const a of t.accounts) if (!known.accounts.includes(a)) known.accounts.push(a);
  known.sent ||= t.sent;
  known.received ||= t.received;
  known.messages += t.messages;
}

/** True when every word of the query is in one of the address's names or in the address (accents ignored). */
export function contactMatches(t: ContactTally, words: string[]): boolean {
  const address = foldText(t.address);
  return [...t.names.map(foldText), address].some((text) => words.every((w) => text.includes(w) || address.includes(w)));
}

/** Most recent first (by day), then most emails, then the exact time. */
export function rankContacts(a: ContactTally, b: ContactTally): number {
  const day = (t: number) => Math.floor(t / 86_400_000);
  return day(b.time) - day(a.time) || b.messages - a.messages || b.time - a.time;
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

/** Longest subject and body taken from a mailto: unsubscribe link; the rest is cut off. */
export const MAX_UNSUBSCRIBE_SUBJECT = 200;
export const MAX_UNSUBSCRIBE_BODY = 1000;

/**
 * Text from a mailto: link, fit to be sent: control and invisible format characters removed (line
 * breaks and tabs stay in a body), cut to `max` characters.
 */
function unsubscribeText(text: string, max: number, multiline: boolean): string {
  const clean = multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "")
    : text.replace(/[\r\n]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "");
  return limitLength(clean.trim(), max).text;
}

/** Longest List-Unsubscribe value read (real ones are a few hundred characters); the rest is ignored. */
const MAX_LIST_UNSUBSCRIBE = 8 * 1024;

/** The <…> entries of a header value, found in one pass (the "<" nearest each ">" opens it). */
function bracketedEntries(value: string): string[] {
  const out: string[] = [];
  for (let open = value.indexOf("<"); open >= 0; ) {
    const close = value.indexOf(">", open + 1);
    if (close < 0) break;
    out.push(value.slice(value.lastIndexOf("<", close) + 1, close));
    open = value.indexOf("<", close + 1);
  }
  return out;
}

export function unsubscribeOptions(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): UnsubscribeOptions {
  if (!listUnsubscribe) return {};
  let value = listUnsubscribe;
  if (value.length > MAX_LIST_UNSUBSCRIBE) {
    value = value.slice(0, MAX_LIST_UNSUBSCRIBE);
    // An entry cut off at the end isn't used (a bracketed one is never complete without its ">").
    if (!value.includes(">")) value = value.slice(0, value.lastIndexOf(",") + 1);
  }
  // Entries are <uri>, comma separated; a few senders leave out the angle brackets.
  const bracketed = bracketedEntries(value);
  const uris = (bracketed.length ? bracketed : value.split(",")).map((u) => u.trim()).filter(Boolean);
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
        subject: unsubscribeText(url.searchParams.get("subject") ?? "", MAX_UNSUBSCRIBE_SUBJECT, false) || "unsubscribe",
        body: unsubscribeText(url.searchParams.get("body") ?? "unsubscribe", MAX_UNSUBSCRIBE_BODY, true),
      };
    }
  }
  return out;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain"];

/**
 * Why a one-click unsubscribe URL must not be contacted, or undefined if it may. Only plain https
 * (standard port, no user name) to a named public host is allowed: no IP addresses (which also
 * covers every private and link-local range), no local names, and never the connector's own host
 * (`ownHost`). A name that resolves to a private address is checked separately.
 */
export function unsafeUnsubscribeHost(url: URL, opts: { ownHost?: string } = {}): string | undefined {
  if (url.protocol !== "https:") return "it isn't an https address";
  if (url.username || url.password) return "it contains a user name or password";
  // The parser drops the standard port, so any port left is a non-standard one.
  if (url.port) return `it uses port ${url.port} instead of the standard https port`;
  // The URL parser already turned forms like 0x7f.1 or 2130706433 into 127.0.0.1.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return `it points to an IP address (${host}), not a website`;
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return `it points to a local network name (${host}), not a website`;
  }
  if (opts.ownHost && host === opts.ownHost.toLowerCase().replace(/\.$/, "")) return "it points at this connector itself";
  return undefined;
}

/** Labels under which two-letter country domains hand out names (co.uk, com.au, …): a hint, not the public suffix list. */
const COUNTRY_SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "ne", "or", "go", "gob", "mil"]);

/**
 * The part of a host name its owner registered, by a simple rule: the last two labels, or three
 * under a country domain's second level ("news.e.levi.com" → "levi.com", "x.bbc.co.uk" → "bbc.co.uk").
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const take = labels.length > 2 && labels[labels.length - 1].length === 2 && COUNTRY_SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The four bytes of a dotted-quad IPv4 address, or undefined. */
function ipv4Bytes(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  const bytes = m?.slice(1).map(Number);
  return bytes?.every((b) => b <= 255) ? bytes : undefined;
}

/**
 * The 16 bytes of an IPv6 address in any textual form (compressed or not, with an embedded IPv4
 * address such as ::ffff:10.0.0.1, with a zone id), or undefined if it isn't one.
 */
function ipv6Bytes(ip: string): number[] | undefined {
  let text = ip.replace(/%.*$/, "").toLowerCase();
  const embedded = /(?<=:)\d{1,3}(?:\.\d{1,3}){3}$/.exec(text);
  if (embedded) {
    const b = ipv4Bytes(embedded[0]);
    if (!b) return undefined;
    text = `${text.slice(0, embedded.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part ? part.split(":") : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if ([...head, ...tail].some(Number.isNaN) || missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail].flatMap((g) => [g >> 8, g & 0xff]);
}

/** Loopback, private, link-local, shared (CGNAT), multicast, benchmark and other non-public IPv4 ranges. */
function privateV4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
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

/**
 * True for loopback, private, link-local, shared (CGNAT), multicast and other non-public addresses,
 * IPv4 or IPv6. IPv6 forms that carry an IPv4 address (IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96,
 * 6to4 2002::/16, and the old IPv4-compatible ::/96) are judged by that address. Anything that
 * isn't an address at all counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return privateV4(v4);
  const v6 = ipv6Bytes(ip);
  if (!v6) return true;
  const startsWith = (...prefix: number[]) => prefix.every((b, i) => v6[i] === b);
  if (startsWith(...new Array<number>(10).fill(0), 0xff, 0xff)) return privateV4(v6.slice(12)); // ::ffff:a.b.c.d
  if (startsWith(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0)) return privateV4(v6.slice(12)); // 64:ff9b::a.b.c.d (NAT64)
  if (startsWith(...new Array<number>(12).fill(0))) {
    const last = v6.slice(12);
    return last.every((b) => b === 0) || (last[0] === 0 && last[1] === 0 && last[2] === 0 && last[3] === 1) || privateV4(last); // ::, ::1, ::a.b.c.d
  }
  if (startsWith(0x20, 0x02)) return privateV4(v6.slice(2, 6)); // 2002:a.b.c.d:: (6to4)
  return (
    (v6[0] & 0xfe) === 0xfc || // fc00::/7 unique local
    (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) || // fe80::/10 link-local
    (v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0) || // fec0::/10 site-local (deprecated)
    v6[0] === 0xff || // multicast
    v6[0] === 0 || // the rest of ::/8 (reserved)
    startsWith(0x01, 0, 0, 0, 0, 0, 0, 0) || // 100::/64 discard
    startsWith(0x20, 0x01, 0x0d, 0xb8) // 2001:db8::/32 documentation
  );
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
 * The attachments of a message, read from its part tree alone (no body is decoded), by the same
 * rules as extractContent: attached emails, and any part with a file name or an attachment ID that
 * isn't the body text.
 */
export function listAttachments(payload: ApiMessagePart | undefined): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  const add = (part: ApiMessagePart, fallbackName: string) => {
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    const contentId = header(part, "Content-ID")?.replace(/^<|>$/g, "");
    attachments.push({
      id: part.body?.attachmentId,
      partId: part.partId,
      filename: part.filename || fallbackName,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      inline: disposition.startsWith("inline") || (!disposition && Boolean(contentId)),
      ...(contentId ? { contentId } : {}),
    });
  };
  const walk = (part: ApiMessagePart) => {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (mimeType.startsWith("message/")) {
      if (part.body?.attachmentId || part.filename) add(part, "attached-message.eml");
      else for (const child of part.parts ?? []) walk(child);
      return;
    }
    if (part.parts?.length) {
      for (const child of part.parts) walk(child);
      return;
    }
    const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
    const isBodyText = (mimeType === "text/plain" || mimeType === "text/html") && !part.filename && !disposition.startsWith("attachment");
    if (!isBodyText && (part.filename || part.body?.attachmentId)) add(part, "(unnamed)");
  };
  if (payload) walk(payload);
  return attachments;
}

/** Base64url text is decoded natively in pieces of this many characters (a multiple of 4). */
const DECODE_CHUNK = 3 * 1024 * 1024;

/**
 * Decodes base64url text given as bytes, piece by piece into one buffer sized for the result, so
 * that no string of the whole text is ever built: the peak is the text plus the file.
 */
export function decodeBase64Url(data: Uint8Array): Buffer {
  let n = data.length;
  while (n && data[n - 1] === 0x3d) n--; // "=" padding
  const out = Buffer.allocUnsafe(Math.floor((n * 3) / 4));
  let written = 0;
  for (let start = 0; start < n; start += DECODE_CHUNK) {
    written += Buffer.from(latin1(data.subarray(start, Math.min(start + DECODE_CHUNK, n))), "base64url").copy(out, written);
  }
  return written === out.length ? out : out.subarray(0, written);
}

/** Where the base64url value of a `"data"` key starts and ends in raw JSON, from `from` on. */
function dataValueAt(json: Uint8Array, from: number): { key: number; start: number; end: number } | undefined {
  const view = Buffer.from(json.buffer, json.byteOffset, json.byteLength);
  for (let key = view.indexOf('"data"', from); key >= 0; key = view.indexOf('"data"', key + 6)) {
    let start = key + 6;
    const space = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
    while (start < json.length && space(json[start])) start++;
    if (json[start] !== 0x3a) continue; // not a key
    start++;
    while (start < json.length && space(json[start])) start++;
    if (json[start] !== 0x22) continue;
    const end = view.indexOf(0x22, start + 1); // base64url holds no quotes or escapes
    if (end > start) return { key, start: start + 1, end };
  }
  return undefined;
}

/**
 * The base64url text of an attachments.get answer, sliced out of the raw JSON without parsing it
 * (base64url has no characters JSON would escape). Falls back to parsing for any other shape.
 */
export function attachmentDataOf(json: Uint8Array): Uint8Array {
  const found = dataValueAt(json, 0);
  if (found) return json.subarray(found.start, found.end);
  return Buffer.from((JSON.parse(new TextDecoder().decode(json)) as { data?: string }).data ?? "", "latin1");
}

/**
 * A message's raw JSON with every body's `data` blanked out, so that its structure (headers, parts,
 * attachment IDs and sizes) can be parsed without the bodies: a 2 MB newsletter then parses in a
 * fraction of a millisecond instead of being decoded from text and parsed whole.
 */
export function withoutBodyData(json: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [];
  let pos = 0;
  for (let found = dataValueAt(json, 0); found; found = dataValueAt(json, found.end)) {
    kept.push(json.subarray(pos, found.start));
    pos = found.end;
  }
  if (!kept.length) return json;
  kept.push(json.subarray(pos));
  return Buffer.concat(kept);
}


// ---------- send-as addresses ----------

/** One of the addresses an account can send from (users.settings.sendAs). */
export interface SendAsEntry {
  sendAsEmail: string;
  displayName?: string;
  /** Gmail's signature for this address, as HTML. */
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

const SEND_AS_TTL_MS = 60 * 60 * 1000;

/**
 * Each account's send-as list, kept for an hour per isolate (like access tokens), so that reply-all,
 * signatures and list_accounts cost one settings call per cold account. Keyed by the address and a
 * fingerprint of the account's grant, so a re-linked account is read again. Exported for tests.
 */
export const sendAsCache = new Map<string, { entries: SendAsEntry[]; expiresAt: number }>();

const LABEL_NAMES_TTL_MS = 10 * 60 * 1000;

/**
 * Each account's user label names by ID, kept for 10 minutes per isolate, so results can show label
 * names instead of IDs without reading the label list on every call. Keyed like sendAsCache; a label
 * change through this connector clears the account's entry. Exported for tests.
 */
export const labelNameCache = new Map<string, { names: Map<string, string>; expiresAt: number }>();

/** A short one-way fingerprint of a secret (two FNV-1a style rounds), for use in a cache key. */
function fingerprint(secret: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x5bd1e995;
  for (let i = 0; i < secret.length; i++) {
    const c = secret.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** All Gmail operations for a single linked account. */
export class Mailbox {
  /** A send-as lookup in progress, so one tool call never asks twice. */
  private sendAsLookup?: Promise<SendAsEntry[]>;
  /** A label list read in progress (for label names), likewise. */
  private labelNamesLookup?: Promise<Map<string, string>>;

  constructor(
    readonly client: GmailClient,
    private readonly options: MailboxOptions = {},
  ) {}

  get email(): string {
    return this.client.email;
  }

  // ---------- the user's own addresses ----------

  private get sendAsKey(): string {
    return `${this.email.toLowerCase()}\n${fingerprint(this.client.account.refreshToken)}`;
  }

  /** The send-as list, if it is in the cache. */
  private cachedSendAs(): SendAsEntry[] | undefined {
    const hit = sendAsCache.get(this.sendAsKey);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      sendAsCache.delete(this.sendAsKey);
      return undefined;
    }
    return hit.entries;
  }

  /**
   * The addresses this account can send from (users.settings.sendAs), the primary first. One settings
   * call per account and hour per isolate; if it fails for any reason, just the primary address.
   */
  async sendAs(): Promise<SendAsEntry[]> {
    const cached = this.cachedSendAs();
    if (cached) return cached;
    this.sendAsLookup ??= this.client
      .request("GET", "settings/sendAs")
      .then((res) => {
        const listed = ((res?.sendAs ?? []) as Partial<SendAsEntry>[]).filter(
          (e): e is SendAsEntry => typeof e.sendAsEmail === "string" && e.sendAsEmail.includes("@"),
        );
        // The account's own entry comes first; it is made up if the list somehow lacks it.
        const own =
          listed.find((e) => sameMailbox(e.sendAsEmail, this.email)) ??
          ({ sendAsEmail: this.email, isPrimary: true, isDefault: !listed.some((e) => e.isDefault) } satisfies SendAsEntry);
        const entries = [own, ...listed.filter((e) => e !== own)];
        sendAsCache.set(this.sendAsKey, { entries, expiresAt: Date.now() + SEND_AS_TTL_MS });
        return entries;
      })
      .catch((): SendAsEntry[] => [{ sendAsEmail: this.email, isPrimary: true, isDefault: true }])
      .finally(() => {
        this.sendAsLookup = undefined;
      });
    return this.sendAsLookup;
  }

  /** The addresses known to be the user's without asking Gmail: the primary, plus any cached send-as ones. */
  ownAddresses(): string[] {
    return [this.email, ...(this.cachedSendAs() ?? []).map((e) => e.sendAsEmail)];
  }

  /** True when the address is one of the user's own (see ownAddresses; Gmail dot and +tag variants count). */
  private isMine(address: string): boolean {
    return this.ownAddresses().some((own) => sameMailbox(own, address));
  }

  /** The signature Gmail adds for this account: its own send-as entry's, or the default entry's when its own has none. */
  async signature(): Promise<string> {
    const entries = await this.sendAs();
    const own = entries.find((e) => sameMailbox(e.sendAsEmail, this.email))?.signature?.trim();
    return own || (entries.find((e) => e.isDefault)?.signature?.trim() ?? "");
  }

  /** Adds `fromMe: true` (right after `from`) to an email the user sent from any of their addresses. */
  private markFromMe(msg: Record<string, unknown>): Record<string, unknown> {
    if (typeof msg.from !== "string" || !this.isMine(bareAddress(msg.from))) return msg;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(msg)) {
      out[key] = value;
      if (key === "from") out.fromMe = true;
    }
    return out;
  }

  // ---------- label names ----------

  private get labelCacheKey(): string {
    return this.sendAsKey;
  }

  /** Forgets this account's label names (after a label is created, renamed or deleted). */
  private forgetLabelNames(): void {
    labelNameCache.delete(this.labelCacheKey);
  }

  private rememberLabels(labels: ApiLabel[]): Map<string, string> {
    const names = new Map(labels.filter((l) => l.type !== "system").map((l) => [l.id, l.name]));
    labelNameCache.set(this.labelCacheKey, { names, expiresAt: Date.now() + LABEL_NAMES_TTL_MS });
    return names;
  }

  /**
   * Names for the user labels among `labelLists` (system labels need none): from the cache when it
   * has them all, otherwise from one read of the label list per call. If that fails, the IDs are shown.
   */
  async labelNames(labelLists: readonly (readonly string[] | undefined)[]): Promise<ReadonlyMap<string, string>> {
    const wanted = new Set(labelLists.flatMap((l) => userLabelIds(l)));
    if (!wanted.size) return new Map();
    const hit = labelNameCache.get(this.labelCacheKey);
    if (hit && hit.expiresAt > Date.now() && [...wanted].every((id) => hit.names.has(id))) return hit.names;
    this.labelNamesLookup ??= this.client
      .request("GET", "labels")
      .then((res) => this.rememberLabels((res?.labels ?? []) as ApiLabel[]))
      .catch(() => hit?.names ?? new Map<string, string>())
      .finally(() => {
        this.labelNamesLookup = undefined;
      });
    return this.labelNamesLookup;
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
   * Trims a message for search results: compact (see compactMessage), with a preview-length snippet,
   * no threadId (the thread has it), and no recipient list when the email went only to this account.
   * `flags` are the message's own flags to show (a thread's other flags are given for the thread).
   */
  private searchSummary(m: FormattedMessage, flags: "all" | "own", names: ReadonlyMap<string, string>) {
    const self = this.email.toLowerCase();
    const toSelfOnly = m.toRecipients?.length === 1 && bareAddress(m.toRecipients[0]) === self && !m.ccRecipients?.length;
    const out = compactMessage(
      { ...m, threadId: m.id, snippet: m.snippet === undefined ? undefined : preview(m.snippet), ...(toSelfOnly ? { toRecipients: [] } : {}) },
      { names, flags: flags === "all" },
    );
    if (flags === "own") {
      const own = labelFlags([m.labelIds]);
      const at = Object.keys(out).indexOf("snippet");
      return this.markFromMe(insertAt(out, at < 0 ? Object.keys(out).length : at, { ...(own.unread ? { unread: true } : {}), ...(own.starred ? { starred: true } : {}) }));
    }
    return this.markFromMe(out);
  }

  // ---------- threads & messages ----------

  async searchThreads(opts: SearchOptions) {
    const { ids: _ids, ...page } = await this.searchPage(opts);
    return page;
  }

  /**
   * One page of a thread search. `ids` are the thread IDs Gmail listed (after `skip`), in Gmail's
   * order, newest first; `threads` are those of them that could be read.
   */
  async searchPage(opts: SearchOptions) {
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
    const ids = ((list.threads ?? []) as { id: string }[]).map((t) => t.id).slice(opts.skip ?? 0);
    const fetched = await this.client.batchGet<{ messages?: ApiMessage[] }>(
      ids.map((id) => ({ path: `threads/${id}`, query: { format: "metadata", metadataHeaders: METADATA_HEADERS } })),
    );
    const { found, failed } = settle(ids, fetched);
    const shown = found.map(({ id, value: thread }) => {
      let messages = (thread.messages ?? []) as ApiMessage[];
      if (!includeDrafts) messages = messages.filter((m) => !m.labelIds?.includes("DRAFT"));
      return { id, messages };
    });
    // User label names, read once for the page (and only when a user label appears).
    const names = await this.labelNames(shown.flatMap((t) => t.messages.map((m) => m.labelIds)));
    const threads = await mapLimit(shown, 8, async ({ id, messages }): Promise<Record<string, any>> => {
      const recent = messages.slice(-THREAD_PREVIEW_MESSAGES);
      const formatted = await Promise.all(recent.map((m) => this.format(m, format)));
      // Most threads hold one email: show it flat instead of a thread wrapping a one-item list.
      if (formatted.length === 1) {
        const { id: messageId, ...message } = this.searchSummary(formatted[0], "all", names);
        return { id, ...(messageId !== id ? { messageId } : {}), ...message };
      }
      // Replies repeat the subject with "Re:"; list it once for the thread, as its first email had it
      // (the preview only shows the latest emails). The flags are the whole thread's.
      const subject =
        format === "METADATA_ONLY" || !messages.length ? undefined : stripInvisible(header(messages[0].payload, "Subject") ?? "").trim();
      const base = normalizeSubject(subject);
      return {
        id,
        ...(subject !== undefined ? { subject } : {}),
        total: messages.length,
        ...labelFlags(messages.map((m) => m.labelIds), names),
        messages: formatted
          .map((m) => this.searchSummary(m, "own", names))
          .map(({ subject: s, ...m }) => (s !== undefined && normalizeSubject(s as string) !== base ? { subject: s, ...m } : m)),
      };
    });
    return {
      ids,
      threads,
      ...unavailable("threadIds", failed),
      ...(list.nextPageToken ? { nextPageToken: list.nextPageToken as string } : {}),
    };
  }

  /**
   * A thread in the compact shape (see compactMessage): the subject once (and on a message only when
   * it changes), the thread's flags once (each message shows only its own unread/starred), and notes
   * on shortened bodies once. With bodies, messages don't repeat their snippet, and once the bodies add
   * up to more than `maxTotalChars` (default DEFAULT_THREAD_BUDGET; 0 for no limit), the oldest are
   * cut to their start, listed under `shortened`.
   */
  async getThread(threadId: string, format: MessageFormat, opts: FormatOptions & { maxTotalChars?: number } = {}) {
    if (format === "RAW") throw new MimeError("RAW format is not supported for threads; use get_message instead.");
    const thread = await this.client.request("GET", `threads/${checkId(threadId, "thread")}`, {
      query: { format: apiFormat(format), metadataHeaders: format === "MINIMAL" || format === "METADATA_ONLY" ? METADATA_HEADERS : undefined },
    });
    const messages = ((thread.messages ?? []) as ApiMessage[]).filter((m) => !m.labelIds?.includes("DRAFT"));
    // A reply's quoted copy of an earlier message is hidden (see formatThread): that message is in the result.
    const formatted = await formatThread(messages, format, this.email, (id) => this.loader(id), opts);
    const withBodies = format === "PLAIN_TEXT" || format === "FULL_CONTENT";
    const shortened = withBodies ? fitBudget(formatted, opts.maxTotalChars ?? DEFAULT_THREAD_BUDGET) : [];
    const names = await this.labelNames(messages.map((m) => m.labelIds));
    const subject = formatted.find((m) => m.subject !== undefined)?.subject;
    const topic = normalizeSubject(subject);
    return {
      id: thread.id as string,
      ...(subject !== undefined ? { subject } : {}),
      ...(messages.length > 1 ? { total: messages.length } : {}),
      ...labelFlags(messages.map((m) => m.labelIds), names),
      messages: formatted.map((m) => {
        const own = labelFlags([m.labelIds]);
        const { subject: s, ...rest } = compactMessage(
          { ...m, threadId: m.id, ...(withBodies ? { snippet: undefined } : {}), labelIds: [...(own.unread ? ["UNREAD"] : []), ...(own.starred ? ["STARRED"] : [])] },
          { names },
        );
        // Only a message's own unread/starred remain: drop the "archived" its reduced labels imply.
        delete rest.archived;
        return this.markFromMe(s !== undefined && normalizeSubject(s as string) !== topic ? { subject: s, ...rest } : rest);
      }),
      ...bodyNotes(formatted),
      ...(shortened.length
        ? {
            shortened: {
              messageIds: shortened,
              note:
                `This thread is long, so the bodies of its oldest emails were cut to their first ${BUDGET_PREVIEW_CHARS} characters or left out. ` +
                `get_message shows one in full; maxTotalChars: 0 returns every body.`,
            },
          }
        : {}),
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
    const formatted = await this.format(msg, format, opts);
    // With the body there, the snippet only repeats its start.
    const withBody = format === "PLAIN_TEXT" || format === "FULL_CONTENT";
    const names = format === "RAW" ? new Map<string, string>() : await this.labelNames([msg.labelIds]);
    const compact = compactMessage({ ...formatted, ...(withBody ? { snippet: undefined } : {}) }, { names, keepLabelIds: format === "RAW" });
    return { ...this.markFromMe(compact), ...bodyNotes([formatted]), viewUrl: formatted.viewUrl };
  }

  /**
   * Downloads every attachment of a message so it can be re-attached (forwarding, draft edits),
   * keeping each as Gmail's base64url text so it is never decoded and encoded again. Attachments
   * over the limit are refused from their listed sizes before downloading anything; attachments
   * being `added` to the same email count towards it. Large ones are fetched on their own as bytes
   * (no batch text to split, no JSON to parse); small ones share a batch.
   */
  private async downloadAttachments(
    msg: ApiMessage,
    content: ExtractedContent,
    tooBig: (size: string, limit: string, note?: string) => string,
    added: OutgoingAttachment[] = [],
  ): Promise<OutgoingAttachment[]> {
    const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
    const listed = content.attachments.reduce((sum, a) => sum + a.size, 0);
    const extra = added.reduce((sum, a) => sum + attachmentSize(a.content), 0);
    const total = listed + extra;
    const size = extra ? `${mb(total)} (${mb(listed)} on the email and ${mb(extra)} being added)` : mb(total);
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

  /**
   * Threading headers and default recipients for replying to `messageId`. The user's own addresses
   * never end up among the recipients: for reply-all that means every send-as address (one settings
   * call per cold account); otherwise the primary address and whatever send-as list is cached.
   */
  async replyContext(messageId: string, replyAll = false) {
    const original = await this.getRawMessage(messageId, "full");
    const p = original.payload;
    const from = header(p, "From") ?? "";
    const toHeader = header(p, "To");
    const ccHeader = header(p, "Cc");
    const own = replyAll ? [this.email, ...(await this.sendAs()).map((e) => e.sendAsEmail)] : this.ownAddresses();
    const mine = (address: string) => own.some((a) => sameMailbox(a, address));
    // Derived recipients skip anything that isn't a real address (e.g. "undisclosed-recipients:;").
    const sentBySelf = mine(bareAddress(from));
    const to = sentBySelf ? recipientsFrom(toHeader) : recipientsFrom(header(p, "Reply-To") || from);
    const toAddresses = to.map((m) => m.address);
    const cc = replyAll
      ? recipientsFrom(sentBySelf ? ccHeader : [toHeader, ccHeader].filter(Boolean).join(", "), toAddresses).filter((m) => !mine(m.address))
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

  /**
   * The user's own text and HTML for an email, with the account's Gmail signature appended when asked
   * for: in the HTML as Gmail marks it up, in the text after a "-- " line. A signature gives even a
   * plain-text email an HTML part, so its formatting and links survive.
   */
  private async bodies(input: { body?: string; htmlBody?: string; includeSignature?: boolean }): Promise<{ text: string; html?: string }> {
    const text = input.body ?? (input.htmlBody ? htmlToText(input.htmlBody) : "");
    const signature = input.includeSignature ? await this.signature() : "";
    if (!signature) return { text, html: input.htmlBody };
    const html = input.htmlBody ?? escapeHtml(text).replace(/\n/g, "<br>");
    return {
      text: [text, `-- \n${htmlToText(signature)}`].filter(Boolean).join("\n\n"),
      html: `${html}<br><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signature}</div>`,
    };
  }

  /** Puts the quoted original (attribution and all) below the user's own text and HTML. */
  private withQuote(
    own: { text: string; html?: string },
    quote: { attribution: string; text: string; html?: string },
  ): { text: string; html?: string } {
    const quotedText = `${quote.attribution}\n${quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n")}`;
    const text = `${own.text}\n\n${quotedText}`;
    if (!own.html) return { text };
    const quotedHtml = quote.html ?? escapeHtml(quote.text).replace(/\n/g, "<br>");
    const html =
      `${own.html}<br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(quote.attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${quotedHtml}</blockquote></div>`;
    return { text, html };
  }

  async sendMessage(input: ComposeInput & { draftId?: string; replyThreadId?: string; replyToMessageId?: string }) {
    if (input.draftId) {
      const id = checkId(input.draftId, "draft");
      const sent = await this.sendMail(() => this.client.request("POST", "drafts/send", { json: { id } }).catch((err) => this.draftGone(id, err)));
      return this.sentResult(sent);
    }
    const to = recipients(input.to) ?? [];
    if (!to.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc (or a draftId).");
    }
    if (!input.body && !input.htmlBody && !input.attachments?.length) {
      throw new MimeError("The email has no content: give it a body (`body` or `htmlBody`) or attachments, or pass a draftId to send a draft.");
    }
    const own = await this.bodies(input);
    const msg: OutgoingMessage = {
      to,
      cc: recipients(input.cc),
      bcc: recipients(input.bcc),
      subject: input.subject,
      text: own.text,
      html: own.html,
      attachments: toAttachments(input.attachments),
    };
    let threadId = input.replyThreadId;
    if (input.replyToMessageId) {
      // Only the threading headers are needed, not the body (reply and create_draft quote it).
      const original = await this.getRawMessage(input.replyToMessageId, "metadata");
      msg.inReplyTo = header(original.payload, "Message-ID");
      msg.references = referencesFor(original.payload);
      msg.subject ||= replySubject(header(original.payload, "Subject"));
      threadId = original.threadId;
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
    const { text, html } = this.withQuote(await this.bodies(input), ctx.quote);
    const mime = buildMimeChunks({
      to: input.to?.length ? recipients(input.to) : ctx.to,
      cc: input.cc?.length ? recipients(input.cc) : ctx.cc,
      bcc: recipients(input.bcc),
      subject: ctx.subject,
      text,
      html,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
      attachments: toAttachments(input.attachments),
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
    includeSignature?: boolean;
    /** Attachments to send along with the original's. */
    attachments?: AttachmentInput[];
  }) {
    if (!input.to?.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc.");
    }
    const added = toAttachments(input.attachments);
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
    const own = await this.bodies({ body: input.forwardText, htmlBody: input.htmlBody, includeSignature: input.includeSignature });
    const text =
      `${own.text}\n\n---------- Forwarded message ---------\n` +
      present.map(([k, v]) => `${k}: ${v}`).join("\n") +
      `\n\n${origText}`;
    const introHtml = own.html ?? escapeHtml(own.text).replace(/\n/g, "<br>");
    const html =
      `${introHtml}<br><br><div class="gmail_quote">---------- Forwarded message ---------<br>` +
      present.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`).join("") +
      `<br>${content.html ?? escapeHtml(origText).replace(/\n/g, "<br>")}</div>`;
    const subject = header(p, "Subject") ?? "";
    const mime = buildMimeChunks({
      to: recipients(input.to),
      cc: recipients(input.cc),
      bcc: recipients(input.bcc),
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`.trim(),
      text,
      html,
      inReplyTo: header(p, "Message-ID"),
      references: referencesFor(p),
      attachments: [
        ...(await this.downloadAttachments(
          original,
          content,
          (size, limit, note) =>
            `This email's attachments add up to ${size}, more than the ${limit}, so it can't be forwarded with them from here. ` +
            `Forward it in Gmail instead (${viewUrl(this.email, `all/${original.id}`)}), which sends large files as Google Drive links.` +
            (note ? ` ${note}` : ""),
          added,
        )),
        ...added,
      ],
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

  /**
   * A draft in the compact shape (see compactMessage), without flags (a draft's labels say nothing
   * new) and without `from` when it is the account's own address. Notes on a shortened body follow.
   */
  private async formatDraft(draft: { id: string; message: ApiMessage }, format: MessageFormat, opts: FormatOptions = {}): Promise<Record<string, unknown>> {
    const formatted = await this.format(draft.message, format, opts);
    const { id: messageId, ...rest } = compactMessage(formatted, { flags: false, keepLabelIds: format === "RAW" });
    if (typeof rest.from === "string" && sameMailbox(bareAddress(rest.from), this.email)) delete rest.from;
    return { id: draft.id, messageId, ...rest, ...bodyNotes([formatted]) };
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
      const { htmlBody: _h, snippet: _s, attachments, ...rest } = await this.formatDraft(draft, full ? "PLAIN_TEXT" : "METADATA_ONLY", {
        maxBodyChars: LIST_BODY_CHARS,
      });
      const files = ((attachments ?? []) as AttachmentInfo[]).map(({ filename, mimeType, size, partId }) => ({
        filename,
        mimeType,
        size,
        ...(partId !== undefined ? { partId } : {}),
      }));
      return { ...rest, ...(files.length ? { attachments: files } : {}) };
    });
    return {
      drafts,
      ...unavailable("draftIds", failed),
      ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
    };
  }

  /** Turns Gmail's 404 for a draft into a message saying what probably happened; other errors pass through. */
  private draftGone(draftId: string, err: unknown): never {
    if (err instanceof GmailApiError && err.status === 404) {
      throw new MimeError(
        `Draft ${draftId} no longer exists in ${this.email} (it may have been sent or deleted). If the ID came from another account, pass that account.`,
      );
    }
    throw err;
  }

  async getDraft(draftId: string, format: MessageFormat, opts: FormatOptions = {}) {
    const id = checkId(draftId, "draft");
    // drafts.get has no metadataHeaders parameter; metadata format returns every header.
    const draft = await this.client.request("GET", `drafts/${id}`, { query: { format: apiFormat(format) } }).catch((err) => this.draftGone(id, err));
    return { ...(await this.formatDraft(draft, format, opts)), viewUrl: this.draftUrl(draft.message.id) };
  }

  async createDraft(input: ComposeInput & { replyToMessageId?: string }) {
    const own = await this.bodies(input);
    const msg: OutgoingMessage = {
      to: recipients(input.to),
      cc: recipients(input.cc),
      bcc: recipients(input.bcc),
      subject: input.subject,
      text: own.text,
      html: own.html,
      attachments: toAttachments(input.attachments),
    };
    let threadId: string | undefined;
    if (input.replyToMessageId) {
      const ctx = await this.replyContext(input.replyToMessageId);
      Object.assign(msg, this.withQuote(own, ctx.quote));
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
    const existing = await this.client.request("GET", `drafts/${draftId}`, { query: { format: "full" } }).catch((err) => this.draftGone(draftId, err));
    const msg = existing.message as ApiMessage;
    const p = msg.payload;
    const content = await extractContent(p, this.loader(msg.id));
    // Keep the draft's recipients (with their display names) unless new ones are given.
    const pick = (value: string[] | undefined, headerName: string): Recipient[] =>
      value?.length ? recipients(value)! : recipientsFrom(header(p, headerName));
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
    const id = checkId(draftId, "draft");
    await this.client.request("DELETE", `drafts/${id}`).catch((err) => this.draftGone(id, err));
    return { deleted: draftId };
  }

  // ---------- labels ----------

  async listLabels() {
    const res = await this.client.request("GET", "labels");
    this.rememberLabels((res.labels ?? []) as ApiLabel[]);
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
    this.forgetLabelNames();
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

  /** Only user labels can be changed or deleted; Gmail refuses for its own (INBOX, STARRED, CATEGORY_…). */
  private userLabel(label: ApiLabel): ApiLabel {
    if (label.type === "system" || isSystemLabelId(label.id)) {
      throw new MimeError(`${label.name} is a system label that Gmail manages: it can't be renamed, recolored or deleted. Only user labels can be (see list_labels).`);
    }
    return label;
  }

  async updateLabel(labelRef: string, input: LabelInput) {
    const [label] = await this.resolveLabels([labelRef]);
    this.forgetLabelNames();
    return this.client.request("PATCH", `labels/${this.userLabel(label).id}`, { json: this.labelBody(input) });
  }

  async deleteLabel(labelRef: string) {
    const [label] = await this.resolveLabels([labelRef]);
    await this.client.request("DELETE", `labels/${this.userLabel(label).id}`);
    this.forgetLabelNames();
    return { deleted: label.id };
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

  /**
   * The labels needed to resolve `refs`: system label IDs (INBOX, UNREAD, CATEGORY_…) stand for
   * themselves, so only names and user labels cost a read of the account's label list.
   */
  private async labelsFor(refs: string[]): Promise<ApiLabel[]> {
    if (refs.every(isSystemLabelId)) return refs.map((id): ApiLabel => ({ id, name: id, type: "system" }));
    return ((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[];
  }

  async modifyIds(kind: "messages" | "threads", id: string, addLabelIds: string[], removeLabelIds: string[]) {
    const what = kind === "messages" ? "message" : "thread";
    const res = await this.client.request("POST", `${kind}/${checkId(id, what)}/modify`, { json: { addLabelIds, removeLabelIds } });
    return this.modifyResult(kind, res);
  }

  /**
   * Adds and removes labels (IDs or names, resolved once) on each of several messages or threads.
   * TRASH and SPAM are refused: moving to Trash or Spam goes through move_to.
   */
  async changeLabels(kind: "messages" | "threads", ids: string[], add: string[] | undefined, remove: string[] | undefined) {
    const refs = [...(add ?? []), ...(remove ?? [])];
    const moving = refs.find((ref) => /^(trash|spam)$/i.test(ref.trim()));
    if (moving) {
      throw new MimeError(`${moving.trim().toUpperCase()} isn't changed with change_labels: use move_to (destination trash, out_of_trash, spam or not_spam).`);
    }
    if (!refs.length) throw new MimeError("Provide at least one label to add or remove.");
    const targets = checkTargets(kind, ids);
    const labels = await this.labelsFor(refs);
    const addLabelIds = await this.resolveLabelIds(add, labels);
    const removeLabelIds = await this.resolveLabelIds(remove, labels);
    return this.changeEach(kind, targets, { addLabelIds, removeLabelIds });
  }

  /**
   * Moves several messages or threads: to Trash or out of it with Gmail's trash and untrash calls,
   * and to Spam, out of Spam or to the inbox by changing labels (as Gmail's own buttons do).
   */
  async moveTo(kind: "messages" | "threads", ids: string[], destination: MoveDestination) {
    const targets = checkTargets(kind, ids);
    if (destination === "trash" || destination === "out_of_trash") return this.changeEach(kind, targets, destination === "trash" ? "trash" : "untrash");
    const change = MOVES[destination];
    return this.changeEach(kind, targets, change);
  }

  /**
   * Applies one change to each target. A single target is one plain call (its errors are thrown);
   * several go through Gmail's batch endpoint, one request per 50 messages or 25 threads (a thread
   * change costs Gmail twice the quota), and each target that fails is reported with its error.
   */
  private async changeEach(
    kind: "messages" | "threads",
    ids: string[],
    change: { addLabelIds: string[]; removeLabelIds: string[] } | "trash" | "untrash",
  ): Promise<{ changed: ReturnType<Mailbox["modifyResult"]>[]; failed: { id: string; error: string }[]; notFound?: boolean }> {
    if (ids.length === 1) {
      const [id] = ids;
      const result =
        typeof change === "string" ? await this.trash(kind, id, change === "untrash") : await this.modifyIds(kind, id, change.addLabelIds, change.removeLabelIds);
      return { changed: [result], failed: [] };
    }
    const results = await this.client.batchGet(
      ids.map((id) => (typeof change === "string" ? { path: `${kind}/${id}/${change}`, method: "POST" as const } : { path: `${kind}/${id}/modify`, json: change })),
      kind === "threads" ? 25 : 50,
    );
    const changed: ReturnType<Mailbox["modifyResult"]>[] = [];
    const failed: { id: string; error: string }[] = [];
    let notFound = false;
    results.forEach((r, i) => {
      if (r.ok) changed.push(this.modifyResult(kind, r.value));
      else if (r.error.status === 404 || (r.error.status === 400 && /invalid id/i.test(r.error.message))) {
        notFound = true;
        failed.push({ id: ids[i], error: "not found in this account" });
      } else failed.push({ id: ids[i], error: r.error.message });
    });
    return { changed, failed, ...(notFound ? { notFound } : {}) };
  }

  // ---------- contacts ----------

  /**
   * Who appears on the newest emails (up to `limit`, drafts left out) sent to, from or copying someone
   * matching every word of `phrase` (see contactPhrase): every address in From, To and Cc but the user's own, with
   * how many of those emails it was on, the newest, and whether the user sent or received them. Three
   * Gmail calls at most for 100 emails: the search and two metadata batches.
   */
  async scanContacts(phrase: string, limit: number) {
    // Each word quoted, so the words match in any order ("Ruiz, Angelica") and none is read as an operator.
    const words = phrase
      .split(" ")
      .map((w) => `"${w}"`)
      .join(" ");
    const q = `(from:(${words}) OR to:(${words}) OR cc:(${words})) -in:draft`;
    const page = await this.client.request("GET", "messages", { query: { q, maxResults: limit } });
    const ids = ((page.messages ?? []) as { id: string }[]).map((m) => m.id).slice(0, limit);
    const fetched = await this.client.batchGet<ApiMessage>(
      ids.map((id) => ({ path: `messages/${id}`, query: { format: "metadata", metadataHeaders: CONTACT_HEADERS } })),
    );
    const { found, failed } = settle(ids, fetched);
    const tallies = new Map<string, ContactTally>();
    const own = new Set(this.ownAddresses().map(canonicalAddress));
    for (const { value: msg } of found) {
      if (msg.labelIds?.includes("DRAFT")) continue;
      const from = parseMailboxes(contactHeader(msg, "From"))[0];
      const sent = Boolean(msg.labelIds?.includes("SENT")) || (from !== undefined && own.has(canonicalAddress(from.address)));
      const internal = Number(msg.internalDate);
      const time = msg.internalDate && Number.isFinite(internal) ? internal : Date.parse(header(msg.payload, "Date") ?? "") || 0;
      const onThis = new Set<string>();
      const recipients = [...parseMailboxes(contactHeader(msg, "To")), ...parseMailboxes(contactHeader(msg, "Cc"))].slice(0, CONTACT_RECIPIENTS);
      for (const person of from ? [from, ...recipients] : recipients) {
        const key = canonicalAddress(person.address);
        if (onThis.has(key) || own.has(key) || !isValidAddress(person.address)) continue;
        onThis.add(key);
        const name = person.name && !sameMailbox(person.name, person.address) ? person.name.slice(0, 200) : undefined;
        addContact(tallies, {
          address: person.address,
          ...(name ? { name } : {}),
          nameTime: name ? time : -1,
          names: name ? [name] : [],
          time,
          sent,
          received: !sent,
          messages: 1,
          accounts: [this.email],
        });
      }
    }
    return { tallies, ...(failed.length ? { unavailable: failed.map((f) => f.id) } : {}) };
  }

  // ---------- filters ----------

  /** A filter as results show it: criteria as Gmail has them, actions as named actions (see FilterActions). */
  private describeFilter(f: ApiFilter, names: ReadonlyMap<string, string>) {
    const criteria = Object.fromEntries(Object.entries(f.criteria ?? {}).filter(([, v]) => v !== undefined && v !== "" && v !== false));
    let add = [...(f.action?.addLabelIds ?? [])];
    let remove = [...(f.action?.removeLabelIds ?? [])];
    const actions: Record<string, unknown> = {};
    for (const { action, add: a, remove: r } of FILTER_FLAGS) {
      if (a && add.includes(a)) {
        actions[action] = true;
        add = add.filter((id) => id !== a);
      }
      if (r && remove.includes(r)) {
        actions[action] = true;
        remove = remove.filter((id) => id !== r);
      }
    }
    const category = add.find((id) => id.startsWith("CATEGORY_"));
    if (category) {
      actions.category = category === "CATEGORY_PERSONAL" ? "primary" : category.slice("CATEGORY_".length).toLowerCase();
      add = add.filter((id) => id !== category);
    }
    if (add.length) actions.addLabels = add.map((id) => names.get(id) ?? id);
    if (remove.length) actions.removeLabels = remove.map((id) => names.get(id) ?? id);
    if (f.action?.forward) actions.forward = f.action.forward;
    return { id: f.id, criteria, actions };
  }

  /** The account's filters (users.settings.filters.list, which gmail.modify allows), with label names. */
  async listFilters() {
    const res = await this.client.request("GET", "settings/filters");
    const filters = (res?.filter ?? []) as ApiFilter[];
    const names = await this.labelNames(filters.map((f) => [...(f.action?.addLabelIds ?? []), ...(f.action?.removeLabelIds ?? [])]));
    return { filters: filters.map((f) => this.describeFilter(f, names)) };
  }

  /**
   * Creates a filter, or with `preview` only counts the existing emails it matches (up to
   * FILTER_PREVIEW_MAX, with the newest few as examples). Labels to add must exist already.
   */
  async createFilter(criteria: FilterCriteria, actions: FilterActions, opts: { preview?: boolean } = {}) {
    const clean = Object.fromEntries(
      Object.entries(criteria).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v !== undefined && v !== "" && v !== false),
    ) as FilterCriteria;
    const { sizeComparison: _c, excludeChats: _e, ...matching } = clean;
    if (!Object.keys(matching).length) {
      throw new MimeError("Give at least one criterion: from, to, subject, query, negatedQuery, hasAttachment or size.");
    }
    if ((clean.size === undefined) !== (clean.sizeComparison === undefined)) {
      throw new MimeError("size and sizeComparison go together: e.g. size 10485760 with sizeComparison \"larger\" for emails over 10 MB.");
    }
    if (actions.markImportant && actions.neverImportant) throw new MimeError("markImportant and neverImportant can't both be set.");
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];
    for (const { action, add, remove } of FILTER_FLAGS) {
      if (!actions[action]) continue;
      if (add) addLabelIds.push(add);
      if (remove) removeLabelIds.push(remove);
    }
    if (actions.category) addLabelIds.push(actions.category === "primary" ? "CATEGORY_PERSONAL" : `CATEGORY_${actions.category.toUpperCase()}`);
    if (actions.addLabels?.length) {
      const labels = ((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[];
      this.rememberLabels(labels);
      const missing: string[] = [];
      for (const ref of actions.addLabels) {
        const label = labels.find((l) => l.id === ref) ?? labels.find((l) => l.name.toLowerCase() === ref.trim().toLowerCase());
        if (label) addLabelIds.push(label.id);
        else missing.push(ref);
      }
      if (missing.length) {
        const own = labels.filter((l) => l.type !== "system").map((l) => l.name).sort((a, b) => a.localeCompare(b));
        throw new MimeError(
          `${missing.map((m) => `"${m}"`).join(", ")} ${missing.length === 1 ? "isn't a label" : "aren't labels"} in ${this.email}. ` +
            `Its labels: ${own.length ? own.join(", ") : "none yet"}. A filter can only add a label that exists: create it with create_label first (after asking the user).`,
        );
      }
    }
    if (!addLabelIds.length && !removeLabelIds.length) {
      throw new MimeError("Give at least one action: addLabels, archive, markRead, star, markImportant, neverImportant, trash, neverSpam or category.");
    }
    const body = { criteria: clean, action: { ...(addLabelIds.length ? { addLabelIds } : {}), ...(removeLabelIds.length ? { removeLabelIds } : {}) } };
    const query = filterQuery(clean);
    const names = await this.labelNames([addLabelIds]);
    const filter = this.describeFilter({ id: "", ...body }, names);
    if (opts.preview) {
      const list = await this.client.request("GET", "messages", { query: { q: query, maxResults: FILTER_PREVIEW_MAX } });
      const ids = ((list.messages ?? []) as { id: string }[]).map((m) => m.id);
      const fetched = await this.client.batchGet<ApiMessage>(
        ids.slice(0, 5).map((id) => ({ path: `messages/${id}`, query: { format: "metadata", metadataHeaders: ["From", "Subject"] } })),
      );
      const examples = fetched.flatMap((r) =>
        r.ok
          ? [{ from: header(r.value.payload, "From") ?? "", subject: stripInvisible(header(r.value.payload, "Subject") ?? "").trim(), ...(isoTime(r.value.internalDate) ? { date: isoTime(r.value.internalDate) } : {}) }]
          : [],
      );
      return {
        preview: true,
        criteria: filter.criteria,
        actions: filter.actions,
        query,
        existingMatches: list.nextPageToken ? `more than ${FILTER_PREVIEW_MAX}` : ids.length,
        ...(examples.length ? { examples } : {}),
        note: "Nothing was created. The filter will apply to new mail only; bulk_update or bulk_trash with `query` can apply the same change to the existing emails.",
      };
    }
    const created = (await this.client.request("POST", "settings/filters", { json: body })) as ApiFilter;
    return {
      created: { ...filter, id: created.id },
      query,
      note: "The filter applies to new mail. Existing emails are unchanged: bulk_update or bulk_trash with `query` can change them.",
    };
  }

  /** Deletes a filter, returning what it did. */
  async deleteFilter(filterId: string) {
    const id = checkId(filterId, "filter");
    const gone = (err: unknown): never => {
      if (err instanceof GmailApiError && err.status === 404) {
        throw new MimeError(`Filter ${filterId} doesn't exist in ${this.email} (see list_filters; IDs belong to one account).`);
      }
      throw err;
    };
    const filter = (await this.client.request("GET", `settings/filters/${id}`).catch(gone)) as ApiFilter;
    await this.client.request("DELETE", `settings/filters/${id}`).catch(gone);
    const names = await this.labelNames([[...(filter.action?.addLabelIds ?? []), ...(filter.action?.removeLabelIds ?? [])]]);
    return { deleted: this.describeFilter(filter, names) };
  }

  // ---------- attachments ----------

  /**
   * The bytes of an attachment, fetched as bytes and decoded straight from the answer (no JSON
   * parsing, no string of the file), so the peak memory is about the file plus a third.
   */
  private async attachmentBytes(messageId: string, attachmentId: string): Promise<Buffer> {
    const json = await this.client.getBytes(`messages/${checkId(messageId, "message")}/attachments/${checkId(attachmentId, "attachment")}`);
    return decodeBase64Url(attachmentDataOf(json));
  }

  /**
   * A message's structure (headers, parts, attachment IDs and sizes) with the bodies' `data` left
   * out: fetched as bytes and parsed after blanking the data (see withoutBodyData).
   */
  private async getMessageSkeleton(messageId: string): Promise<ApiMessage> {
    const json = await this.client.getBytes(`messages/${checkId(messageId, "message")}`, { format: "full" });
    return JSON.parse(new TextDecoder().decode(withoutBodyData(json))) as ApiMessage;
  }

  /**
   * Finds one attachment of a message without downloading it: by `partId` (stable), `filename`, or
   * `attachmentId`; with none of these, a message's only attachment. Only the message's part tree
   * is read (no body is decoded or even parsed). `download()` then fetches the file's bytes.
   */
  async findAttachment(messageId: string, ref: { partId?: string; filename?: string; attachmentId?: string }) {
    const msg = await this.getMessageSkeleton(messageId);
    const attachments = listAttachments(msg.payload);
    const byName = ref.filename?.trim().toLowerCase();
    const attachment =
      (ref.partId !== undefined && attachments.find((a) => a.partId === ref.partId)) ||
      (byName && attachments.find((a) => a.filename.toLowerCase() === byName)) ||
      (ref.attachmentId && attachments.find((a) => a.id === ref.attachmentId)) ||
      (!ref.partId && !byName && !ref.attachmentId && attachments.length === 1 ? attachments[0] : undefined);
    // Gmail issues new attachment IDs on every read, but old ones keep working, so a stale ID is still
    // usable. Its name and type are recovered from the attachment of the same size (or the only one),
    // since the file's type decides how it can be read; that takes the download.
    if (!attachment && ref.attachmentId) {
      const bytes = await this.attachmentBytes(msg.id, ref.attachmentId);
      const sameSize = attachments.filter((a) => a.size === bytes.length);
      const match = sameSize.length === 1 ? sameSize[0] : attachments.length === 1 ? attachments[0] : undefined;
      const fallback: AttachmentInfo = { id: ref.attachmentId, filename: "attachment", mimeType: "application/octet-stream", size: bytes.length, inline: false };
      return { info: match ?? fallback, message: msg, download: async () => bytes };
    }
    if (!attachment) {
      const list = attachments.map((a) => `${a.filename} (partId ${a.partId})`).join(", ") || "none";
      throw new MimeError(`No matching attachment on message ${messageId}. Its attachments: ${list}.`);
    }
    const download = async () => {
      if (attachment.id) return this.attachmentBytes(msg.id, attachment.id);
      // A file kept inline in the message (rare: Gmail stores attachments separately) was blanked
      // out with the bodies, so the message is read once more for it.
      const full = attachment.size ? await this.getRawMessage(messageId, "full") : msg;
      return Buffer.from(findPart(full, attachment.partId)?.body?.data ?? "", "base64url");
    };
    return { info: attachment, message: msg, download };
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
      // A From header that isn't a plain address (a crafted one can hold search operators or quotes)
      // can't be searched for or unsubscribed from safely, so it is left out like this account's own mail.
      if (!address || address === self || !isValidAddress(address) || address.includes('"')) continue;
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
      // IDs Gmail doesn't know are nearly always another account's; saying so beats a silent 0.
      const notFound = threadIds.filter((_, i) => !fetched[i].ok && fetched[i].error.status === 404);
      if (notFound.length === threadIds.length) {
        throw new MimeError(`None of the ${threadIds.length} thread ID(s) exist in ${this.email}. ${WRONG_ACCOUNT_HINT}`);
      }
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
      return { kind: "threads", threadIds, ids, more: remainingThreadIds.length > 0, remainingThreadIds, threadOf, notFound, ...unavailable("threadIds", failed) };
    }
    const ids = [...new Set((sel.messageIds ?? []).map((id) => checkId(id, "message")))];
    return { kind: "messages", ids: ids.slice(0, max), more: ids.length > max, remainingMessageIds: ids.slice(max) };
  }

  /** Adds and removes labels on many messages using Gmail's batchModify (1,000 messages per call). */
  async bulkModify(sel: BulkSelector, change: { add: string[]; remove: string[] }, opts: { max: number; dryRun: boolean }) {
    // Check IDs before any call, so a bad one doesn't leave the change half done.
    sel.threadIds?.forEach((id) => checkId(id, "thread"));
    sel.messageIds?.forEach((id) => checkId(id, "message"));
    const labels = await this.labelsFor([...change.add, ...change.remove]);
    const add = await this.resolveLabels(change.add, labels);
    const remove = await this.resolveLabels(change.remove, labels);
    const selection = await this.selectMessages(sel, { add, remove }, opts.max);
    const { ids } = selection;
    const missing = (notFound: string[]) => (notFound.length ? { notFound, hint: WRONG_ACCOUNT_HINT } : {});
    const extra = {
      ...bulkLeftOver(selection, opts.max).fields,
      ...(selection.unavailable ? { unavailable: selection.unavailable } : {}),
      ...(selection.kind === "threads" ? missing(selection.notFound) : {}),
    };
    if (opts.dryRun) {
      const sample = ids.slice(0, BULK_PREVIEW);
      const fetched = await this.client.batchGet<ApiMessage>(
        sample.map((id) => ({ path: `messages/${id}`, query: { format: "metadata", metadataHeaders: ["Subject", "From", "Date"] } })),
      );
      // Given message IDs are only looked at here (the change itself is one batch call), so the
      // preview is where a wrong account shows up.
      const notFound = selection.kind === "messages" ? sample.filter((_, i) => !fetched[i].ok && fetched[i].error.status === 404) : [];
      if (notFound.length && notFound.length === sample.length) {
        throw new MimeError(`None of the first ${sample.length} message ID(s) exist in ${this.email}. ${WRONG_ACCOUNT_HINT}`);
      }
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
      return { dryRun: true, wouldChange: ids.length, ...extra, ...missing(notFound), preview };
    }
    const addLabelIds = add.map((l) => l.id);
    const removeLabelIds = remove.map((l) => l.id);
    // Which labels each email had, so the result can say exactly what changed (for undo).
    const before = await this.labelsBefore(selection, addLabelIds, removeLabelIds);
    const changes = (count: number) => ({ [LABEL_CHANGES]: this.labelChanges(ids.slice(0, count), addLabelIds, removeLabelIds, before) });
    let changed = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      try {
        await this.client.request("POST", "messages/batchModify", { json: { ids: chunk, addLabelIds, removeLabelIds } });
      } catch (err) {
        // Gmail refuses the whole batch when an ID is unknown (400 or 404): usually another account's.
        const wrongId = selection.kind === "messages" && err instanceof GmailApiError && (err.status === 400 || err.status === 404);
        if (!changed) throw wrongId ? new MimeError(`${err.message} ${WRONG_ACCOUNT_HINT}`) : err;
        // Part of the change went through: say exactly how much, and how to finish.
        const left = ids.slice(i);
        const rest = bulkLeftOver(selection, opts.max, left);
        const finish = rest.resume ? `${rest.resume[0].toUpperCase()}${rest.resume.slice(1)} to finish.` : "Run the same change again to finish.";
        return {
          changed,
          notChanged: left.length,
          error: `Stopped after changing ${changed} of ${ids.length} emails: ${(err as Error).message} ${wrongId ? `${WRONG_ACCOUNT_HINT} ` : ""}${finish}`,
          ...extra,
          ...rest.fields,
          ...changes(changed),
        };
      }
      changed += chunk.length;
    }
    return { changed, ...extra, ...changes(changed) };
  }

  async trash(kind: "messages" | "threads", id: string, untrash = false) {
    const what = kind === "messages" ? "message" : "thread";
    const res = await this.client.request("POST", `${kind}/${checkId(id, what)}/${untrash ? "untrash" : "trash"}`);
    return this.modifyResult(kind, res);
  }

  private modifyResult(kind: "messages" | "threads", res: any) {
    if (kind === "messages") return { id: res.id, threadId: res.threadId, labelIds: res.labelIds ?? [] };
    // Listing every message's labels would repeat the same few IDs a hundred times for a long thread.
    const messages = (res.messages ?? []) as ApiMessage[];
    return { id: res.id, messagesChanged: messages.length, labelIds: [...new Set(messages.flatMap((m) => m.labelIds ?? []))] };
  }

  // ---------- activity log & undo ----------

  /**
   * What the emails of a bulk change had before it, for labelChanges: "all" when every one of them
   * is known to need the whole change (a search or thread selection, which only holds emails that
   * need it, of a one-label change), else their labels read in one batch per 50 emails (up to
   * LABELS_BEFORE_MAX emails), else undefined (unknown).
   */
  private async labelsBefore(selection: Selection, add: string[], remove: string[]): Promise<Map<string, string[]> | "all" | undefined> {
    const filtered = selection.kind === "threads" || (selection.kind === "query" && selection.resumable);
    if (filtered && add.length + remove.length === 1) return "all";
    if (!selection.ids.length || selection.ids.length > LABELS_BEFORE_MAX) return undefined;
    try {
      return (await this.labelSnapshot({ messageIds: selection.ids })).labels;
    } catch {
      return undefined; // the change itself still runs
    }
  }

  /**
   * The label changes made to `ids`, grouped by what each email actually gained and lost, given what
   * they had before (see labelsBefore). Emails whose labels weren't known get the whole change,
   * marked `approximate`.
   */
  private labelChanges(ids: string[], add: string[], remove: string[], before: Map<string, string[]> | "all" | undefined): LabelChange[] {
    const groups = new Map<string, LabelChange>();
    for (const id of ids) {
      const had = before instanceof Map ? before.get(id) : undefined;
      const approximate = before !== "all" && had === undefined;
      const added = had ? add.filter((l) => !had.includes(l)) : add;
      const removed = had ? remove.filter((l) => had.includes(l)) : remove;
      if (!added.length && !removed.length) continue;
      const key = JSON.stringify([added, removed, approximate]);
      let group = groups.get(key);
      if (!group) {
        group = { account: this.email, messageIds: [], added, removed, ...(approximate ? { approximate } : {}) };
        groups.set(key, group);
      }
      group.messageIds.push(id);
    }
    return [...groups.values()];
  }

  /**
   * The labels of the given messages and of every message in the given threads (one batch call per
   * 50 IDs), keyed by message ID, with up to three subjects (`subjects`). IDs that can't be read are
   * left out.
   */
  async labelSnapshot(targets: { messageIds?: string[]; threadIds?: string[] }, opts: { subjects?: boolean } = {}) {
    const query = opts.subjects ? { format: "metadata", metadataHeaders: ["Subject"] } : { format: "minimal" };
    const fetched = await this.client.batchGet<ApiMessage & { messages?: ApiMessage[] }>([
      ...(targets.messageIds ?? []).map((id) => ({ path: `messages/${checkId(id, "message")}`, query })),
      ...(targets.threadIds ?? []).map((id) => ({ path: `threads/${checkId(id, "thread")}`, query })),
    ]);
    const labels = new Map<string, string[]>();
    const subjects: string[] = [];
    for (const r of fetched) {
      if (!r.ok) continue;
      const messages = r.value.messages ?? [r.value];
      for (const m of messages) labels.set(m.id, m.labelIds ?? []);
      const subject = header(messages[0]?.payload, "Subject")?.trim();
      if (subject && subjects.length < 3 && !subjects.includes(subject)) subjects.push(subject);
    }
    return { labels, subjects };
  }

  /**
   * Reverses a label change: takes `added` off the emails and puts `removed` back, 1,000 per call.
   * Gmail refuses a whole call when one email no longer exists (e.g. deleted for good from Trash),
   * so those are found, left out and listed under `missing`.
   */
  async revertLabelChange(change: { messageIds: string[]; added: string[]; removed: string[] }): Promise<{
    restored: number;
    missing: string[];
    notRestored?: number;
    error?: string;
  }> {
    const ids = change.messageIds;
    const missing: string[] = [];
    let restored = 0;
    const modify = (chunk: string[]) =>
      this.client.request("POST", "messages/batchModify", { json: { ids: chunk, addLabelIds: change.removed, removeLabelIds: change.added } });
    for (let i = 0; i < ids.length; i += 1000) {
      let chunk = ids.slice(i, i + 1000);
      try {
        await modify(chunk);
      } catch (err) {
        const stop = (e: unknown) => ({ restored, missing, notRestored: ids.length - restored - missing.length, error: (e as Error).message });
        if (!(err instanceof GmailApiError && (err.status === 400 || err.status === 404))) return stop(err);
        let present: Map<string, string[]>;
        try {
          present = (await this.labelSnapshot({ messageIds: chunk })).labels;
        } catch {
          return stop(err);
        }
        const gone = chunk.filter((id) => !present.has(id));
        if (!gone.length) return stop(err);
        missing.push(...gone);
        chunk = chunk.filter((id) => present.has(id));
        if (chunk.length) {
          try {
            await modify(chunk);
          } catch (again) {
            return stop(again);
          }
        }
      }
      restored += chunk.length;
    }
    return { restored, missing };
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

/** `obj` with `extra`'s entries inserted before its `index`-th key. */
function insertAt(obj: Record<string, unknown>, index: number, extra: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(obj);
  return Object.fromEntries([...entries.slice(0, index), ...Object.entries(extra), ...entries.slice(index)]);
}

/**
 * Keeps a thread's bodies within `budget` characters (0: no limit): the oldest bodies are cut to their
 * first BUDGET_PREVIEW_CHARS characters (their HTML left out), and if that isn't enough, left out,
 * until the rest fits; the latest email always keeps its body. Returns the IDs of the messages cut.
 */
function fitBudget(messages: FormattedMessage[], budget: number): string[] {
  if (!budget) return [];
  const size = (m: FormattedMessage) => (m.plaintextBody?.length ?? 0) + (m.htmlBody?.length ?? 0);
  let total = messages.reduce((n, m) => n + size(m), 0);
  const cut = new Set<string>();
  for (const pass of ["preview", "drop"] as const) {
    for (const m of messages.slice(0, -1)) {
      if (total <= budget) break;
      const before = size(m);
      const text = m.plaintextBody ?? "";
      if (pass === "preview" && text.length <= BUDGET_PREVIEW_CHARS && m.htmlBody === undefined) continue;
      m.plaintextBody = pass === "preview" ? preview(text, BUDGET_PREVIEW_CHARS) : "";
      delete m.htmlBody;
      total -= before - size(m);
      cut.add(m.id);
    }
  }
  return messages.filter((m) => cut.has(m.id)).map((m) => m.id);
}

/** Set on bulkModify's result: the label changes it made, per group of emails (not shown to Claude; for undo). */
export const LABEL_CHANGES = Symbol("labelChanges");

/** Labels added to and removed from some emails of one account, as changed (IDs, not names). */
export interface LabelChange {
  account: string;
  messageIds: string[];
  added: string[];
  removed: string[];
  /** The emails' labels before weren't known: some may have had a label added here, or lacked one removed. */
  approximate?: boolean;
}

/** Most emails whose labels a bulk change reads first (one batch call per 50), to record exactly what it changed. */
const LABELS_BEFORE_MAX = 300;
