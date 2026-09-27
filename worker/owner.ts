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

const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "localhost", "127.0.0.1", "[::1]"];

/** Only Claude (and local Claude apps) may receive tokens from this connector. */
export function redirectHostAllowed(env: Env, redirectUri: string): boolean {
  const hosts = list(env.ALLOWED_REDIRECT_HOSTS);
  const allowed = hosts.length ? hosts : DEFAULT_REDIRECT_HOSTS;
  try {
    return allowed.includes(new URL(redirectUri).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type SignInResult = { ok: true; rec: OwnerRecord; claimed: boolean } | { ok: false; message: string };

/**
 * Applies a successful Google sign-in. The first sign-in of a browser session must be the owner, an
 * already-linked account, or listed in ALLOWED_EMAILS; after that, any account can be linked.
 */
export async function recordSignIn(
  env: Env,
  email: string,
  tokens: LinkedTokens,
  sessionAuthenticated: boolean,
): Promise<SignInResult> {
  const rec = await loadOwner(env.OAUTH_KV);
  const allowed = allowedEmails(env);
  const listed = allowed.some((a) => sameEmail(a, email));
  let claimed = false;
  if (!sessionAuthenticated) {
    if (!rec.owner) {
      if (allowed.length && !listed) {
        return { ok: false, message: `${email} is not in this connector's ALLOWED_EMAILS list.` };
      }
      rec.owner = email;
      claimed = true;
    } else {
      const known = sameEmail(rec.owner, email) || rec.accounts.some((a) => sameEmail(a.email, email));
      if (!known && !listed) {
        return {
          ok: false,
          message: `This connector belongs to someone else. Sign in with a Google account that is already linked to it.`,
        };
      }
    }
  }
  upsertAccount(rec, {
    email,
    refreshToken: tokens.refreshToken,
    scopes: tokens.scopes,
    addedAt: new Date().toISOString(),
  });
  await saveOwner(env.OAUTH_KV, rec);
  return { ok: true, rec, claimed };
}
