import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runInteractiveAuth, GMAIL_SCOPES } from "../src/oauth.js";

const client = { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" };

async function startFlow(tokenResponse: Record<string, unknown>) {
  let exchange: URLSearchParams | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    exchange = new URLSearchParams(String(init.body));
    return new Response(JSON.stringify(tokenResponse), { status: 200 });
  }) as typeof fetch;

  let authUrl: URL | undefined;
  let sawUrl!: () => void;
  const urlSeen = new Promise<void>((r) => (sawUrl = r));
  const log = (msg: string) => {
    const m = msg.match(/https:\/\/accounts\.google\.com\S+/);
    if (m) {
      authUrl = new URL(m[0]);
      sawUrl();
    }
  };
  const result = runInteractiveAuth(client, { openBrowser: false, log, fetchImpl });
  await urlSeen;
  return { result, authUrl: authUrl!, exchange: () => exchange! };
}

test("loopback flow exchanges the code with PKCE and returns the refresh token", async () => {
  const flow = await startFlow({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: GMAIL_SCOPES.join(" ") });
  const params = flow.authUrl.searchParams;
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("scope"), GMAIL_SCOPES.join(" "));
  const redirect = params.get("redirect_uri")!;
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);

  const res = await fetch(`${redirect}/?state=${params.get("state")}&code=the-code`);
  assert.match(await res.text(), /Signed in\. Return to the terminal/);

  const auth = await flow.result;
  assert.deepEqual(auth, { refreshToken: "rt", accessToken: "at", scopes: GMAIL_SCOPES });
  const form = flow.exchange();
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("redirect_uri"), redirect);
  const challenge = createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
  assert.equal(challenge, params.get("code_challenge"));
});

test("a redirect with the wrong state is rejected", async () => {
  const flow = await startFlow({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
  const redirect = flow.authUrl.searchParams.get("redirect_uri")!;
  const rejected = assert.rejects(flow.result, /state mismatch/);
  await fetch(`${redirect}/?state=forged&code=evil`);
  await rejected;
});

test("refuses tokens that don't include Gmail access", async () => {
  const flow = await startFlow({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid email" });
  const params = flow.authUrl.searchParams;
  const rejected = assert.rejects(flow.result, /Gmail access was not granted/);
  await fetch(`${params.get("redirect_uri")}/?state=${params.get("state")}&code=c`);
  await rejected;
});

test("the browser is opened without a shell, with the sign-in URL as one argument", async () => {
  const { browserCommand, openInBrowser } = await import("../src/oauth.js");
  const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=a&redirect_uri=http%3A%2F%2F127.0.0.1%3A5&state=x%26y";
  assert.deepEqual(browserCommand(url, "darwin"), ["/usr/bin/open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
  // Not `cmd /c start`, whose command-line parsing would cut the URL at the first "&".
  const [cmd, args] = browserCommand(url, "win32");
  assert.match(cmd, /rundll32(\.exe)?$/);
  assert.deepEqual(args, ["url.dll,FileProtocolHandler", url]);
  assert.equal(await openInBrowser("javascript:alert(1)"), false, "only web links are opened");
  assert.equal(await openInBrowser("file:///etc/passwd"), false);
});

test("a sign-in with a time limit gives up and stops listening", async () => {
  const { startLoopbackAuth } = await import("../src/oauth.js");
  const flow = await startLoopbackAuth(client, { timeoutMs: 50 });
  await assert.rejects(flow.result, /within 50 ms/);
  await assert.rejects(fetch(flow.redirectUri));
});
