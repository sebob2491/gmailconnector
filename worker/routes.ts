/**
 * Browser-facing routes: the setup page, the consent page Claude opens, Google sign-in, and the
 * page where accounts are linked and removed.
 *
 * Flow when Claude connects:
 *   GET /authorize → consent page → POST /authorize → Google → /google/callback → /accounts
 *   → (optionally "Link another" → Google → /google/callback → /accounts …) → POST /accounts/done
 *   → back to Claude with an authorization code.
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
import { googleClient, loadOwner, recordSignIn, redirectHostAllowed, saveOwner, type Env } from "./owner.js";
import { accountsPage, consentPage, htmlResponse, messagePage, statusPage } from "./pages.js";

const SESSION_COOKIE = "__Host-gmail-connector";
const SESSION_TTL = 30 * 60;
const GOOGLE_STATE_TTL = 10 * 60;

interface SessionData {
  /** The pending authorization from Claude; absent when managing accounts directly. */
  request?: AuthRequest;
  clientName?: string;
  /** True once this browser has signed in with an account allowed to use the connector. */
  authenticated: boolean;
}

interface Session {
  handle: string;
  data: SessionData;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const sessionKey = async (handle: string) => `gmail:session:${await sha256(handle)}`;

async function createSession(env: Env, data: SessionData, headers: Headers): Promise<Session> {
  const handle = randomToken(32);
  await env.OAUTH_KV.put(await sessionKey(handle), JSON.stringify(data), { expirationTtl: SESSION_TTL });
  headers.append("Set-Cookie", `${SESSION_COOKIE}=${handle}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`);
  return { handle, data };
}

async function getSession(env: Env, request: Request): Promise<Session | undefined> {
  const handle = readCookie(request, SESSION_COOKIE);
  if (!handle) return undefined;
  const data = await env.OAUTH_KV.get<SessionData>(await sessionKey(handle), "json");
  return data ? { handle, data } : undefined;
}

async function saveSession(env: Env, session: Session): Promise<void> {
  await env.OAUTH_KV.put(await sessionKey(session.handle), JSON.stringify(session.data), { expirationTtl: SESSION_TTL });
}

async function endSession(env: Env, session: Session, headers: Headers): Promise<void> {
  await env.OAUTH_KV.delete(await sessionKey(session.handle));
  headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function redirect(location: string, headers = new Headers(), status = 302): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

/** An OAuth error redirect back to Claude for a request that was validated earlier. */
function clientErrorRedirect(request: AuthRequest, headers = new Headers()): Response {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", request.state);
  if (request.issuer) url.searchParams.set("iss", request.issuer);
  return redirect(url.toString(), headers);
}

const notConfigured = (origin: string) =>
  messagePage(
    "Almost there",
    "This connector isn't linked to a Google OAuth client yet. Open the setup page to finish step 1.",
    { status: 503, kind: "warn", action: { href: `${origin}/`, label: "Open setup page" } },
  );

async function startGoogleSignIn(env: Env, origin: string, session: Session, headers = new Headers()): Promise<Response> {
  const client = googleClient(env);
  if (!client) return notConfigured(origin);
  const state = randomToken(24);
  const verifier = randomToken(48);
  await env.OAUTH_KV.put(
    `gmail:gstate:${state}`,
    JSON.stringify({ session: await sha256(session.handle), verifier }),
    { expirationTtl: GOOGLE_STATE_TTL },
  );
  const url = buildAuthUrl({
    clientId: client.clientId,
    redirectUri: `${origin}/google/callback`,
    state,
    codeChallenge: await pkceChallenge(verifier),
  });
  return redirect(url, headers);
}

// ---------- handlers ----------

async function authorizeGet(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) {
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
  const redirectHost = new URL(authRequest.redirectUri).hostname;
  if (!redirectHostAllowed(env, authRequest.redirectUri)) {
    return messagePage(
      "Can't connect",
      `This connector only works with Claude, but this request would send access to ${redirectHost}.`,
      { status: 403 },
    );
  }
  if (!googleClient(env)) return notConfigured(origin);
  const client = await oauth.lookupClient(authRequest.clientId);
  const consent = await oauth.beginConsent(authRequest);
  return htmlResponse(
    consentPage({
      clientName: client?.clientName || "Claude",
      redirectHost,
      handle: consent.handle,
      local: /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost),
    }),
    { headers: consent.headers },
  );
}

async function authorizePost(request: Request, env: Env, origin: string): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
    const client = await env.OAUTH_PROVIDER.lookupClient(approved.request.clientId);
    const session = await createSession(
      env,
      { request: approved.request, clientName: client?.clientName || "Claude", authenticated: false },
      approved.headers,
    );
    return startGoogleSignIn(env, origin, session, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return messagePage("This page expired", "Start connecting again from Claude.", { status: 400, kind: "warn" });
    }
    throw error;
  }
}

