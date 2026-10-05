import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { AccountError, describeAccount, findAccount, type AccountSource, type LinkedAccount } from "./accounts.js";
import { GmailApiError, GmailClient, TokenProvider } from "./gmailClient.js";
import { AuthError, defaultFetch, type FetchLike } from "./google.js";
import { attachmentResult, FileTooLargeError, kindOf, readOffice, readPdf, readTextFile, sniffType, type ReadResult } from "./attachments.js";
import { attachmentCharset, DEFAULT_MAX_BODY_CHARS, viewUrl } from "./format.js";
import {
  isPrivateAddress,
  Mailbox,
  mapLimit,
  unsafeUnsubscribeHost,
  unsubscribeOptions,
  type SenderGroup,
  type UnsubscribeOptions,
} from "./mailbox.js";

export const SERVER_NAME = "gmail-multi";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `This server connects several Gmail accounts at once.
- Call list_accounts to see which accounts are linked (email + optional alias like "work").
- search_threads, list_drafts and list_labels cover every linked account when \`account\` is omitted. search_threads merges the results into one list, newest first, and each thread's \`account\` says which inbox it's in; list_drafts and list_labels group results by account.
- Message, thread, draft and label IDs belong to one account. When you act on an ID, pass the same \`account\` that returned it.
- send_message, reply and forward require \`account\` whenever more than one account is linked. If the user has not said which address to send from, ask them.`;

/** Resolves the `account` argument of a tool call to one or more mailboxes. */
export class AccountRouter {
  private mailboxes = new Map<string, Mailbox>();

  constructor(
    readonly store: AccountSource,
    private tokens: TokenProvider,
    private fetchImpl: FetchLike = defaultFetch,
    private manageHint = LOCAL_MANAGE_HINT,
  ) {}

  private mailbox(account: LinkedAccount): Mailbox {
    const key = `${account.email}\n${account.refreshToken}`;
    let mb = this.mailboxes.get(key);
    if (!mb) {
      mb = new Mailbox(new GmailClient(account, this.tokens, this.fetchImpl));
      this.mailboxes.set(key, mb);
    }
    return mb;
  }

  private async load() {
    const data = await this.store.load();
    if (!data.accounts.length) {
      throw new AccountError(`No Gmail accounts are linked yet. ${this.manageHint}`);
    }
    return data;
  }

  async one(ref: string | undefined, opts: { sending?: boolean } = {}): Promise<Mailbox> {
    const data = await this.load();
    if (ref?.trim().toLowerCase() === "all") {
      throw new AccountError('This tool works on one account at a time; "all" is only valid for search/list tools.');
    }
    if (ref?.trim()) return this.mailbox(findAccount(data, ref));
    if (data.accounts.length === 1) return this.mailbox(data.accounts[0]);
    const choices = data.accounts.map(describeAccount).join(", ");
    if (opts.sending) {
      throw new AccountError(
        `More than one Gmail account is linked, so \`account\` is required when sending. Choose one of: ${choices}.`,
      );
    }
    if (data.defaultAccount) return this.mailbox(findAccount(data, data.defaultAccount));
    throw new AccountError(`More than one Gmail account is linked; pass \`account\` (one of: ${choices}).`);
  }

  async many(ref: string | undefined): Promise<Mailbox[]> {
    if (ref?.trim() && ref.trim().toLowerCase() !== "all") return [await this.one(ref)];
    return (await this.load()).accounts.map((a) => this.mailbox(a));
  }
}

const MULTI_TOKEN_PREFIX = "multi:";

function encodeMultiToken(tokens: Record<string, string>): string | undefined {
  return Object.keys(tokens).length
    ? MULTI_TOKEN_PREFIX + Buffer.from(JSON.stringify(tokens)).toString("base64url")
    : undefined;
}

function decodeMultiToken(token: string): Record<string, string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token.slice(MULTI_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    decoded = undefined;
  }
  const valid =
    decoded !== null &&
    typeof decoded === "object" &&
    !Array.isArray(decoded) &&
    Object.values(decoded as object).every((v) => typeof v === "string");
  if (!valid) throw new AccountError("Invalid pageToken. Start the search again without a pageToken.");
  return decoded as Record<string, string>;
}

/**
 * Runs a paginated list operation on one or many accounts. With several accounts the results are
 * grouped per account and `nextPageToken` is a combined token that continues every account at once.
 */
async function fanOut<T extends { nextPageToken?: string }>(
  mailboxes: Mailbox[],
  pageToken: string | undefined,
  fn: (mb: Mailbox, pageToken: string | undefined) => Promise<T>,
) {
  const combined = pageToken?.startsWith(MULTI_TOKEN_PREFIX) ?? false;
  if (pageToken && !combined && mailboxes.length > 1) {
    throw new AccountError(
      "This pageToken came from a single-account call. Pass the same `account` you used for that call.",
    );
  }
  if (!combined && mailboxes.length === 1) {
    const mb = mailboxes[0];
    return { account: mb.email, ...(await fn(mb, pageToken)) };
  }
  let targets = mailboxes.map((mb) => ({ mb, token: undefined as string | undefined }));
  if (combined) {
    const tokens = decodeMultiToken(pageToken!);
    const lower = new Map(Object.entries(tokens).map(([email, token]) => [email.toLowerCase(), token]));
    targets = mailboxes.filter((mb) => lower.has(mb.email.toLowerCase())).map((mb) => ({ mb, token: lower.get(mb.email.toLowerCase()) }));
    if (!targets.length) {
      throw new AccountError(
        "This pageToken doesn't continue any of the requested accounts. Use the same `account` as the call that returned it (or omit it).",
      );
    }
  }
  const next: Record<string, string> = {};
  const accounts = await Promise.all(
    targets.map(async ({ mb, token }) => {
      try {
        const { nextPageToken, ...rest } = await fn(mb, token);
        if (nextPageToken) next[mb.email] = nextPageToken;
        return { account: mb.email, ...rest, ...(nextPageToken ? { hasMore: true } : {}) };
      } catch (err) {
        // Keep this account's place, so the next page tries the same page again instead of dropping it.
        if (token) next[mb.email] = token;
        return { account: mb.email, error: (err as Error).message, ...(token ? { hasMore: true } : {}) };
      }
    }),
  );
  const nextPageToken = encodeMultiToken(next);
  return { accounts, ...(nextPageToken ? { nextPageToken } : {}) };
}

