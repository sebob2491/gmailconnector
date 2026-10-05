/**
 * Browser-facing routes: the setup page, the consent page Claude opens, Google sign-in, and the
 * page where accounts are linked and removed.
 *
 * Flow when Claude connects:
 *   GET /authorize → consent page → POST /authorize → Google → /google/callback → /accounts
 *   → (optionally "Link another" → Google → /google/callback → /accounts …) → POST /accounts/done
 *   → back to Claude with an authorization code.
 *
 * Nothing is written to KV until someone has signed in with Google as an allowed account: the
 * consent form's CSRF token and the Google sign-in in progress (including Claude's pending request)
 * are kept in cookies. Otherwise anyone who finds the URL could use up the free plan's 1,000 KV
 * writes a day, after which Claude can't refresh its token until the next day.
 */
import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { sameEmail } from "../src/accounts.js";
import {
  AuthError,
  buildAuthUrl,
  exchangeCode,
  fetchProfileEmail,
  pkceChallenge,
  randomToken,
  revokeToken,
} from "../src/google.js";
import { clearCookie, cookieNamesWithPrefix, readCookie, seal, setCookie, unseal } from "./cookies.js";
import { googleClient, loadOwner, recordSignIn, redirectHostAllowed, redirectTarget, saveOwner, type Env } from "./owner.js";
import { accountsPage, consentPage, htmlResponse, messagePage, privacyPage, statusPage } from "./pages.js";

const SESSION_COOKIE = "__Host-gmail-connector";
const SESSION_TTL = 30 * 60;
/** One cookie per consent page, holding that page's CSRF token. */
const CONSENT_COOKIE_PREFIX = "__Host-gmail-consent-";
const CONSENT_TTL = 30 * 60;
/** One cookie per Google sign-in in progress, holding its state, PKCE verifier and purpose. */
const SIGNIN_COOKIE_PREFIX = "__Host-gmail-signin-";
const SIGNIN_TTL = 10 * 60;
/** Browsers keep cookies up to about 4 KB. */
const MAX_COOKIE_BYTES = 3800;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface SessionData {
  /** The pending authorization from Claude; absent when managing accounts directly. */
  request?: AuthRequest;
  clientName?: string;
  /** Always true for sessions this version stores; sessions are only created by a sign-in. */
  authenticated: boolean;
}

interface Session {
  handle: string;
  data: SessionData;
}

type SignInPurpose = "signin" | "link";

/** A Google sign-in in progress, sealed into a cookie in the browser that started it. */
interface PendingSignIn {
  state: string;
  verifier: string;
  purpose: SignInPurpose;
  /** For "link": a hash of the signed-in session that started it. */
  session?: string;
  /** For "signin" while connecting Claude: the request to finish after signing in. */
  request?: AuthRequest;
  clientName?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sessionKey = async (handle: string) => `gmail:session:${await sha256(handle)}`;

function setSessionCookie(headers: Headers, handle: string): void {
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, handle, SESSION_TTL));
}

async function createSession(env: Env, data: SessionData, headers: Headers): Promise<Session> {
  const handle = randomToken(32);
  await env.OAUTH_KV.put(await sessionKey(handle), JSON.stringify(data), { expirationTtl: SESSION_TTL });
  setSessionCookie(headers, handle);
  return { handle, data };
}

/** The browser's signed-in session, if it has one. */
async function getSession(env: Env, request: Request): Promise<Session | undefined> {
  const handle = readCookie(request, SESSION_COOKIE);
  if (!handle) return undefined;
  const data = await env.OAUTH_KV.get<SessionData>(await sessionKey(handle), "json");
  return data?.authenticated ? { handle, data } : undefined;
}

/** Saves the session and extends both its storage and its cookie by another SESSION_TTL. */
async function saveSession(env: Env, session: Session, headers: Headers): Promise<void> {
  await env.OAUTH_KV.put(await sessionKey(session.handle), JSON.stringify(session.data), { expirationTtl: SESSION_TTL });
  setSessionCookie(headers, session.handle);
}

async function endSession(env: Env, session: Session, headers: Headers): Promise<void> {
  await env.OAUTH_KV.delete(await sessionKey(session.handle));
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
}

function redirect(location: string, headers = new Headers(), status = 302): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