async function googleCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const stored = state
    ? await env.OAUTH_KV.get<{ session: string; verifier: string }>(`gmail:gstate:${state}`, "json")
    : null;
  if (stored) await env.OAUTH_KV.delete(`gmail:gstate:${state}`);
  const session = await getSession(env, request);
  if (!stored || !session || stored.session !== (await sha256(session.handle))) {
    return messagePage(
      "Sign-in link expired",
      "This sign-in expired or was opened in a different browser. Please start again.",
      { kind: "warn", action: { href: `${origin}/accounts`, label: "Start again" } },
    );
  }

  if (url.searchParams.get("error")) {
    if (session.data.authenticated) return redirect(`${origin}/accounts`, undefined, 303);
    if (session.data.request) {
      const headers = new Headers();
      await endSession(env, session, headers);
      return clientErrorRedirect(session.data.request, headers);
    }
    return messagePage("Sign-in cancelled", "No account was linked.", { kind: "warn" });
  }

  const client = googleClient(env);
  if (!client) return notConfigured(origin);
  let email: string;
  let result;
  try {
    const tokens = await exchangeCode(client, {
      code: url.searchParams.get("code") ?? "",
      redirectUri: `${origin}/google/callback`,
      codeVerifier: stored.verifier,
    });
    email = await fetchProfileEmail(tokens.accessToken);
    result = await recordSignIn(env, email, tokens, session.data.authenticated);
    if (!result.ok) {
      await revokeToken(tokens.refreshToken);
      return messagePage("Not allowed", result.message, { status: 403 });
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return messagePage("Couldn't link that account", error.message, {
        action: { href: `${origin}/accounts`, label: "Try again" },
      });
    }
    throw error;
  }
  session.data.authenticated = true;
  await saveSession(env, session);
  return redirect(`${origin}/accounts?linked=${encodeURIComponent(email)}`, undefined, 303);
}

async function accountsGet(request: Request, env: Env, origin: string): Promise<Response> {
  const session = await getSession(env, request);
  if (!session?.data.authenticated) {
    if (!googleClient(env)) return notConfigured(origin);
    if (session) return startGoogleSignIn(env, origin, session);
    const headers = new Headers();
    const created = await createSession(env, { authenticated: false }, headers);
    return startGoogleSignIn(env, origin, created, headers);
  }
  const rec = await loadOwner(env.OAUTH_KV);
  const url = new URL(request.url);
  const linked = url.searchParams.get("linked");
  const removed = url.searchParams.get("removed");
  const notice = linked
    ? { kind: "ok" as const, text: `Linked ${linked}.` }
    : removed
      ? { kind: "ok" as const, text: `Removed ${removed}.` }
      : url.searchParams.get("error") === "none"
        ? { kind: "bad" as const, text: "Link at least one Gmail account first." }
        : undefined;
  return htmlResponse(
    accountsPage({
      accounts: rec.accounts.map((a) => a.email),
      owner: rec.owner,
      csrf: session.handle,
      notice,
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
  if (!session?.data.authenticated || form.get("csrf") !== session.handle) {
    return messagePage("Session expired", "Please sign in again.", {
      kind: "warn",
      action: { href: `${origin}/accounts`, label: "Sign in" },
    });
  }

  switch (action) {
    case "link":
      return startGoogleSignIn(env, origin, session);
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
      if (session.data.request) return clientErrorRedirect(session.data.request, headers);
      return redirect(`${origin}/`, headers, 303);
    }
    case "done": {
      if (!session.data.request) return redirect(`${origin}/accounts`, undefined, 303);
      const rec = await loadOwner(env.OAUTH_KV);
      if (!rec.accounts.length) return redirect(`${origin}/accounts?error=none`, undefined, 303);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: session.data.request,
        userId: "owner",
        metadata: { clientName: session.data.clientName },
        scope: session.data.request.scope,
        props: { owner: true },
      });
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
