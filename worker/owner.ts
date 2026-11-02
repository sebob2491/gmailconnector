/** Linked-account storage in Workers KV, and the rules for who may sign in. */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { sameEmail, upsertAccount, type AccountSource, type AccountsFile } from "../src/accounts.js";
import type { LinkedTokens, OAuthClientConfig } from "../src/google.js";

/** What a Claude connection (an OAuth grant) records about who approved it. */
export interface GrantProps {
  /** The Google account that approved the connection. Absent for connections made by older versions. */
  email?: string;
  /** Set by older versions on every connection. */
  owner?: boolean;
}

/** Every Claude connection is stored under this OAuth user ID; the approving address is in its props. */
export const GRANT_USER = "owner";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional comma-separated list of Google accounts allowed to sign in. */
  ALLOWED_EMAILS?: string;
  /**
   * Optional comma-separated list of the redirect URIs sign-in codes may be sent to: exact URIs, or
   * prefixes ending in `*` (defaults to Claude's callback and loopback addresses).
   */
  ALLOWED_REDIRECT_URIS?: string;
  /** Older setting: hosts Claude may redirect back to, any path. Used only without ALLOWED_REDIRECT_URIS. */
  ALLOWED_REDIRECT_HOSTS?: string;
}

const OWNER_KEY = "gmail:owner";

/**
 * This connector belongs to one person. `owner` is the first Google account (from ALLOWED_EMAILS)
 * that signed in; it and the addresses in ALLOWED_EMAILS can sign in again later. Everyone else,
 * including linked accounts, is turned away.
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
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];

/**
 * Where sign-in codes may go by default: Claude's documented callback for custom connectors
 * (claude.ai on the web, Desktop, mobile; claude.com is the announced future address), and any path
 * on a loopback address, any port (Claude Code and other local Claude apps, RFC 8252).
 */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  ...LOOPBACK_HOSTS.map((host) => `http://${host}/*`),
];

/** A redirect URI that may receive tokens, with its host and whether it is an app on this computer. */
export interface RedirectTarget {
  host: string;
  local: boolean;
}

/** One entry of the allowed redirect list: an exact URI, or a prefix (written with a trailing `*`). */
interface RedirectRule {
  protocol: string;
  host: string;
  port: string;
  /** Path and query that must match exactly, or (with `prefix`) that the URI's must start with. */
  rest: string;
  prefix: boolean;
}

function parseRule(entry: string): RedirectRule | undefined {
  const prefix = entry.endsWith("*");
  const text = prefix ? entry.slice(0, -1) : entry;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  // A prefix must include the path's first "/", so "https://claude.ai*" can't match claude.ai.evil.example.
  if (prefix && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\//i.test(text)) return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return { protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port, rest: url.pathname + url.search, prefix };
}

/**
 * The allowed redirect list: ALLOWED_REDIRECT_URIS (comma-separated exact URIs, or prefixes ending in
 * `*`) or the defaults. Unreadable entries are ignored.
 */
function redirectRules(env: Env): RedirectRule[] {
  const entries = (env.ALLOWED_REDIRECT_URIS ?? "").split(/[\s,]+/).filter(Boolean);
  return (entries.length ? entries : DEFAULT_REDIRECT_URIS).flatMap((e) => parseRule(e) ?? []);
}

function ruleMatches(rule: RedirectRule, url: URL, host: string, local: boolean): boolean {
  if (rule.protocol !== url.protocol || rule.host !== host) return false;
  // Local apps listen on a port that changes every time (RFC 8252 section 7.3).
  if (!local && rule.port !== url.port) return false;
  const rest = url.pathname + url.search;
  return rule.prefix ? rest.startsWith(rule.rest) : rest === rule.rest && !url.hash;
}

/**
 * Only Claude (and local Claude apps) may receive tokens from this connector. The URI must use https
 * (or http to a loopback address, RFC 8252): a URI like `someapp://claude.ai/…` has the host
 * claude.ai but would hand the code to whichever app owns that scheme. Then it must be on the allowed
 * list: by default Claude's own callback, not just any page on claude.ai. With the older
 * ALLOWED_REDIRECT_HOSTS (and no ALLOWED_REDIRECT_URIS), any path on those hosts is allowed.
 */
export function redirectTarget(env: Env, redirectUri: string): RedirectTarget | undefined {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const local = LOOPBACK_HOSTS.includes(host);
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!schemeOk) return undefined;
  const legacyHosts = list(env.ALLOWED_REDIRECT_HOSTS);
  const allowed =
    legacyHosts.length && !env.ALLOWED_REDIRECT_URIS?.trim()
      ? legacyHosts.includes(host)
      : redirectRules(env).some((rule) => ruleMatches(rule, url, host, local));
  return allowed ? { host, local } : undefined;
}