/** The OAuth error redirect back to Claude for a request that was validated earlier. */
function clientErrorUrl(request: AuthRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  if (request.state) url.searchParams.set("state", request.state);
  if (request.issuer) url.searchParams.set("iss", request.issuer);
  return url.toString();
}

const notConfigured = (origin: string) =>
  messagePage(
    "Almost there",
    "This connector isn't linked to a Google OAuth client yet. Open the setup page to finish step 1.",
    { status: 503, kind: "warn", action: { href: `${origin}/`, label: "Open setup page" } },
  );

const signInCookie = (state: string) => `${SIGNIN_COOKIE_PREFIX}${state.slice(0, 16)}`;

/**
 * Prepares a Google sign-in: seals its state into a cookie (added to `headers`) and returns the
 * Google URL to send the browser to, or an error page.
 */
async function beginGoogleSignIn(
  env: Env,
  origin: string,
  request: Request,
  pending: Omit<PendingSignIn, "state" | "verifier">,
  headers: Headers,
): Promise<string | Response> {
  const client = googleClient(env);
  if (!client) return notConfigured(origin);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const sealed = await seal(client.clientSecret, { ...pending, state, verifier }, SIGNIN_TTL);
  if (sealed.length > MAX_COOKIE_BYTES) {
    return messagePage("Can't connect", "This connection request is too large. Start connecting again from Claude.");
  }
  // Abandoned sign-ins expire after 10 minutes; if several pile up, clear them so the Cookie
  // header stays small.
  const earlier = cookieNamesWithPrefix(request, SIGNIN_COOKIE_PREFIX);
  if (earlier.length >= 4) for (const name of earlier) headers.append("Set-Cookie", clearCookie(name));
  headers.append("Set-Cookie", setCookie(signInCookie(state), sealed, SIGNIN_TTL));
  return buildAuthUrl({
    clientId: client.clientId,
    redirectUri: `${origin}/google/callback`,
    state,
    codeChallenge: await pkceChallenge(verifier),
  });
}

/** Sends the browser to Google. `purpose` says whether the result signs this browser in or links an account. */
async function startGoogleSignIn(
  env: Env,
  origin: string,
  request: Request,
  pending: Omit<PendingSignIn, "state" | "verifier">,
  headers = new Headers(),
): Promise<Response> {
  const next = await beginGoogleSignIn(env, origin, request, pending, headers);
  return next instanceof Response ? next : redirect(next, headers);
}

// ---------- handlers ----------

/** Turns an invalid authorization request into an error for Claude, or a page if it can't go back safely. */
function authorizeError(env: Env, error: unknown): Response {
  // Only send errors back to Claude; anything else is shown here, so this can't be an open redirect.
  if (error instanceof AuthorizationError && error.redirectUri && redirectHostAllowed(env, error.redirectUri)) {
    const url = new URL(error.redirectUri);
    url.searchParams.set("error", error.code);
    url.searchParams.set("error_description", error.description);
    if (error.state) url.searchParams.set("state", error.state);
    if (error.issuer) url.searchParams.set("iss", error.issuer);
    return redirect(url.toString());
  }
  if (error instanceof AuthorizationError) return messagePage("Can't connect", error.description);
  if (error instanceof CimdFetchError) return messagePage("Can't connect", "This app could not be verified.");
  throw error;
}

function notClaude(redirectUri: string): Response {
  const url = new URL(redirectUri);
  const target = url.host ? `${url.protocol}//${url.host}` : url.protocol;
  return messagePage("Can't connect", `This connector only works with Claude, but this request would send access to ${target}.`, {
    status: 403,
  });
}

const consentCookie = (csrf: string) => `${CONSENT_COOKIE_PREFIX}${csrf.slice(0, 16)}`;

async function authorizeGet(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let authRequest: AuthRequest;
  let clientName: string;
  try {
    authRequest = await oauth.parseAuthRequest(request);
    const target = redirectTarget(env, authRequest.redirectUri);
    if (!target) return notClaude(authRequest.redirectUri);
    if (!googleClient(env)) return notConfigured(origin);
    clientName = (await oauth.lookupClient(authRequest.clientId))?.clientName || "Claude";
    // The form posts back to this same URL, and POST /authorize parses the request again, so
    // nothing has to be stored until the user has signed in with Google.
    const csrf = randomToken(24);
    const headers = new Headers();
    headers.append("Set-Cookie", setCookie(consentCookie(csrf), csrf, CONSENT_TTL));
    return htmlResponse(
      consentPage({
        clientName,
        redirectHost: target.host,
        action: `/authorize${new URL(request.url).search}`,
        csrf,
        local: target.local,
      }),
      { headers },
    );
  } catch (error) {
    return authorizeError(env, error);
  }
}

