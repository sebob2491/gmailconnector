/** Node-only parts of Google sign-in: loading the OAuth client file and the CLI loopback flow. */
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { configDir } from "./accountStore.js";
import {
  AuthError,
  buildAuthUrl,
  exchangeCode,
  pkceChallenge,
  randomToken,
  type FetchLike,
  type LinkedTokens,
  type OAuthClientConfig,
} from "./google.js";

export * from "./google.js";

/**
 * Loads the Google OAuth client from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or from a
 * credentials.json downloaded from Google Cloud Console ("Desktop app" client type).
 */
export async function loadOAuthClient(credentialsPath?: string): Promise<OAuthClientConfig> {
  if (!credentialsPath && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  const file = credentialsPath ?? defaultCredentialsPath();
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

export function defaultCredentialsPath(): string {
  return process.env.GMAIL_MCP_CREDENTIALS ?? path.join(configDir(), "credentials.json");
}

/**
 * Saves the OAuth client where the MCP server looks for it, so a client given with --credentials or
 * environment variables also works when Claude launches the server (without the user's shell env).
 * Returns the path written, or undefined if that file already held this client.
 */
export async function persistOAuthClient(client: OAuthClientConfig): Promise<string | undefined> {
  const file = defaultCredentialsPath();
  try {
    const current = await loadOAuthClient(file);
    if (current.clientId === client.clientId && current.clientSecret === client.clientSecret) return undefined;
  } catch {
    /* missing or unreadable: write it */
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = { installed: { client_id: client.clientId, client_secret: client.clientSecret } };
  await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  return file;
}

/**
 * Runs the OAuth "installed app" flow: starts a loopback listener, sends the user to Google's
 * consent screen, and exchanges the returned code (with PKCE) for a refresh token.
 * If the browser is on a different machine, the user can paste the final redirect URL instead.
 */
export async function runInteractiveAuth(
  client: OAuthClientConfig,
  opts: { openBrowser: boolean; loginHint?: string; log: (msg: string) => void; fetchImpl?: FetchLike },
): Promise<LinkedTokens> {
  const verifier = randomToken(48);
  const state = randomToken(16);

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
    return "Signed in. Return to the terminal to finish linking the account; you can close this tab.";
  };

  const server = http.createServer((req, res) => {
    const message = handleRedirect(new URL(req.url ?? "/", "http://127.0.0.1"));
    res.writeHead(message ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = buildAuthUrl({
    clientId: client.clientId,
    redirectUri,
    state,
    codeChallenge: await pkceChallenge(verifier),
    loginHint: opts.loginHint,
  });

  opts.log(`\nOpen this URL in a browser and sign in with the Gmail account you want to link:\n\n  ${authUrl}\n`);
  opts.log(
    `Waiting for Google to redirect back to ${redirectUri} ...\n` +
      (process.stdin.isTTY
        ? `(If your browser is on another machine, paste the full URL it ends up on here and press Enter.)\n`
        : ""),
  );
  if (opts.openBrowser) openInBrowser(authUrl);

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

  return exchangeCode(client, { code, redirectUri, codeVerifier: verifier }, opts.fetchImpl);
}

function openInBrowser(url: string): void {
  import("node:child_process")
    .then(({ spawn }) => {
      // On Windows, `cmd /c start` would split the URL at every "&"; rundll32 takes it verbatim.
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
            : ["xdg-open", [url]];
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
    })
    .catch(() => undefined);
}
