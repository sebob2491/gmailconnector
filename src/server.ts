import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { AccountError, describeAccount, findAccount, type AccountSource, type LinkedAccount } from "./accounts.js";
import { GmailApiError, GmailClient, TokenProvider } from "./gmailClient.js";
import { defaultFetch, type FetchLike } from "./google.js";
import { decodeTextFile, kindOf, officeText, pdfText, sniffType } from "./attachments.js";
import { cleanBody, DEFAULT_MAX_BODY_CHARS, limitLength, viewUrl } from "./format.js";
import { Mailbox } from "./mailbox.js";

export const SERVER_NAME = "gmail-multi";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `This server connects several Gmail accounts at once.
- Call list_accounts to see which accounts are linked (email + optional alias like "work").
- search_threads, list_drafts and list_labels cover every linked account when \`account\` is omitted, and group results by account.
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
        return { account: mb.email, error: (err as Error).message };
      }
    }),
  );
  const nextPageToken = encodeMultiToken(next);
  return { accounts, ...(nextPageToken ? { nextPageToken } : {}) };
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
}

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
        "Lists the Gmail accounts linked to this connector, with their aliases and which one is the default. Use the email or alias as the `account` argument of other tools. The result also says how the user can link or remove accounts.",
      inputSchema: {},
      annotations: read,
    },
    async () =>
      run(async () => {
        const data = await store.load();
        return {
          accounts: data.accounts.map((a) => ({
            email: a.email,
            ...(a.alias ? { alias: a.alias } : {}),
            isDefault: data.defaultAccount ? a.email.toLowerCase() === data.defaultAccount.toLowerCase() : data.accounts.length === 1,
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
        "Searches email threads in one or all linked Gmail accounts. Without `account`, every linked account is searched and results are grouped by account; pass that account back when opening a thread. A thread with one email is shown flat (subject, sender, date, snippet, labels); longer threads list their 5 most recent messages under `messages`, and `totalMessages` says how many there are. Recipients are listed only when an email wasn't addressed to just that account. Use get_thread to read full bodies. For more results, pass the returned `nextPageToken` (it covers all accounts at once).",
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
      run(async () =>
        fanOut(await router.many(args.account), args.pageToken, (mb, pageToken) =>
          mb.searchThreads({ ...args, pageToken }),
        ),
      ),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get email thread",
      description:
        "Retrieves a full email thread (all messages, drafts omitted) from one Gmail account, including each message's `viewUrl`. Use the thread ID and `account` from search_threads.",
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
          ...(await mb.getThread(args.threadId, args.messageFormat ?? "PLAIN_TEXT", { maxBodyChars: args.maxBodyChars, shortenLinks: true })),
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
        "Lists draft emails in one or all linked Gmail accounts (grouped by account when several). Returns draft IDs, recipients, dates and `viewUrl`; set view to DRAFT_VIEW_FULL to include subject and plain-text body.",
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
          .describe("Optional. Longest text to return (default 20000; 0 for no limit)."),
      },
      annotations: read,
    },
    async (args) =>
      runContent(async () => {
        const mb = await router.one(args.account);
        const { info, bytes } = await mb.getAttachment(args.messageId, args);
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
        const asText = (text: string, extra: Record<string, unknown> = {}): CallToolResult["content"] => {
          const limited = limitLength(cleanBody(text), max);
          const truncated = limited.omitted
            ? { truncated: `Shortened: ${limited.omitted.toLocaleString("en-US")} more characters not shown. Call again with maxChars: 0 for all of it.` }
            : {};
          return [
            { type: "text", text: JSON.stringify({ ...meta, ...extra, ...truncated }) },
            { type: "text", text: limited.text || "(The file contains no text.)" },
          ];
        };
        const withNote = (note: string): CallToolResult["content"] => [{ type: "text", text: JSON.stringify({ ...meta, note }) }];

        if (kind === "text") return asText(decodeTextFile(bytes, mimeType, info.filename));
        if (kind === "office") {
          try {
            return asText(await officeText(bytes));
          } catch {
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
          const text = await pdfText(bytes);
          if (text) return asText(text, { extracted: "Text extracted from the PDF; layout, images and tables may be simplified." });
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
    threadIds: z.array(z.string()).max(500).optional().describe("Optional. Change every email in these threads."),
    messageIds: z.array(z.string()).max(1000).optional().describe("Optional. Change exactly these emails."),
    maxEmails: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("Optional. Most emails to change per account (default 500). If more match, the result says so."),
    dryRun: z
      .boolean()
      .optional()
      .describe("Optional. Count the matching emails and preview the first 10, without changing anything."),
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
        "Archives, moves to the inbox, marks read/unread, stars/unstars, or adds/removes labels on many emails at once, in one or every linked account. Select emails with a Gmail search `query` (across all accounts by default) or with `threadIds`/`messageIds` from one account. Run with dryRun: true first, tell the user how many emails will change (with the preview), and only then run it for real.",
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
        "Moves many emails to Trash, or marks them as spam, in one or every linked account. Select emails with a Gmail search `query` (across all accounts by default) or with `threadIds`/`messageIds` from one account. Always run with dryRun: true first, show the user how many emails (and which) will be affected, and get their confirmation before running it for real. Trashed emails can be restored from Trash for 30 days.",
      inputSchema: {
        ...bulkSelection,
        action: z.enum(["trash", "spam"]).describe("Required. trash moves emails to Trash; spam reports them as spam."),
      },
      annotations: destructive,
    },
    async (args) => runBulk(args),
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
