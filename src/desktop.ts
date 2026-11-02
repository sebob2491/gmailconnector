/**
 * Local-only pieces for the stdio server, used by the Claude Desktop extension (MCP Bundle):
 * choosing the Google OAuth client, and tools that link and unlink Gmail accounts from inside Claude.
 */
import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AccountStore, describeAccount, normalizeAlias, sameEmail, type LinkedAccount } from "./accountStore.js";
import {
  AuthError,
  defaultCredentialsPath,
  defaultFetch,
  fetchProfileEmail,
  loadOAuthClient,
  openInBrowser,
  revokeToken,
  startLoopbackAuth,
  type FetchLike,
  type LinkedTokens,
  type LoopbackAuth,
  type OAuthClientConfig,
} from "./oauth.js";

/** Set by the extension's manifest from its optional "Your own Google client" settings. */
export const USER_CLIENT_ID_ENV = "GMAIL_MCP_USER_CLIENT_ID";
export const USER_CLIENT_SECRET_ENV = "GMAIL_MCP_USER_CLIENT_SECRET";

/** The file `npm run pack:desktop` writes next to the bundled server when the build has a client. */
export const BUILTIN_CLIENT_FILE = "google-client.json";

export type ClientSource = "your settings" | "credentials" | "built-in";

/** What to say to a desktop user who has no way to sign in yet. */
export const NO_CLIENT_MESSAGE =
  "This copy of the Gmail extension has no built-in Google sign-in client, and none is configured. " +
  "In Claude Desktop, open Settings → Extensions → Gmail (multiple accounts) → Configure, and enter your own " +
  "Google OAuth client ID and secret (a \"Desktop app\" client; the README explains how to create one), " +
  `or save its credentials.json to ${defaultCredentialsPath()}. Then try again.`;

/**
 * A setting from the extension's settings page. Claude Desktop leaves `${user_config.x}` as it is
 * when an optional setting is empty, so that counts as unset, like a blank value.
 */
function setting(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

export async function readBuiltinClient(file: string | URL | undefined): Promise<OAuthClientConfig | undefined> {
  if (!file) return undefined;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const json = JSON.parse(raw) as { client_id?: string; client_secret?: string };
  if (!json.client_id || !json.client_secret) return undefined;
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

/**
 * The Google OAuth client to sign in and refresh tokens with, in this order: the client ID and
 * secret from the extension's settings; GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or credentials.json
 * (the manual setup); the client built into the extension; otherwise a clear error.
 */
export async function resolveOAuthClient(
  opts: { env?: NodeJS.ProcessEnv; builtinFile?: string | URL } = {},
): Promise<OAuthClientConfig & { source: ClientSource }> {
  const env = opts.env ?? process.env;
  const id = setting(USER_CLIENT_ID_ENV, env);
  const secret = setting(USER_CLIENT_SECRET_ENV, env);
  if (id && secret) return { clientId: id, clientSecret: secret, source: "your settings" };
  if (id || secret) {
    throw new AuthError(
      "The extension's settings have only one of \"Your own Google client ID\" and \"Your own Google client secret\". " +
        "Fill in both, or clear both to use the built-in client.",
    );
  }
  try {
    return { ...(await loadOAuthClient()), source: "credentials" };
  } catch (err) {
    // A credentials.json that exists but is broken is worth reporting rather than skipping.
    if (!(err instanceof AuthError) || !/^No Google OAuth client found/.test(err.message)) throw err;
  }
  const builtin = await readBuiltinClient(opts.builtinFile);
  if (builtin) return { ...builtin, source: "built-in" };
  throw new AuthError(NO_CLIENT_MESSAGE);
}

/**
 * Stores a newly signed-in account. If that fails, the grant is revoked again, unless the account
 * was already linked (revoking would also end the grant behind its saved refresh token).
 */
export async function saveLinkedAccount(
  store: AccountStore,
  auth: LinkedTokens,
  alias: string | undefined,
  fetchImpl: FetchLike = defaultFetch,
): Promise<LinkedAccount> {
  let email: string | undefined;
  try {
    email = await fetchProfileEmail(auth.accessToken, fetchImpl);
    const account: LinkedAccount = { email, alias, refreshToken: auth.refreshToken, scopes: auth.scopes, addedAt: new Date().toISOString() };
    await store.upsert(account);
    return (await store.list()).find((a) => sameEmail(a.email, email!)) ?? account;
  } catch (err) {
    const linked = (await store.list().catch(() => [])).some((a) => email !== undefined && sameEmail(a.email, email));
    if (!linked) await revokeToken(auth.refreshToken, fetchImpl);
    throw err;
  }
}

export const DESKTOP_MANAGE_HINT =
  "Ask Claude to link your Gmail (link_account): it opens Google's sign-in page in the browser. " +
  "Claude can also unlink an account (unlink_account) or give it a nickname (set_account_nickname).";

export const DESKTOP_RELINK_HINT = "Ask Claude to link it again (link_account).";

export interface LinkToolDeps {
  store: AccountStore;
  /** The OAuth client to sign in with (the same one the server refreshes tokens with). */
  loadClient: () => Promise<OAuthClientConfig>;
  /** Opens the sign-in URL in the user's browser; resolves to false if it couldn't. */
  openUrl?: (url: string) => Promise<boolean>;
  fetchImpl?: FetchLike;
  /** How long a sign-in stays open (default 3 minutes). */
  timeoutMs?: number;
  /** Where errors of a sign-in nobody waits for anymore are reported (default stderr). */
  log?: (msg: string) => void;
  /** How often a waiting link_account reports progress to clients that asked for it. */
  progressIntervalMs?: number;
}

const LINK_TIMEOUT_MS = 3 * 60_000;

function text(message: string, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: message }] };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Registers link_account, unlink_account and set_account_nickname. They change the same
 * accounts.json the CLI uses, which the server re-reads on every call, so a newly linked account
 * works at once, without restarting anything.
 */
