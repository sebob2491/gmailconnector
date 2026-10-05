/** Linked-account storage in Workers KV, and the rules for who may sign in. */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { sameEmail, upsertAccount, type AccountSource, type AccountsFile } from "../src/accounts.js";
import type { LinkedTokens, OAuthClientConfig } from "../src/google.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional comma-separated list of Google accounts allowed to sign in. */
  ALLOWED_EMAILS?: string;
  /** Optional comma-separated list of hosts Claude may redirect back to (defaults to Claude's). */
  ALLOWED_REDIRECT_HOSTS?: string;
}

const OWNER_KEY = "gmail:owner";

/**
 * This connector belongs to one person. `owner` is the first Google account that signed in; it and
 * every linked account can sign in again later. Everyone else is turned away.
 */
export interface OwnerRecord extends AccountsFile {
  owner?: string;
}

export async function loadOwner(kv: KVNamespace): Promise<OwnerRecord> {
  const rec = await kv.get<OwnerRecord>(OWNER_KEY, "json");
  return rec ? { ...rec, accounts: rec.accounts ?? [] } : { version: 1, accounts: [] };
}

export async function saveOwner(kv: KVNamespace, rec: OwnerRecord): Promise<void> {
  await kv.put(OWNER_KEY, JSON.stringify(rec));
}

export class KvAccountSource implements AccountSource {
  constructor(private kv: KVNamespace) {}

  async load(): Promise<AccountsFile> {
    const { owner: _owner, ...rest } = await loadOwner(this.kv);
    return rest;
  }
}

export function googleClient(env: Env): OAuthClientConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedEmails(env: Env): string[] {
  return list(env.ALLOWED_EMAILS);
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", ...LOOPBACK_HOSTS];

/** A redirect URI that may receive tokens, with its host and whether it is an app on this computer. */
export interface RedirectTarget {
  host: string;
  local: boolean;
}

/**
 * Only Claude (and local Claude apps) may receive tokens from this connector. The host must be on
 * the allowed list, and the URI must use https (or http to a loopback address, RFC 8252): a URI
 * like `someapp://claude.ai/…` has the host claude.ai but would hand the code to whichever app
 * owns that scheme.
 */
export function redirectTarget(env: Env, redirectUri: string): RedirectTarget | undefined {
  const hosts = list(env.ALLOWED_REDIRECT_HOSTS);
  const allowed = hosts.length ? hosts : DEFAULT_REDIRECT_HOSTS;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const local = LOOPBACK_HOSTS.includes(host);
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && local);
  return schemeOk && allowed.includes(host) ? { host, local } : undefined;
}

export function redirectHostAllowed(env: Env, redirectUri: string): boolean {
  return redirectTarget(env, redirectUri) !== undefined;
}

export type SignInResult =
  | { ok: true; rec: OwnerRecord; claimed: boolean; linked: boolean }
  | { ok: false; message: string; linked: boolean };

/**
 * Applies a successful Google sign-in.
 * - `purpose: "signin"` authenticates a browser session. Only the owner (the first account ever to
 *   sign in) or an address in ALLOWED_EMAILS may do this; being a linked account is not enough, so
 *   someone with access to one linked inbox (e.g. a work admin) can't reach the others. Signing in
 *   refreshes that account's token if it is linked, but never re-adds an account that was removed.
 * - `purpose: "link"` (only from an already authenticated session) adds or refreshes an account.
 */
export async function recordSignIn(
  env: Env,
  email: string,
  tokens: LinkedTokens,
  purpose: "signin" | "link",
): Promise<SignInResult> {
  const rec = await loadOwner(env.OAUTH_KV);
  const allowed = allowedEmails(env);
  const listed = allowed.some((a) => sameEmail(a, email));
  // Revoking any token of an account at Google ends the whole grant, including the refresh token
  // stored for a linked account, so callers must only revoke when this is false.
  const alreadyLinked = rec.accounts.some((a) => sameEmail(a.email, email));
  let claimed = false;
  if (purpose === "signin") {
    if (!rec.owner) {
      if (allowed.length && !listed) {
        return { ok: false, message: `${email} is not in this connector's ALLOWED_EMAILS list.`, linked: alreadyLinked };
      }
      rec.owner = email;
      claimed = true;
    } else if (!sameEmail(rec.owner, email) && !listed) {
      return {
        ok: false,
        message: `This connector belongs to someone else. Sign in with the Google account that set it up.`,
        linked: alreadyLinked,
      };
    }
  }
  const link = purpose === "link" || claimed || alreadyLinked;
  if (link) {
    upsertAccount(rec, {
      email,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
      addedAt: new Date().toISOString(),
    });
  }
  if (link || claimed) await saveOwner(env.OAUTH_KV, rec);
  return { ok: true, rec, claimed, linked: link };
}
