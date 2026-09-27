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
  assert.match(await res.text(), /Account linked/);

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