async function authorizePost(request: Request, env: Env, origin: string): Promise<Response> {
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  // A cookie only this site can set must match the form, so another site can't submit it.
  if (!TOKEN_PATTERN.test(csrf) || readCookie(request, consentCookie(csrf)) !== csrf) {
    return messagePage("This page expired", "Start connecting again from Claude.", { status: 400, kind: "warn" });
  }
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookie(consentCookie(csrf)));
  try {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!redirectHostAllowed(env, authRequest.redirectUri)) return notClaude(authRequest.redirectUri);
    if (form.get("decision") !== "approve") return redirect(clientErrorUrl(authRequest), headers);
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    return startGoogleSignIn(
      env,
      origin,
      request,
      { purpose: "signin", request: authRequest, clientName: client?.clientName || "Claude" },
      headers,
    );
  } catch (error) {
    return authorizeError(env, error);
  }
}

async function googleCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const client = googleClient(env);
  if (!client) return notConfigured(origin);
  const state = url.searchParams.get("state") ?? "";
  const headers = new Headers();
  let pending: PendingSignIn | undefined;
  if (TOKEN_PATTERN.test(state)) {
    const cookie = signInCookie(state);
    pending = await unseal<PendingSignIn>(client.clientSecret, readCookie(request, cookie));
    headers.append("Set-Cookie", clearCookie(cookie));
  }
  const session = pending?.purpose === "link" ? await getSession(env, request) : undefined;
  const valid =
    pending?.state === state &&
    (pending.purpose === "signin" || (session !== undefined && pending.session === (await sha256(session.handle))));
  if (!pending || !valid) {
    return messagePage(
      "Sign-in link expired",
      "This sign-in expired or was opened in a different browser. Please start again.",
      { kind: "warn", action: { href: `${origin}/accounts`, label: "Start again" }, headers },
    );
  }

  if (url.searchParams.get("error")) {
    if (pending.purpose === "link") return redirect(`${origin}/accounts`, headers, 303);
    if (pending.request) return redirect(clientErrorUrl(pending.request), headers);
    return messagePage("Sign-in cancelled", "No account was linked.", { kind: "warn", headers });
  }

  let email: string;
  let linked: boolean;
  try {
    const tokens = await exchangeCode(client, {
      code: url.searchParams.get("code") ?? "",
      redirectUri: `${origin}/google/callback`,
      codeVerifier: pending.verifier,
    });
    email = await fetchProfileEmail(tokens.accessToken);
    const result = await recordSignIn(env, email, tokens, pending.purpose);
    if (!result.ok) {
      if (!result.linked) await revokeToken(tokens.refreshToken);
      return messagePage("Not allowed", result.message, {
        status: 403,
        headers,
        ...(pending.request ? { action: { href: clientErrorUrl(pending.request), label: "Back to Claude" } } : {}),
      });
    }
    linked = result.linked;
    // Signing in with an account that isn't linked (e.g. one removed earlier) doesn't re-add it,
    // and the grant Google just created isn't needed.
    if (!linked) await revokeToken(tokens.refreshToken);
  } catch (error) {
    if (error instanceof AuthError) {
      // "Try again" starts a fresh Google sign-in for the same purpose, so a pending connection
      // from Claude isn't lost (e.g. when the Gmail permission was left unticked).
      const { state: _s, verifier: _v, ...again } = pending;
      const retry = await beginGoogleSignIn(env, origin, request, again, headers);
      return messagePage("Couldn't link that account", error.message, {
        headers,
        action: { href: typeof retry === "string" ? retry : `${origin}/accounts`, label: "Try again" },
      });
    }
    throw error;
  }
  if (pending.purpose === "link") {
    await saveSession(env, session!, headers);
  } else {
    await createSession(
      env,
      { authenticated: true, request: pending.request, clientName: pending.clientName },
      headers,
    );
  }
  const param = linked ? "linked" : "signedin";
  return redirect(`${origin}/accounts?${param}=${encodeURIComponent(email)}`, headers, 303);
}

