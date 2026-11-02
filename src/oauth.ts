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

/** A sign-in in progress: the URL to open, and the outcome once Google redirects back. */
export interface LoopbackAuth<T> {
  authUrl: string;
  redirectUri: string;
  /** Settles when the user has signed in and `finish` has run, or when the flow fails, times out or is cancelled. */
  result: Promise<T>;
  /** Accepts the URL the browser ended up on, for when the browser can't reach this machine. */
  handleRedirect(url: URL): string | undefined;
  cancel(reason?: string): void;
}

export interface LoopbackAuthOptions<T> {
  loginHint?: string;
  fetchImpl?: FetchLike;
  /** Gives up (and stops listening) after this long. No limit when omitted. */
  timeoutMs?: number;
  /** Runs after the code exchange (e.g. stores the account); the browser tab waits for it. */
  finish?: (tokens: LinkedTokens) => Promise<T>;
  /** The text the browser tab shows once `finish` succeeded. */
  donePage?: (value: T) => string;
  /** Where the user goes back to, for the browser tab's messages ("the terminal", "Claude"). */
  returnTo?: string;
}

/**
 * Starts the OAuth "installed app" flow: a listener on 127.0.0.1 (random port) that receives Google's
 * redirect, and the consent URL to send the user to. The code is exchanged with PKCE for a refresh
 * token. Nothing is opened or printed here; callers decide how to show the URL.
 */
export async function startLoopbackAuth<T = LinkedTokens>(
  client: OAuthClientConfig,
  opts: LoopbackAuthOptions<T> = {},
): Promise<LoopbackAuth<T>> {
  const verifier = randomToken(48);
  const state = randomToken(16);
  const returnTo = opts.returnTo ?? "the terminal";

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
    return "ok";
  };

  let outcome: Promise<T> | undefined;
  const server = http.createServer((req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      res.end(text);
    };
    const message = handleRedirect(new URL(req.url ?? "/", "http://127.0.0.1"));
    if (message !== "ok") return reply(message ? 200 : 404, message ?? "Not found");
    // Answer once the account is really linked, so the tab tells the truth.
    outcome!.then(
      (value) =>
        reply(200, opts.donePage ? opts.donePage(value) : `Signed in. Return to ${returnTo} to finish linking the account; you can close this tab.`),
      (err: Error) => reply(200, `Linking failed: ${err.message}\n\nReturn to ${returnTo} for details; you can close this tab.`),
    );
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

  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          const minutes = Math.round(opts.timeoutMs! / 60_000);
          rejectCode(new AuthError(`Nobody finished signing in with Google within ${minutes >= 1 ? `${minutes} minute(s)` : `${opts.timeoutMs} ms`}.`));
        }, opts.timeoutMs);
  timer?.unref();

  outcome = (async () => {
    let code: string;
    try {
      code = await codePromise;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const tokens = await exchangeCode(client, { code, redirectUri, codeVerifier: verifier }, opts.fetchImpl);
    return opts.finish ? opts.finish(tokens) : (tokens as unknown as T);
  })();
  // Stop listening once the flow is over (the tab's answer is still sent: close() waits for it).
  const result = outcome.finally(() => server.close());
  result.catch(() => undefined); // callers handle the rejection; this only avoids an unhandled one

  return {
    authUrl,
    redirectUri,
    result,
    handleRedirect,
    cancel: (reason = "Sign-in was cancelled.") => rejectCode(new AuthError(reason)),
  };
}

/**
 * Runs the OAuth "installed app" flow from the CLI: starts a loopback listener, sends the user to
 * Google's consent screen, and exchanges the returned code (with PKCE) for a refresh token.
 * If the browser is on a different machine, the user can paste the final redirect URL instead.
 */
export async function runInteractiveAuth(
  client: OAuthClientConfig,
  opts: { openBrowser: boolean; loginHint?: string; log: (msg: string) => void; fetchImpl?: FetchLike },
): Promise<LinkedTokens> {
  const flow = await startLoopbackAuth(client, { loginHint: opts.loginHint, fetchImpl: opts.fetchImpl });
  const { authUrl, redirectUri } = flow;

  opts.log(`\nOpen this URL in a browser and sign in with the Gmail account you want to link:\n\n  ${authUrl}\n`);
  opts.log(
    `Waiting for Google to redirect back to ${redirectUri} ...\n` +
      (process.stdin.isTTY
        ? `(If your browser is on another machine, paste the full URL it ends up on here and press Enter.)\n`
        : ""),
  );
  if (opts.openBrowser) void openInBrowser(authUrl);

  const onStdin = (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    try {
      if (!flow.handleRedirect(new URL(text))) opts.log("That URL has no ?code= parameter; try again.");
    } catch {
      opts.log("That doesn't look like a URL; try again.");
    }
  };
  const readStdin = Boolean(process.stdin.isTTY);
  if (readStdin) {
    process.stdin.on("data", onStdin);
    process.stdin.resume();
  }
  try {
    return await flow.result;
  } finally {
    if (readStdin) {
      process.stdin.off("data", onStdin);
      process.stdin.pause();
    }
  }
}

/** How to open a URL in the default browser: the program and its arguments (the URL is one argument, never parsed by a shell). */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  // On Windows, `cmd /c start "" URL` would have cmd.exe parse the URL and split it at every "&"
  // (the consent URL has several); rundll32 hands it to the default browser verbatim.
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/**
 * Opens a URL in the user's default browser, without a shell. Resolves to false when that clearly
 * failed (no opener program, or it exited with an error), so the caller can show the URL instead.
 */
export async function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const { spawn } = await import("node:child_process");
  const [cmd, args] = browserCommand(url, platform);
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    } catch {
      return resolve(false);
    }
    // Openers normally hand the URL over and exit at once; one still running after a few seconds
    // has most likely started the browser itself.
    const timer = setTimeout(() => resolve(true), 3000);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.unref();
  });
}