/**
 * The hosts client metadata documents may be read from: ALLOWED_REDIRECT_HOSTS, or the hosts on the
 * allowed redirect list (by default claude.ai and claude.com), never a loopback address.
 */
export function allowedHosts(env: Env): string[] {
  const legacy = list(env.ALLOWED_REDIRECT_HOSTS);
  if (legacy.length && !env.ALLOWED_REDIRECT_URIS?.trim()) return legacy;
  const hosts = env.ALLOWED_REDIRECT_URIS?.trim() ? [...new Set(redirectRules(env).map((r) => r.host))] : CLAUDE_HOSTS;
  return hosts.filter((h) => !LOOPBACK_HOSTS.includes(h));
}

export function redirectHostAllowed(env: Env, redirectUri: string): boolean {
  return redirectTarget(env, redirectUri) !== undefined;
}

/**
 * Whether a client ID may be looked up. An ID that is an https URL names a client ID metadata
 * document, which the OAuth library fetches from that URL; only documents on the hosts that may
 * receive tokens are fetched, so an anonymous request can't make the connector fetch any address.
 * Registered clients have random IDs, which are always looked up (in storage).
 */
export function clientIdAllowed(env: Env, clientId: string): boolean {
  if (!/^https:\/\//i.test(clientId.trim())) return true;
  let url: URL;
  try {
    url = new URL(clientId.trim());
  } catch {
    return false;
  }
  return allowedHosts(env).includes(url.hostname.toLowerCase());
}

/** Whether `email` may still use the connector: the owner, or an address in ALLOWED_EMAILS. */
export async function emailAllowed(env: Env, email: string): Promise<boolean> {
  if (allowedEmails(env).some((a) => sameEmail(a, email))) return true;
  const { owner } = await loadOwner(env.OAUTH_KV);
  return Boolean(owner && sameEmail(owner, email));
}

/**
 * Whether a Claude connection approved by `email` may still be used. Connections made before the
 * approving address was recorded have none; only the owner could make those, so they stay valid.
 */
export async function connectionAllowed(env: Env, email: string | undefined): Promise<boolean> {
  return email === undefined || emailAllowed(env, email);
}

export type SignInResult =
  | { ok: true; rec: OwnerRecord; claimed: boolean; linked: boolean }
  /** `setup`: refused only because the connector isn't set up yet (ALLOWED_EMAILS missing), not because of who signed in. */
  | { ok: false; message: string; linked: boolean; setup?: boolean };

export const SET_ALLOWED_EMAILS =
  "Before signing in for the first time, tell the connector who owns it: in Cloudflare, open this " +
  "Worker's Settings → Variables and Secrets, add a variable named ALLOWED_EMAILS with your Gmail " +
  "address as its value, deploy, then sign in again.";

/**
 * Applies a successful Google sign-in.
 * - `purpose: "signin"` authenticates a browser session. Only the owner or an address in
 *   ALLOWED_EMAILS may do this. The owner is the first listed address to sign in; while there is no
 *   owner, ALLOWED_EMAILS must be set, so a stranger who finds the URL before the owner signs in
 *   can't claim it (KV can't make "first one wins" atomic). Being a linked account is not enough, so
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
      if (!allowed.length) return { ok: false, message: SET_ALLOWED_EMAILS, linked: alreadyLinked, setup: true };
      if (!listed) {
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