/** The newest date shown for a search result thread (its own date, or its latest listed message's). */
function threadTime(thread: { date?: string; messages?: { date?: string }[] }): number {
  const times = [thread.date, ...(thread.messages ?? []).map((m) => m.date)]
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : -Infinity;
}

/**
 * Turns a search of several accounts into one timeline, newest first, each thread saying which
 * account it's in. Problems with an account (errors, threads Gmail didn't return) and which accounts
 * have more results move to the top level. Sorting is per page, since each account pages on its own.
 */
function mergeTimeline(result: { accounts: Record<string, any>[]; nextPageToken?: string }) {
  const threads = result.accounts
    .flatMap((a) => ((a.threads ?? []) as Record<string, any>[]).map((t): Record<string, any> => ({ account: a.account as string, ...t })))
    .map((thread, order) => ({ thread, order, time: threadTime(thread) }))
    .sort((x, y) => y.time - x.time || x.order - y.order)
    .map(({ thread }) => thread);
  const errors = result.accounts.filter((a) => a.error).map((a) => ({ account: a.account, error: a.error }));
  const unavailable = result.accounts.filter((a) => a.unavailable).map((a) => ({ account: a.account, ...a.unavailable }));
  const withMore = result.accounts.filter((a) => a.hasMore).map((a) => a.account);
  return {
    threads,
    ...(errors.length ? { errors } : {}),
    ...(unavailable.length ? { unavailable } : {}),
    ...(withMore.length ? { accountsWithMore: withMore } : {}),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof GmailApiError && (err.status === 404 || err.status === 400) && /not found|invalid id/i.test(message)) {
    message +=
      " (Message, thread, draft and label IDs belong to a single Gmail account. Make sure `account` is the account that returned this ID.)";
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/** Like run(), for tools that return their own content blocks (e.g. text plus an image). */
async function runContent(fn: () => Promise<CallToolResult["content"]>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (err) {
    return fail(err);
  }
}

/** Images up to this size are returned for Claude to look at. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** PDFs without extractable text are returned as files up to this size, for clients that can read PDFs directly. */
const MAX_PDF_BYTES = 5 * 1024 * 1024;

/** Label changes behind each bulk action. */
const BULK_ACTIONS: Record<string, { add: string[]; remove: string[]; needsLabels?: "add" | "remove" }> = {
  archive: { add: [], remove: ["INBOX"] },
  move_to_inbox: { add: ["INBOX"], remove: ["TRASH", "SPAM"] },
  mark_read: { add: [], remove: ["UNREAD"] },
  mark_unread: { add: ["UNREAD"], remove: [] },
  star: { add: ["STARRED"], remove: [] },
  unstar: { add: [], remove: ["STARRED"] },
  add_labels: { add: [], remove: [], needsLabels: "add" },
  remove_labels: { add: [], remove: [], needsLabels: "remove" },
  trash: { add: ["TRASH"], remove: [] },
  spam: { add: ["SPAM"], remove: ["INBOX"] },
};

// ---------- shared schemas ----------

const accountArg = z
  .string()
  .optional()
  .describe(
    "Which linked Gmail account to use: its email address or alias (see list_accounts). Optional when only one account is linked or a default is set. IDs belong to one account, so pass the account that returned the ID.",
  );
const sendAccountArg = z
  .string()
  .optional()
  .describe(
    "Gmail account to send from: its email address or alias (see list_accounts). Required when more than one account is linked.",
  );
const multiAccountArg = z
  .string()
  .optional()
  .describe(
    'Email address or alias of one linked account, or "all". Defaults to all linked accounts, with results grouped per account.',
  );
const addressList = (what: string) =>
  z.array(z.string()).optional().describe(`Optional. ${what} Each string MUST be a plain email address (e.g. "user@example.com").`);
const messageFormatArg = z
  .enum(["MINIMAL", "PLAIN_TEXT", "FULL_CONTENT", "METADATA_ONLY", "RAW"])
  .optional()
  .describe(
    "Optional. Defaults to PLAIN_TEXT. MINIMAL: headers + snippet, no body. PLAIN_TEXT: headers + plain-text body (HTML converted to text; in get_message/get_thread, links over 200 characters are cut to their website) + attachment info. FULL_CONTENT: PLAIN_TEXT with full links, plus the HTML body. METADATA_ONLY: senders/recipients/date/labels only. RAW: the raw MIME message.",
  );
const maxBodyCharsArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Optional. Bodies longer than this many characters are shortened, with a `truncated` note saying how much was left out. Defaults to 20000; 0 means no limit.",
  );
const attachmentArg = z.object({
  content: z.string().describe("Required. The base64-encoded content of the attachment."),
  filename: z.string().optional().describe('Optional. File name shown to recipients, e.g. "invoice.pdf". Also used as the Content-ID of inline attachments.'),
  mimeType: z.string().optional().describe('Optional. IANA MIME type. Defaults to "application/octet-stream".'),
  inline: z.boolean().optional().describe("Optional. True to embed in the HTML body (reference it as cid:<filename>)."),
});
const attachmentsArg = z
  .array(attachmentArg)
  .optional()
  .describe("Optional. Attachments to include. The combined size cannot exceed 25MB.");
const bodyArg = z
  .string()
  .optional()
  .describe("Optional. Plain text body. Do NOT format with Markdown; use htmlBody for rich text. If htmlBody is also given, this is the plain-text alternative.");
const htmlBodyArg = z.string().optional().describe("Optional. HTML body for rich-text formatting (valid HTML tags).");
const labelIdsArg = z
  .array(z.string())
  .describe("Label IDs or display names, e.g. INBOX, STARRED, UNREAD, IMPORTANT, or a user label such as \"Receipts\". Labels are per account; see list_labels.");
const colorPresetArg = z
  .enum([
    "LABEL_COLOR_PRESET_BLACK",
    "LABEL_COLOR_PRESET_DARK_GRAY",
    "LABEL_COLOR_PRESET_GRAY",
    "LABEL_COLOR_PRESET_LIGHT_GRAY",
    "LABEL_COLOR_PRESET_WHITE",
    "LABEL_COLOR_PRESET_RED",
    "LABEL_COLOR_PRESET_ORANGE",
    "LABEL_COLOR_PRESET_YELLOW",
    "LABEL_COLOR_PRESET_GREEN",
    "LABEL_COLOR_PRESET_MINT",
    "LABEL_COLOR_PRESET_TEAL",
    "LABEL_COLOR_PRESET_BLUE",
    "LABEL_COLOR_PRESET_PURPLE",
    "LABEL_COLOR_PRESET_PINK",
    "LABEL_COLOR_PRESET_DARK_RED",
    "LABEL_COLOR_PRESET_DARK_ORANGE",
    "LABEL_COLOR_PRESET_DARK_GREEN",
    "LABEL_COLOR_PRESET_DARK_BLUE",
    "LABEL_COLOR_PRESET_DARK_PURPLE",
    "LABEL_COLOR_PRESET_DARK_PINK",
    "LABEL_COLOR_PRESET_BROWN",
  ])
  .optional()
  .describe("Optional. Label color.");
const labelListVisibilityArg = z
  .enum(["LABEL_SHOW", "LABEL_SHOW_IF_UNREAD", "LABEL_HIDE"])
  .optional()
  .describe("Optional. Visibility of the label in Gmail's label list.");
const messageListVisibilityArg = z
  .enum(["SHOW", "HIDE"])
  .optional()
  .describe("Optional. Visibility of the label on messages in Gmail's message list.");

const SEARCH_QUERY_HELP = `Optional. Gmail search syntax, e.g. "from:alice@example.com", "subject:invoice newer_than:7d", "is:unread in:inbox", "has:attachment", "label:Receipts", "after:2026/01/01". Use OR and ( ) to broaden. Natural language must be converted to Gmail syntax first. Drafts are excluded unless the query mentions in:draft.`;

export const LOCAL_MANAGE_HINT =
  "To link one, run `node dist/src/index.js accounts add` in the connector's folder (or `gmail-multi-mcp accounts add` after `npm link`), once per Gmail account.";

export interface ServerDeps {
  /** Where linked accounts (and their refresh tokens) are read from. */
  store: AccountSource;
  tokens: TokenProvider;
  fetchImpl?: FetchLike;
  /** Tells the user how to link or remove accounts (differs between the CLI and the hosted connector). */
  manageHint?: string;
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Fetch for requests to other websites (one-click unsubscribe). Defaults to the global fetch. */
  webFetch?: FetchLike;
  /** Looks up a host's IP addresses so private ones can be refused. Defaults to systemResolveHost. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/**
 * Looks up a host with the system resolver (Node). Skipped in Cloudflare Workers, whose fetch already
 * refuses private addresses (global_fetch_strictly_public) and where a lookup would cost a subrequest.
 */
export async function systemResolveHost(hostname: string): Promise<string[]> {
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers") return [];
  try {
    const dnsModule = "node:dns"; // not bundled: only Node gets here
    const dns = await import(dnsModule);
    return ((await dns.promises.lookup(hostname, { all: true })) as { address: string }[]).map((r) => r.address);
  } catch {
    return []; // unknown host: the request itself will fail
  }
}

/** How one sender will be unsubscribed from, or why it can't be. */
type UnsubscribePlan =
  | { method: "one-click"; url: string }
  | { method: "email"; mail: NonNullable<UnsubscribeOptions["mailto"]>; note?: string }
  | { method: "link"; link: string }
  | { method: "refused"; reason: string }
  | { method: "none" };

const NO_UNSUBSCRIBE_NOTE =
  "This sender's emails have no unsubscribe header. Clear them with bulk_trash or bulk_update, or set up a Gmail filter for this sender.";
const ONE_CLICK_TIMEOUT_MS = 10_000;

export function createServer(deps: ServerDeps): McpServer {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const { store, tokens } = deps;
  const manageHint = deps.manageHint ?? LOCAL_MANAGE_HINT;
  const router = new AccountRouter(store, tokens, fetchImpl, manageHint);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: deps.jsonSchemaValidator },
  );

  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
  const sends = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  // ---------- accounts ----------

  server.registerTool(
    "list_accounts",
    {
      title: "List linked Gmail accounts",
      description:
        "Lists the Gmail accounts linked to this connector, with their aliases, which one is the default, and each account's `status`. Use the email or alias as the `account` argument of other tools. If an account's status is \"needs re-link\", tell the user and pass on its `hint`: that account won't work until they link it again. The result also says how the user can link or remove accounts.",
      inputSchema: {},
      annotations: read,
    },
    async () =>
      run(async () => {
        const data = await store.load();
        // Getting an access token shows whether Google still accepts the account's authorization
        // (tokens are cached, so this is usually free).
        const statuses = await Promise.all(
          data.accounts.map(async (a) => {
            try {
              await tokens.get(a);
              return { status: "ok" };
            } catch (err) {
              if (err instanceof AuthError && err.code === "invalid_grant") return { status: "needs re-link", hint: err.message };
              return { status: "couldn't check", error: (err as Error).message };
            }
          }),
        );
        return {
          accounts: data.accounts.map((a, i) => ({
            email: a.email,
            ...(a.alias ? { alias: a.alias } : {}),
            isDefault: data.defaultAccount ? a.email.toLowerCase() === data.defaultAccount.toLowerCase() : data.accounts.length === 1,
            ...statuses[i],
          })),
          manageAccounts: data.accounts.length ? manageHint : `No accounts linked yet. ${manageHint}`,
        };
      }),
  );

  // ---------- threads & messages ----------

  server.registerTool(
    "search_threads",
    {
      title: "Search email threads",
      description:
        "Searches email threads in one or all linked Gmail accounts. Without `account` (or with \"all\"), every linked account is searched and the results are merged into one `threads` list, newest first, where each thread's `account` says which inbox it's in: mention it to the user, and pass it back when opening the thread. Each account returns up to pageSize threads per page, so the order is newest first within each page; an account's problems are listed under `errors`, and `accountsWithMore` says which accounts have more. A thread with one email is shown flat (subject, sender, date, snippet, labels); longer threads list their 5 most recent messages under `messages`, and `totalMessages` says how many there are. Recipients are listed only when an email wasn't addressed to just that account. Use get_thread to read full bodies. For more results, pass the returned `nextPageToken` (it covers all accounts at once). Threads Gmail couldn't return just then are listed under `unavailable`; search again shortly to get them.",
      inputSchema: {
        account: multiAccountArg,
        query: z.string().optional().describe(SEARCH_QUERY_HELP),
        pageSize: z.number().int().min(1).max(50).optional().describe("Optional. Threads per account (default 20, max 50)."),
        pageToken: z.string().optional().describe("Optional. nextPageToken from a previous search_threads call with the same query and account."),
        includeTrash: z.boolean().optional().describe("Optional. Include threads in Trash/Spam. Defaults to false."),
        view: z
          .enum(["THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"])
          .optional()
          .describe("Optional. THREAD_VIEW_MINIMAL (default) includes subject and snippet; THREAD_VIEW_METADATA_ONLY omits them."),
      },
      annotations: read,
    },
    async (args) =>
      run(async () => {
        const result = await fanOut(await router.many(args.account), args.pageToken, (mb, pageToken) =>
          mb.searchThreads({ ...args, pageToken }),
        );
        return "accounts" in result ? mergeTimeline(result) : result;
      }),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get email thread",
      description:
        "Retrieves a full email thread (all messages, drafts omitted) from one Gmail account, including each message's `viewUrl`. Use the thread ID and `account` from search_threads. In PLAIN_TEXT, each reply's quoted copy of earlier messages is hidden, since those messages are in the result; get_message shows one email in full. With bodies, the thread's `subject` is given once; a message has its own `subject` only when it differs.",
      inputSchema: {
        account: accountArg,
        threadId: z.string().describe("Required. The thread ID."),
        messageFormat: messageFormatArg,
        maxBodyChars: maxBodyCharsArg,
      },
      annotations: read,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return {
          account: mb.email,
          ...(await mb.getThread(args.threadId, args.messageFormat ?? "PLAIN_TEXT", {
            maxBodyChars: args.maxBodyChars,
            shortenLinks: true,
            hideQuotedHistory: true,
          })),
        };
      }),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get email message",
      description:
        "Retrieves one email message by ID from one Gmail account, including attachment info and `viewUrl`. For whole conversations use get_thread; for drafts use get_draft.",
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe("Required. The message ID."),
        messageFormat: messageFormatArg,
        maxBodyChars: maxBodyCharsArg,
      },
      annotations: read,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return {
          account: mb.email,
          ...(await mb.getMessage(args.messageId, args.messageFormat ?? "PLAIN_TEXT", { maxBodyChars: args.maxBodyChars, shortenLinks: true })),
        };
      }),
  );

  // ---------- drafts ----------

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description:
        "Lists draft emails in one or all linked Gmail accounts (grouped by account when several). Returns draft IDs, recipients, dates and `viewUrl`; set view to DRAFT_VIEW_FULL to include subject and plain-text body. Drafts Gmail couldn't return just then are listed under `unavailable`.",
      inputSchema: {
        account: multiAccountArg,
        query: z.string().optional().describe("Optional. Gmail search syntax to filter drafts, e.g. \"subject:proposal\" or \"to:bob@example.com\"."),
        pageSize: z.number().int().min(1).max(50).optional().describe("Optional. Drafts per account (default 20, max 50)."),
        pageToken: z.string().optional().describe("Optional. nextPageToken from a previous list_drafts call."),
        view: z
          .enum(["DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"])
          .optional()
          .describe("Optional. DRAFT_VIEW_METADATA_ONLY (default) or DRAFT_VIEW_FULL (adds subject and plaintextBody)."),
      },
      annotations: read,
    },
    async (args) =>
      run(async () =>
        fanOut(await router.many(args.account), args.pageToken, (mb, pageToken) => mb.listDrafts({ ...args, pageToken })),
      ),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get draft",
      description: "Retrieves a draft by ID from one Gmail account, including its `viewUrl` for editing in Gmail.",
      inputSchema: {
        account: accountArg,
        draftId: z.string().describe("Required. The draft ID."),
        messageFormat: messageFormatArg,
        maxBodyChars: maxBodyCharsArg,
      },
      annotations: read,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return {
          account: mb.email,
          ...(await mb.getDraft(args.draftId, args.messageFormat ?? "PLAIN_TEXT", { maxBodyChars: args.maxBodyChars })),
        };
      }),
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description:
        "Creates a draft email in one Gmail account. To draft a reply, pass `replyToMessageId`: the draft is threaded with that message, addressed to its sender by default, and quotes the original. Returns the draft `id`, `threadId` and `viewUrl`.",
      inputSchema: {
        account: accountArg,
        to: addressList("Primary recipients."),
        cc: addressList("Cc recipients."),
        bcc: addressList("Bcc recipients."),
        subject: z.string().optional().describe("Optional. Subject line."),
        body: bodyArg,
        htmlBody: htmlBodyArg,
        attachments: attachmentsArg,
        replyToMessageId: z.string().optional().describe("Optional. ID of a message (in the same account) this draft replies to."),
      },
      annotations: write,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.createDraft(args)) };
      }),
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update draft",
      description:
        "Updates a draft in one Gmail account with merge semantics: non-empty fields replace the draft's values, omitted fields are kept. Giving only one of body/htmlBody clears the other. Existing attachments are kept unless `attachments` is given (pass an empty list to remove them).",
      inputSchema: {
        account: accountArg,
        draftId: z.string().describe("Required. The draft ID."),
        to: addressList("Primary recipients (replaces existing when non-empty)."),
        cc: addressList("Cc recipients (replaces existing when non-empty)."),
        bcc: addressList("Bcc recipients (replaces existing when non-empty)."),
        subject: z.string().optional().describe("Optional. New subject line."),
        body: bodyArg,
        htmlBody: htmlBodyArg,
        attachments: z
          .array(attachmentArg)
          .optional()
          .describe("Optional. Replaces the draft's attachments. Omit to keep the current ones; [] removes them."),
      },
      annotations: write,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.updateDraft(args)) };
      }),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete draft",
      description: "Permanently deletes a draft from one Gmail account.",
      inputSchema: { account: accountArg, draftId: z.string().describe("Required. The draft ID.") },
      annotations: destructive,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.deleteDraft(args.draftId)) };
      }),
  );

  // ---------- sending ----------

  server.registerTool(
    "send_message",
    {
      title: "Send email",
      description:
        "Sends an email immediately from the chosen Gmail account (`account` is required when several are linked). Either pass `draftId` to send an existing draft as is, or give recipients, subject and body. To send within an existing conversation, pass `replyThreadId` or `replyToMessageId` (from the same account). Returns the sent message's `id`, `threadId` and `labelIds`.",
      inputSchema: {
        account: sendAccountArg,
        draftId: z.string().optional().describe("Optional. ID of an existing draft to send; other content fields are then ignored."),
        to: addressList("Primary recipients. Required unless draftId, cc or bcc is given."),
        cc: addressList("Cc recipients."),
        bcc: addressList("Bcc recipients."),
        subject: z.string().optional().describe("Optional. Subject line."),
        body: bodyArg,
        htmlBody: htmlBodyArg,
        attachments: attachmentsArg,
        replyThreadId: z.string().optional().describe("Optional. Thread ID to send this message in."),
        replyToMessageId: z.string().optional().describe("Optional. Message ID this message replies to (sets threading headers)."),
      },
      annotations: sends,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account, { sending: true });
        return { account: mb.email, ...(await mb.sendMessage(args)) };
      }),
  );

  server.registerTool(
    "reply",
    {
      title: "Reply to email",
      description:
        "Replies to a message from the Gmail account that received it (`account` is required when several are linked). Replies to the sender by default, or to everyone with `replyAll`. The original message is quoted below your text and the reply stays in the same thread. To reply to a thread, use get_thread and pass the ID of its latest message.",
      inputSchema: {
        account: sendAccountArg,
        messageId: z.string().describe("Required. ID of the message to reply to."),
        body: bodyArg,
        htmlBody: htmlBodyArg,
        replyAll: z.boolean().optional().describe("Optional. Reply to all recipients. Defaults to false."),
        to: addressList("Overrides the default reply recipients."),
        cc: addressList("Overrides the default Cc recipients."),
        bcc: addressList("Bcc recipients."),
      },
      annotations: sends,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account, { sending: true });
        return { account: mb.email, ...(await mb.reply(args)) };
      }),
  );

  server.registerTool(
    "forward",
    {
      title: "Forward email",
      description:
        "Forwards a message (with its attachments) from the Gmail account that holds it (`account` is required when several are linked). Optional comments go above the forwarded content via `forwardText` (plain text) or `htmlBody`.",
      inputSchema: {
        account: sendAccountArg,
        messageId: z.string().describe("Required. ID of the message to forward."),
        to: addressList("Primary recipients."),
        cc: addressList("Cc recipients."),
        bcc: addressList("Bcc recipients."),
        forwardText: z.string().optional().describe("Optional. Plain text comments above the forwarded message. Do NOT format with Markdown."),
        htmlBody: z.string().optional().describe("Optional. HTML comments above the forwarded message."),
      },
      annotations: sends,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account, { sending: true });
        return { account: mb.email, ...(await mb.forward(args)) };
      }),
  );

  // ---------- labels ----------

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description:
        "Lists labels (system and user) with their IDs for one or all linked Gmail accounts. Label IDs differ between accounts.",
      inputSchema: { account: multiAccountArg },
      annotations: read,
    },
    async (args) =>
      run(async () => {
        const mailboxes = await router.many(args.account);
        if (mailboxes.length === 1) return { account: mailboxes[0].email, ...(await mailboxes[0].listLabels()) };
        return {
          accounts: await Promise.all(
            mailboxes.map(async (mb) => {
              try {
                return { account: mb.email, ...(await mb.listLabels()) };
              } catch (err) {
                return { account: mb.email, error: (err as Error).message };
              }
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create label",
      description:
        "Creates a label in one Gmail account. Nested labels use '/', e.g. 'Projects/Alpha'; missing parent labels are created automatically unless autoCreateParentLabels is false.",
      inputSchema: {
        account: accountArg,
        displayName: z.string().describe("Required. Label name; use '/' for nesting."),
        autoCreateParentLabels: z.boolean().optional().describe("Optional. Create missing parent labels. Defaults to true."),
        colorPreset: colorPresetArg,
        labelListVisibility: labelListVisibilityArg,
        messageListVisibility: messageListVisibilityArg,
      },
      annotations: write,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.createLabel(args)) };
      }),
  );

  server.registerTool(
    "update_label",
    {
      title: "Update label",
      description: "Renames a label or changes its color/visibility in one Gmail account.",
      inputSchema: {
        account: accountArg,
        labelId: z.string().describe("Required. Label ID or current display name."),
        displayName: z.string().optional().describe("Optional. New name."),
        colorPreset: colorPresetArg,
        labelListVisibility: labelListVisibilityArg,
        messageListVisibility: messageListVisibilityArg,
      },
      annotations: write,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.updateLabel(args.labelId, args)) };
      }),
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete label",
      description: "Deletes a user label from one Gmail account (messages keep existing, they just lose the label).",
      inputSchema: { account: accountArg, labelId: z.string().describe("Required. Label ID or display name.") },
      annotations: destructive,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.deleteLabel(args.labelId)) };
      }),
  );

  const labelTool = (
    name: string,
    kind: "messages" | "threads",
    mode: "add" | "remove",
    description: string,
  ) => {
    const idKey = kind === "messages" ? "messageId" : "threadId";
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          account: accountArg,
          [idKey]: z.string().describe(`Required. The ${kind === "messages" ? "message" : "thread"} ID.`),
          labelIds: labelIdsArg,
        } as { account: typeof accountArg; labelIds: typeof labelIdsArg } & Record<string, z.ZodString>,
        annotations: write,
      },
      async (args: Record<string, any>) =>
        run(async () => {
          const mb = await router.one(args.account);
          const id = args[idKey] as string;
          const result =
            mode === "add" ? await mb.modify(kind, id, args.labelIds, undefined) : await mb.modify(kind, id, undefined, args.labelIds);
          return { account: mb.email, ...result };
        }),
    );
  };

  labelTool("label_message", "messages", "add", "Adds labels to one message. To trash or mark as spam use trash_message / mark_message_spam.");
  labelTool("unlabel_message", "messages", "remove", "Removes labels from one message (e.g. remove UNREAD to mark as read, INBOX to archive).");
  labelTool("label_thread", "threads", "add", "Adds labels to every message in a thread. To trash or mark as spam use trash_thread / mark_thread_spam.");
  labelTool("unlabel_thread", "threads", "remove", "Removes labels from every message in a thread (e.g. remove UNREAD to mark as read, INBOX to archive).");

  server.registerTool(
    "update_message_labels",
    {
      title: "Add and remove message labels",
      description: "Atomically adds and/or removes labels on one message, e.g. to move it between labels in a single call.",
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe("Required. The message ID."),
        addLabelIds: labelIdsArg.optional(),
        removeLabelIds: labelIdsArg.optional(),
      },
      annotations: write,
    },
    async (args) =>
      run(async () => {
        const mb = await router.one(args.account);
        return { account: mb.email, ...(await mb.modify("messages", args.messageId, args.addLabelIds, args.removeLabelIds)) };
      }),
  );

  // ---------- attachments ----------

  server.registerTool(
    "get_attachment",
    {
      title: "Read attachment",
      description:
        "Reads an email attachment from one Gmail account. Text files, CSV, HTML, calendar invites, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) come back as text; images come back as images you can see; PDFs come back as text when it can be extracted, otherwise as the PDF file (for clients that read PDFs). Identify the attachment by `partId` or `filename` from get_message/get_thread (with neither, a message's only attachment is used).",
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe("Required. ID of the message the attachment is on."),
        partId: z.string().optional().describe("Optional. The attachment's partId from get_message/get_thread (preferred)."),
        filename: z.string().optional().describe("Optional. The attachment's file name."),
        attachmentId: z.string().optional().describe("Optional. The attachment's id from get_message/get_thread."),
        maxChars: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Optional. Longest text to return (default 20000; 0 for as much as can be read, up to 1,000,000 characters)."),
      },
      annotations: read,
    },
    async (args) =>
      runContent(async () => {
        const mb = await router.one(args.account);
        const { info, bytes, message } = await mb.getAttachment(args.messageId, args);
        const mimeType = sniffType(bytes, info.mimeType, info.filename);
        const kind = kindOf(mimeType, info.filename);
        const meta = {
          account: mb.email,
          messageId: args.messageId,
          filename: info.filename,
          mimeType,
          size: bytes.length,
          ...(info.partId !== undefined ? { partId: info.partId } : {}),
          viewUrl: viewUrl(mb.email, `all/${args.messageId}`),
        };
        const max = args.maxChars ?? DEFAULT_MAX_BODY_CHARS;
        const asText = (read: ReadResult, extra: Record<string, unknown> = {}): CallToolResult["content"] => {
          const { text, truncated } = attachmentResult(read, max);
          return [
            { type: "text", text: JSON.stringify({ ...meta, ...extra, ...(truncated ? { truncated } : {}) }) },
            { type: "text", text: text || "(The file contains no text.)" },
          ];
        };
        const withNote = (note: string): CallToolResult["content"] => [{ type: "text", text: JSON.stringify({ ...meta, note }) }];

        if (kind === "text") {
          const charset = attachmentCharset(message.payload, info.partId);
          return asText(readTextFile(bytes, mimeType, info.filename, { maxChars: max, charset }));
        }
        if (kind === "office") {
          try {
            return asText(await readOffice(bytes, { maxChars: max }));
          } catch (err) {
            if (err instanceof FileTooLargeError) return withNote(`${err.message} Open it in Gmail with viewUrl.`);
            return withNote("This Office file couldn't be read. Open it in Gmail with viewUrl.");
          }
        }
        if (kind === "image") {
          if (bytes.length > MAX_IMAGE_BYTES) return withNote("This image is too large to show here. Open it in Gmail with viewUrl.");
          return [
            { type: "text", text: JSON.stringify(meta) },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
          ];
        }
        if (kind === "pdf") {
          const read = await readPdf(bytes, { maxChars: max });
          if (read) return asText(read, { extracted: "Text extracted from the PDF; layout, images and tables may be simplified." });
          // Scanned PDFs (or ones with custom font encodings) have no usable text layer: send the file itself,
          // which clients that read PDFs can show to Claude.
          if (bytes.length > MAX_PDF_BYTES) {
            return withNote(
              "No readable text could be extracted from this PDF (it may be scanned or use special fonts), and it is too large to send as a file. Open it in Gmail with viewUrl.",
            );
          }
          return [
            ...withNote(
              "No readable text could be extracted from this PDF (it may be scanned or use special fonts). The PDF file is attached; if you can't see it, open it in Gmail with viewUrl.",
            ),
            {
              type: "resource",
              resource: {
                uri: `gmail://${encodeURIComponent(mb.email)}/messages/${args.messageId}/attachments/${encodeURIComponent(info.filename)}`,
                mimeType: "application/pdf",
                blob: Buffer.from(bytes).toString("base64"),
              },
            },
          ];
        }
        return withNote(`This type of file (${mimeType}) can't be read as text. Open it in Gmail with viewUrl.`);
      }),
  );

  // ---------- bulk changes ----------

  const bulkSelection = {
    account: z
      .string()
      .optional()
      .describe(
        'With `query`: one account (email or alias) or "all"; defaults to every linked account. With threadIds/messageIds: the one account those IDs belong to.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Gmail search selecting the emails, e.g. "category:promotions older_than:7d", "from:news@shop.com is:unread". Drafts are never included.',
      ),
    threadIds: z.array(z.string()).max(500).optional().describe("Optional. Change every email in these threads (the ones that don't have the change yet)."),
    messageIds: z.array(z.string()).max(1000).optional().describe("Optional. Change exactly these emails."),
    maxEmails: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Optional. Most emails to change per account per run (default 500). If more need the change, the result's `more` says how to continue (for IDs, it returns remainingThreadIds/remainingMessageIds).",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe("Optional. Count the emails that would change and preview the first 10, without changing anything."),
  };

  const runBulk = (args: {
    account?: string;
    query?: string;
    threadIds?: string[];
    messageIds?: string[];
    maxEmails?: number;
    dryRun?: boolean;
    action: string;
    labelIds?: string[];
  }) =>
    run(async () => {
      const selectors = [args.query !== undefined, Boolean(args.threadIds?.length), Boolean(args.messageIds?.length)];
      if (selectors.filter(Boolean).length !== 1) {
        throw new AccountError("Give exactly one of `query`, `threadIds` or `messageIds`.");
      }
      const action = BULK_ACTIONS[args.action];
      const add = [...action.add];
      const remove = [...action.remove];
      if (action.needsLabels) {
        if (!args.labelIds?.length) throw new AccountError(`The ${args.action} action needs \`labelIds\`.`);
        (action.needsLabels === "add" ? add : remove).push(...args.labelIds);
      }
      const opts = { max: args.maxEmails ?? 500, dryRun: Boolean(args.dryRun) };
      const sel = { query: args.query, threadIds: args.threadIds, messageIds: args.messageIds };
      const mailboxes = args.query !== undefined ? await router.many(args.account) : [await router.one(args.account)];
      if (mailboxes.length === 1) {
        return { account: mailboxes[0].email, action: args.action, ...(await mailboxes[0].bulkModify(sel, { add, remove }, opts)) };
      }
      return {
        action: args.action,
        accounts: await Promise.all(
          mailboxes.map(async (mb) => {
            try {
              return { account: mb.email, ...(await mb.bulkModify(sel, { add, remove }, opts)) };
            } catch (err) {
              return { account: mb.email, error: (err as Error).message };
            }
          }),
        ),
      };
    });

  server.registerTool(
    "bulk_update",
    {
      title: "Change many emails at once",
      description:
        "Archives, moves to the inbox, marks read/unread, stars/unstars, or adds/removes labels on many emails at once, in one or every linked account. Select emails with a Gmail search `query` (across all accounts by default) or with `threadIds`/`messageIds` from one account. With a query or threads, only emails that don't already have the change are counted and changed. If a run stops partway, the result has `changed` (what went through) and `error`; tell the user both. Run with dryRun: true first, tell the user how many emails will change (with the preview), and only then run it for real.",
      inputSchema: {
        ...bulkSelection,
        action: z
          .enum(["archive", "move_to_inbox", "mark_read", "mark_unread", "star", "unstar", "add_labels", "remove_labels"])
          .describe("Required. What to do to the selected emails."),
        labelIds: labelIdsArg.optional().describe("Label IDs or names, for add_labels/remove_labels. Labels are per account."),
      },
      annotations: write,
    },
    async (args) => runBulk(args),
  );

  server.registerTool(
    "bulk_trash",
    {
      title: "Trash or report many emails",
      description:
        "Moves many emails to Trash, or marks them as spam, in one or every linked account. Select emails with a Gmail search `query` (across all accounts by default) or with `threadIds`/`messageIds` from one account. With a query or threads, only emails that don't already have the change are counted and changed. If a run stops partway, the result has `changed` (what went through) and `error`; tell the user both. Always run with dryRun: true first, show the user how many emails (and which) will be affected, and get their confirmation before running it for real. Trashed emails can be restored from Trash for 30 days.",
      inputSchema: {
        ...bulkSelection,
        action: z.enum(["trash", "spam"]).describe("Required. trash moves emails to Trash; spam reports them as spam."),
      },
      annotations: destructive,
    },
    async (args) => runBulk(args),
  );

  // ---------- unsubscribing ----------

  const webFetch = deps.webFetch ?? defaultFetch;
  const resolveHost = deps.resolveHost ?? systemResolveHost;

  /** Why a one-click URL must not be contacted (an IP address, a local name, or a name for a private address). */
  const oneClickRefusal = async (href: string): Promise<string | undefined> => {
    const url = new URL(href);
    const unsafe = unsafeUnsubscribeHost(url);
    if (unsafe) return unsafe;
    const addresses = await resolveHost(url.hostname).catch(() => [] as string[]);
    const internal = addresses.find(isPrivateAddress);
    return internal ? `${url.hostname} leads to a private network address (${internal})` : undefined;
  };

  const planFor = async (group: SenderGroup): Promise<UnsubscribePlan> => {
    const options = unsubscribeOptions(group.newest.listUnsubscribe, group.newest.listUnsubscribePost);
    const refused = options.oneClick ? await oneClickRefusal(options.oneClick) : undefined;
    if (options.oneClick && !refused) return { method: "one-click", url: options.oneClick };
    const why = refused && `The one-click address wasn't used: ${refused}.`;
    if (options.mailto) return { method: "email", mail: options.mailto, ...(why ? { note: why } : {}) };
    if (why) return { method: "refused", reason: why };
    if (options.link) return { method: "link", link: options.link };
    return { method: "none" };
  };

  const describePlan = (account: string, group: SenderGroup, plan: UnsubscribePlan) => ({
    account,
    sender: group.address,
    ...(group.name ? { name: group.name } : {}),
    method: plan.method,
    ...(plan.method === "one-click" ? { via: new URL(plan.url).hostname } : {}),
    ...(plan.method === "email" ? { to: plan.mail.to, ...(plan.note ? { note: plan.note } : {}) } : {}),
    ...(plan.method === "link" ? { link: plan.link } : {}),
    ...(plan.method === "refused" ? { reason: plan.reason } : {}),
    ...(plan.method === "none" ? { note: NO_UNSUBSCRIBE_NOTE } : {}),
    emailsScanned: group.count,
    newestSubject: group.newest.subject,
    ...(group.newest.date ? { newestDate: group.newest.date } : {}),
  });

  const carryOut = async (mb: Mailbox, plan: UnsubscribePlan): Promise<{ result: string; [key: string]: unknown }> => {
    switch (plan.method) {
      case "one-click":
        try {
          // RFC 8058: a POST with this exact body; never a GET, and redirects aren't followed.
          const res = await webFetch(plan.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
            redirect: "manual",
            signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
          });
          await res.body?.cancel().catch(() => undefined);
          // With redirect "manual", Node and Workers hand back the 3xx itself.
          if (res.status >= 200 && res.status < 400) return { result: "unsubscribed" };
          return {
            result: "failed",
            reason: `The sender's unsubscribe service answered ${res.status}. The user can open the link to unsubscribe on the sender's site.`,
            link: plan.url,
          };
        } catch (err) {
          const name = (err as Error).name;
          return {
            result: "failed",
            reason:
              name === "TimeoutError" || name === "AbortError"
                ? "The sender's unsubscribe service didn't answer within 10 seconds. The user can open the link instead."
                : `Couldn't reach the sender's unsubscribe service (${(err as Error).message}). The user can open the link instead.`,
            link: plan.url,
          };
        }
      case "email":
        try {
          await mb.sendUnsubscribeEmail(plan.mail);
          return { result: "unsubscribe email sent" };
        } catch (err) {
          return { result: "failed", reason: (err as Error).message };
        }
      case "link":
        return { result: "open this link" };
      case "refused":
        return { result: "failed" };
      case "none":
        return { result: "no unsubscribe option" };
    }
  };

  server.registerTool(
    "unsubscribe",
    {
      title: "Unsubscribe from senders",
      description:
        "Unsubscribes the user from newsletters and store or alert emails, in one or every linked account. Choose the emails with a Gmail search `query` (e.g. \"from:levi.com\" or \"category:promotions newer_than:30d\"; every account by default) or `messageIds` from one account. The newest matching emails are grouped by account and sender, and each sender is unsubscribed once, the way its emails' List-Unsubscribe header offers: `one-click` (the connector sends the sender's standard one-click request), `email` (sends an unsubscribe email from that account; it shows up in Sent), `link` (the sender only offers a web page: give the user the link; the connector never opens links), or `none` (no unsubscribe option: suggest bulk_trash or bulk_update, or a Gmail filter). ALWAYS run with dryRun: true first, show the user the plan (account, sender, method) and get their OK before running it for real. Afterwards, bulk_update (archive) or bulk_trash with the same query can clear the emails already received. Don't use it on spam: unsubscribing confirms the address to spammers, so mark it as spam with bulk_trash instead.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe('With `query`: one account (email or alias) or "all"; defaults to every linked account. With messageIds: the one account those IDs belong to.'),
        query: z.string().optional().describe("Gmail search for emails from the senders to unsubscribe from. Drafts are never included."),
        messageIds: z.array(z.string()).min(1).max(100).optional().describe("Optional. Unsubscribe from the senders of these emails (one account)."),
        maxSenders: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Optional. Most senders to handle per run, across all accounts (default 10, max 20). Senders with the most emails come first."),
        dryRun: z.boolean().optional().describe("Optional. Show the plan for each sender without doing anything."),
      },
      annotations: sends,
    },
    async (args) =>
      run(async () => {
        if ((args.query !== undefined) === Boolean(args.messageIds?.length)) {
          throw new AccountError("Give exactly one of `query` or `messageIds`.");
        }
        const mailboxes = args.query !== undefined ? await router.many(args.account) : [await router.one(args.account)];
        // Scanning 50 instead of 100 emails per account when there are many keeps a run within
        // Cloudflare's 50-call limit: per account a token, a search and one metadata batch.
        const perAccount = mailboxes.length > 3 ? 50 : 100;
        const scans = await Promise.all(
          mailboxes.map(async (mb) => {
            try {
              return { mb, ...(await mb.scanSenders({ query: args.query, messageIds: args.messageIds }, perAccount)) };
            } catch (err) {
              if (mailboxes.length === 1) throw err;
              return { mb, senders: [] as SenderGroup[], error: (err as Error).message };
            }
          }),
        );
        const errors = scans.flatMap((s) => ("error" in s ? [{ account: s.mb.email, error: s.error }] : []));
        const unavailable = scans.flatMap((s) => ("unavailable" in s && s.unavailable ? [{ account: s.mb.email, messageIds: s.unavailable }] : []));
        const maxSenders = args.maxSenders ?? 10;
        const found = scans
          .flatMap((s) => s.senders.map((group) => ({ mb: s.mb, group })))
          .sort((x, y) => y.group.count - x.group.count || y.group.newest.time - x.group.newest.time);
        const chosen = await Promise.all(found.slice(0, maxSenders).map(async (f) => ({ ...f, plan: await planFor(f.group) })));
        // Their emails stay in the mailbox, so the same query would find the same senders first again:
        // the rest are handed back as a search for just them, per account.
        const rest = new Map<string, string[]>();
        for (const f of found.slice(maxSenders)) rest.set(f.mb.email, [...(rest.get(f.mb.email) ?? []), f.group.address]);
        const nextRuns = [...rest].map(([account, senders]) => {
          const from = senders.length === 1 ? `from:${senders[0]}` : `(${senders.map((a) => `from:${a}`).join(" OR ")})`;
          return { account, query: args.query?.trim() ? `(${args.query}) ${from}` : from };
        });
        const extra = {
          ...(nextRuns.length
            ? {
                moreSenders: `${found.length - maxSenders} more sender(s) weren't included (maxSenders is ${maxSenders}). The same query would find the same senders first, so to continue, run it again with each account and query in nextRuns${maxSenders < 20 ? ", or raise maxSenders (up to 20)" : ""}.`,
                nextRuns,
              }
            : {}),
          ...(errors.length ? { errors } : {}),
          ...(unavailable.length ? { unavailable } : {}),
        };
        if (args.dryRun) {
          return {
            dryRun: true,
            senders: chosen.map((c) => describePlan(c.mb.email, c.group, c.plan)),
            ...extra,
            note: chosen.length
              ? "Nothing was done yet. Show the user this plan and get their OK, then run it again without dryRun."
              : "No emails from other senders matched.",
          };
        }
        // Each sender takes at most one call: the one-click request or the unsubscribe email.
        const senders = await mapLimit(chosen, 6, async (c) => ({ ...describePlan(c.mb.email, c.group, c.plan), ...(await carryOut(c.mb, c.plan)) }));
        const count = (result: string) => senders.filter((r) => r.result === result).length;
        return {
          senders,
          summary: {
            unsubscribed: count("unsubscribed"),
            emailsSent: count("unsubscribe email sent"),
            linksToOpen: count("open this link"),
            noOption: count("no unsubscribe option"),
            failed: count("failed"),
          },
          ...extra,
          note: "Emails already received are still there: bulk_update (archive) or bulk_trash with the same query can clear them.",
        };
      }),
  );

  // ---------- trash & spam ----------

  const simpleTool = (
    name: string,
    kind: "messages" | "threads",
    description: string,
    annotations: typeof write | typeof destructive,
    action: (mb: Mailbox, id: string) => Promise<unknown>,
  ) => {
    const idKey = kind === "messages" ? "messageId" : "threadId";
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          account: accountArg,
          [idKey]: z.string().describe(`Required. The ${kind === "messages" ? "message" : "thread"} ID.`),
        } as { account: typeof accountArg } & Record<string, z.ZodString>,
        annotations,
      },
      async (args: Record<string, any>) =>
        run(async () => {
          const mb = await router.one(args.account);
          return { account: mb.email, ...((await action(mb, args[idKey])) as object) };
        }),
    );
  };

  simpleTool("trash_message", "messages", "Moves one message to Trash. To trash a whole conversation prefer trash_thread.", destructive, (mb, id) =>
    mb.trash("messages", id),
  );
  simpleTool("trash_thread", "threads", "Moves an entire thread to Trash.", destructive, (mb, id) => mb.trash("threads", id));
  simpleTool("untrash_message", "messages", "Restores one message from Trash.", write, (mb, id) => mb.trash("messages", id, true));
  simpleTool("untrash_thread", "threads", "Restores an entire thread from Trash.", write, (mb, id) => mb.trash("threads", id, true));
  simpleTool("mark_message_spam", "messages", "Marks one message as spam (moves it out of the inbox).", destructive, (mb, id) =>
    mb.modifyIds("messages", id, ["SPAM"], ["INBOX"]),
  );
  simpleTool("mark_thread_spam", "threads", "Marks an entire thread as spam.", destructive, (mb, id) =>
    mb.modifyIds("threads", id, ["SPAM"], ["INBOX"]),
  );
  simpleTool("unmark_message_spam", "messages", "Moves one message out of Spam back to the inbox.", write, (mb, id) =>
    mb.modifyIds("messages", id, ["INBOX"], ["SPAM"]),
  );
  simpleTool("unmark_thread_spam", "threads", "Moves an entire thread out of Spam back to the inbox.", write, (mb, id) =>
    mb.modifyIds("threads", id, ["INBOX"], ["SPAM"]),
  );

  return server;
}
