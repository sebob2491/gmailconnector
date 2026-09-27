import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { configDir } from "./accountStore.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type FetchLike = typeof fetch;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export class AuthError extends Error {}

/**
 * Loads the Google OAuth client from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or from a
 * credentials.json downloaded from Google Cloud Console ("Desktop app" client type).
 */
export async function loadOAuthClient(credentialsPath?: string): Promise<OAuthClientConfig> {
  if (!credentialsPath && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  const file = credentialsPath ?? process.env.GMAIL_MCP_CREDENTIALS ?? path.join(configDir(), "credentials.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new AuthError(
      `No Google OAuth client found. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or save your ` +
        `"Desktop app" OAuth client JSON to ${file}. See README.md for setup steps.`,
    );
  }
  const json = JSON.parse(raw);
  const client = json.installed ?? json.web ?? json;
  if (!client.client_id || !client.client_secret) {
    throw new AuthError(`${file} does not look like a Google OAuth client file (missing client_id/client_secret).`);
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
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
  fetchImpl: FetchLike = fetch,
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
      throw new AuthError("authorization expired or was revoked");
    }
    throw new AuthError(`token refresh failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`);
  }
  return body as unknown as TokenResponse;
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await postForm(fetchImpl, REVOKE_URL, { token }).catch(() => undefined);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface InteractiveAuthResult {
  refreshToken: string;
  accessToken: string;
  scopes: string[];
}

/**
 * Runs the OAuth "installed app" flow: starts a loopback listener, sends the user to Google's
 * consent screen, and exchanges the returned code (with PKCE) for a refresh token.
 * If the browser is on a different machine, the user can paste the final redirect URL instead.
 */
export async function runInteractiveAuth(
  client: OAuthClientConfig,
  opts: { openBrowser: boolean; loginHint?: string; log: (msg: string) => void; fetchImpl?: FetchLike },
): Promise<InteractiveAuthResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  let resolveCode!: (value: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handleRedirect = (url: URL): string | undefined => {
    const error = url.searchParams.get("error");
    if (error) {
      rejectCode(new AuthError(`Google returned an error: ${error}`));
      return `Authorization failed: ${error}. You can close this tab.`;
    }
    const code = url.searchParams.get("code");
    if (!code) return undefined;
    if (url.searchParams.get("state") !== state) {
      rejectCode(new AuthError("OAuth state mismatch; please try again."));
      return "State mismatch. You can close this tab and try again.";
    }
    resolveCode(code);
    return "Account linked. You can close this tab and return to the terminal.";
  };

  const server = http.createServer((req, res) => {
    const message = handleRedirect(new URL(req.url ?? "/", "http://127.0.0.1"));
    res.writeHead(message ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString();

  opts.log(`\nOpen this URL in a browser and sign in with the Gmail account you want to link:\n\n  ${authUrl}\n`);
  opts.log(
    `Waiting for Google to redirect back to ${redirectUri} ...\n` +
      `(If your browser is on another machine, paste the full URL it ends up on here and press Enter.)\n`,
  );
  if (opts.openBrowser) openInBrowser(authUrl.toString());

  const onStdin = (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    try {
      if (!handleRedirect(new URL(text))) opts.log("That URL has no ?code= parameter; try again.");
    } catch {
      opts.log("That doesn't look like a URL; try again.");
    }
  };
  if (process.stdin.isTTY) {
    process.stdin.on("data", onStdin);
    process.stdin.resume();
  }

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
    process.stdin.off("data", onStdin);
    process.stdin.pause();
  }

  const res = await postForm(fetchImpl, TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new AuthError(`Code exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  if (!body.refresh_token) {
    throw new AuthError(
      "Google did not return a refresh token. Remove the app from https://myaccount.google.com/permissions and try again.",
    );
  }
  const scopes = body.scope ? body.scope.split(" ") : GMAIL_SCOPES;
  if (!GMAIL_SCOPES.every((s) => scopes.includes(s))) {
    throw new AuthError("Gmail access was not granted. Make sure to tick the Gmail permission on the consent screen.");
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, scopes };
}

function openInBrowser(url: string): void {
  import("node:child_process")
    .then(({ spawn }) => {
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]];
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
    })
    .catch(() => undefined);
}
