/** Google OAuth endpoints and token calls. Runtime-neutral: works in Node and Cloudflare Workers. */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export type FetchLike = typeof fetch;

/** Calls the global fetch unbound (Workers throws "Illegal invocation" if fetch is called as a method). */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    /** Google's OAuth error code, e.g. "invalid_grant" when a refresh token was revoked or expired. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

export async function refreshAccessToken(
  client: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<TokenResponse> {
  const res = await postForm(fetchImpl, TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new AuthError("authorization expired or was revoked", "invalid_grant");
    }
    if (body.error === "invalid_client" || body.error === "unauthorized_client") {
      throw new AuthError(
        `Google rejected the OAuth client (${body.error}); check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET`,
        body.error,
      );
    }
    throw new AuthError(
      `token refresh failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
      body.error,
    );
  }
  return body as unknown as TokenResponse;
}

/** Revokes a Google token. Returns false if Google didn't confirm (network error or an error status). */
export async function revokeToken(token: string, fetchImpl: FetchLike = defaultFetch): Promise<boolean> {
  try {
    const res = await postForm(fetchImpl, REVOKE_URL, { token });
    await res.body?.cancel();
    // 400 invalid_token means it was already revoked or expired, which is also the goal.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString();
  return url.toString();
}

export interface LinkedTokens {
  refreshToken: string;
  accessToken: string;
  scopes: string[];
}

/** Exchanges an authorization code (with PKCE) for tokens and checks Gmail access was granted. */
export async function exchangeCode(
  client: OAuthClientConfig,
  opts: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: FetchLike = defaultFetch,
): Promise<LinkedTokens> {
  const res = await postForm(fetchImpl, TOKEN_URL, {
    grant_type: "authorization_code",
    code: opts.code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new AuthError(`Code exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  if (!body.refresh_token) {
    throw new AuthError(
      "Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and try again.",
    );
  }
  const scopes = body.scope ? body.scope.split(" ") : GMAIL_SCOPES;
  if (!GMAIL_SCOPES.every((s) => scopes.includes(s))) {
    throw new AuthError("Gmail access was not granted. Make sure to tick the Gmail permission on the consent screen.");
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, scopes };
}

export async function fetchProfileEmail(accessToken: string, fetchImpl: FetchLike = defaultFetch): Promise<string> {
  const res = await fetchImpl(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new AuthError(`Could not read the Gmail profile (${res.status}).`);
  return ((await res.json()) as { emailAddress: string }).emailAddress;
}