export function registerAccountTools(server: McpServer, deps: LinkToolDeps): void {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const openUrl = deps.openUrl ?? ((url: string) => openInBrowser(url));
  const timeoutMs = deps.timeoutMs ?? LINK_TIMEOUT_MS;
  const log = deps.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const { store } = deps;

  /** The sign-in in progress, if any. Another link_account call joins it instead of starting a second one. */
  let pending: { flow: LoopbackAuth<LinkedAccount>; alias?: string } | undefined;

  const describeLinked = async (account: LinkedAccount) => {
    const count = (await store.list()).length;
    return `Linked ${describeAccount(account)}. ${count} Gmail account${count === 1 ? " is" : "s are"} linked now.`;
  };

  server.registerTool(
    "link_account",
    {
      title: "Link a Gmail account",
      description:
        "Links a Gmail account to this connector: opens Google's sign-in page in the user's browser and waits (up to 3 minutes) until they have signed in, then returns the address that was linked. Call it when the user asks to link, connect or add their Gmail (or another Gmail account). Tell the user to look for the browser window first. If the browser can't be opened, the result has a link for the user to open instead; the account is then linked as soon as they finish, and list_accounts shows it. Calling it for an account that is already linked refreshes its authorization.",
      inputSchema: z.strictObject({
        nickname: z
          .string()
          .optional()
          .describe('Optional short name for the account, such as "work" or "personal", usable as the `account` argument of other tools.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ nickname }, extra) => {
      let alias: string | undefined;
      try {
        alias = nickname?.trim() ? normalizeAlias(nickname) : undefined;
      } catch (err) {
        return text(errorText(err), true);
      }

      let flow: LoopbackAuth<LinkedAccount>;
      let opened = true;
      if (pending) {
        flow = pending.flow;
        if (alias) pending.alias = alias;
      } else {
        let client: OAuthClientConfig;
        try {
          client = await deps.loadClient();
        } catch (err) {
          return text(errorText(err), true);
        }
        const state: { flow?: LoopbackAuth<LinkedAccount>; alias?: string } = { alias };
        flow = await startLoopbackAuth<LinkedAccount>(client, {
          fetchImpl,
          timeoutMs,
          returnTo: "Claude",
          finish: (tokens) => saveLinkedAccount(store, tokens, state.alias, fetchImpl),
          donePage: (account) => `Linked ${account.email} to Claude. You can close this tab and go back to Claude.`,
        });
        state.flow = flow;
        pending = state as { flow: LoopbackAuth<LinkedAccount>; alias?: string };
        flow.result.then(
          (account) => log(`Linked ${account.email}.`),
          (err) => log(`Linking a Gmail account didn't finish: ${errorText(err)}`),
        );
        void flow.result.catch(() => undefined).finally(() => {
          if (pending?.flow === flow) pending = undefined;
        });
        opened = await openUrl(flow.authUrl).catch(() => false);
      }

      if (!opened) {
        return text(
          "Couldn't open a browser on this computer. Ask the user to open this link, sign in with the Gmail account " +
            `they want to link, and allow access (within ${Math.round(timeoutMs / 60_000) || 1} minutes):\n\n${flow.authUrl}\n\n` +
            "The account is linked as soon as they finish; call list_accounts afterwards to confirm.",
        );
      }

      // Keep clients that reset their timeout on progress waiting while the user signs in.
      const progressToken = extra._meta?.progressToken;
      let ticks = 0;
      const ticker =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              ticks++;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: ticks, message: "Waiting for Google sign-in in the browser…" },
                })
                .catch(() => undefined);
            }, deps.progressIntervalMs ?? 10_000);
      try {
        const account = await flow.result;
        return text(await describeLinked(account));
      } catch (err) {
        return text(`${errorText(err)} Nothing was linked. To try again, call link_account again.`, true);
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },
  );

  server.registerTool(
    "unlink_account",
    {
      title: "Unlink a Gmail account",
      description:
        "Unlinks a Gmail account from this connector and revokes the connector's access to it at Google. Before calling it, confirm with the user which account to unlink (show its address), and only call it when the user asked to unlink, remove or disconnect that account. It can be linked again later with link_account.",
      inputSchema: z.strictObject({
        account: z.string().min(1).describe("The account to unlink: its email address or nickname (see list_accounts)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account }) => {
      try {
        const removed = await store.remove(account);
        const revoked = await revokeToken(removed.refreshToken, fetchImpl);
        const left = (await store.list()).length;
        return text(
          (revoked
            ? `Unlinked ${removed.email} and revoked the connector's access to it.`
            : `Unlinked ${removed.email}, but Google didn't confirm revoking access. The user can remove it by hand at https://myaccount.google.com/permissions.`) +
            ` ${left} account(s) still linked.`,
        );
      } catch (err) {
        return text(errorText(err), true);
      }
    },
  );

  server.registerTool(
    "set_account_nickname",
    {
      title: "Set a Gmail account's nickname",
      description:
        'Gives a linked Gmail account a nickname such as "work" or "personal", which can then be used as the `account` argument of other tools. Replaces the account\'s current nickname.',
      inputSchema: z.strictObject({
        account: z.string().min(1).describe("The account: its email address or current nickname (see list_accounts)."),
        nickname: z.string().min(1).describe('The new nickname, e.g. "work". It cannot contain "@" or be "all".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ account, nickname }) => {
      try {
        const updated = await store.setAlias(account, nickname);
        return text(`${updated.email} is now also "${updated.alias}".`);
      } catch (err) {
        return text(errorText(err), true);
      }
    },
  );
}