function accountsNotice(url: URL) {
  const q = url.searchParams;
  const linked = q.get("linked");
  const signedIn = q.get("signedin");
  const removed = q.get("removed");
  if (linked) return { kind: "ok" as const, text: `Linked ${linked}.` };
  if (signedIn) return { kind: "ok" as const, text: `Signed in as ${signedIn}. That account isn't linked; use "Link" below to add it.` };
  if (removed) return { kind: "ok" as const, text: `Removed ${removed}.` };
  if (q.get("error") === "none") return { kind: "bad" as const, text: "Link at least one Gmail account first." };
  return undefined;
}

async function accountsGet(request: Request, env: Env, origin: string): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) return startGoogleSignIn(env, origin, request, { purpose: "signin" });
  const rec = await loadOwner(env.OAUTH_KV);
  return htmlResponse(
    accountsPage({
      accounts: rec.accounts.map((a) => a.email),
      owner: rec.owner,
      csrf: session.handle,
      notice: accountsNotice(new URL(request.url)),
      connecting: session.data.request
        ? { clientName: session.data.clientName ?? "Claude", redirectHost: new URL(session.data.request.redirectUri).hostname }
        : undefined,
    }),
  );
}

/** POST handlers on the accounts page: the session cookie and the form's copy of it must match. */
async function accountsPost(request: Request, env: Env, origin: string, action: string): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData();
  if (!session || form.get("csrf") !== session.handle) {
    return messagePage("Session expired", "Please sign in again.", {
      kind: "warn",
      action: { href: `${origin}/accounts`, label: "Sign in" },
    });
  }

  switch (action) {
    case "link":
      return startGoogleSignIn(env, origin, request, { purpose: "link", session: await sha256(session.handle) });
    case "remove": {
      const email = String(form.get("email") ?? "");
      const rec = await loadOwner(env.OAUTH_KV);
      const account = rec.accounts.find((a) => sameEmail(a.email, email));
      if (account) {
        rec.accounts = rec.accounts.filter((a) => a !== account);
        if (rec.defaultAccount && sameEmail(rec.defaultAccount, email)) delete rec.defaultAccount;
        await saveOwner(env.OAUTH_KV, rec);
        await revokeToken(account.refreshToken);
      }
      return redirect(`${origin}/accounts?removed=${encodeURIComponent(email)}`, undefined, 303);
    }
    case "cancel": {
      const headers = new Headers();
      await endSession(env, session, headers);
      if (session.data.request) return redirect(clientErrorUrl(session.data.request), headers);
      return redirect(`${origin}/`, headers, 303);
    }
    case "done": {
      if (!session.data.request) return redirect(`${origin}/accounts`, undefined, 303);
      const rec = await loadOwner(env.OAUTH_KV);
      if (!rec.accounts.length) return redirect(`${origin}/accounts?error=none`, undefined, 303);
      let redirectTo: string;
      try {
        ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: session.data.request,
          userId: "owner",
          metadata: { clientName: session.data.clientName },
          scope: session.data.request.scope,
          props: { owner: true },
          // Connecting again (e.g. from a second Claude account) must not disconnect the first.
          revokeExistingGrants: false,
        }));
      } catch (error) {
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
          return messagePage("Can't finish connecting", "Start connecting again from Claude.", { kind: "warn" });
        }
        throw error;
      }
      const headers = new Headers();
      await endSession(env, session, headers);
      return redirect(redirectTo, headers);
    }
  }
  return new Response("Not found", { status: 404 });
}

export async function handleBrowserRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /":
      return htmlResponse(
        statusPage({
          origin,
          googleConfigured: Boolean(googleClient(env)),
          claimed: Boolean((await loadOwner(env.OAUTH_KV)).owner),
        }),
      );
    case "GET /privacy":
      return htmlResponse(privacyPage(origin));
    case "GET /authorize":
      return authorizeGet(request, env, origin);
    case "POST /authorize":
      return authorizePost(request, env, origin);
    case "GET /google/callback":
      return googleCallback(request, env, origin);
    case "GET /accounts":
      return accountsGet(request, env, origin);
    case "POST /accounts/link":
    case "POST /accounts/remove":
    case "POST /accounts/cancel":
    case "POST /accounts/done":
      return accountsPost(request, env, origin, url.pathname.split("/")[2]);
  }
  return new Response("Not found", { status: 404 });
}
