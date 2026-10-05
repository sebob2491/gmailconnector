/**
 * End-to-end test of the hosted connector: runs the bundled Worker (dist-worker/index.js, built by
 * `wrangler deploy --dry-run`) in workerd via Miniflare, with Google faked through outboundService,
 * and walks the same OAuth + MCP flow claude.ai uses.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare, Request as MfRequest, Response as MfResponse } from "miniflare";
import { FakeGmail } from "./fakeGmail.js";
import { docx, pdf } from "./files.js";

const ORIGIN = "https://gmail-multi-mcp.tester.workers.dev";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PERSONAL = "me.personal@gmail.com";
const WORK = "me@work.example";
const STRANGER = "stranger@evil.example";

const crlf = (lines: string[]) => lines.join("\r\n");

/** A browser: follows nothing automatically, but keeps cookies like one. */
class Browser {
  cookies = new Map<string, string>();

  constructor(private mf: Miniflare) {}

  async fetch(pathOrUrl: string, init: { method?: string; form?: Record<string, string>; headers?: Record<string, string> } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : ORIGIN + pathOrUrl;
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await this.mf.dispatchFetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const [name, ...value] = pair.trim().split("=");
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get("Location") ?? "", headers: res.headers, text };
  }

  /** Plays Google: pretends the user signed in as `email` and follows the redirect back. */
  async googleSignIn(googleUrl: string, fake: FakeGmail, email: string) {
    const url = new URL(googleUrl);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const code = `code-${randomBytes(6).toString("hex")}`;
    fake.codes.set(code, email);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    return this.fetch(callback.toString());
  }
}

/** The accounts page's row for one account. */
const accountRow = (html: string, email: string) => html.split("<li>").find((row) => row.includes(`<span class="email">${email}`)) ?? "";
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? "";
const unescape = (html: string) => html.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
/** The href of the link labelled `label` (e.g. a "Back to Claude" button). */
const linkTo = (html: string, label: string) => unescape(new RegExp(`href="([^"]+)">${label}<`).exec(html)?.[1] ?? "");

/** Answers the consent page the way a browser would: posts its form, CSRF token included, to its action URL. */
function answerConsent(browser: Browser, consentHtml: string, decision: "approve" | "deny" = "approve") {
  const action = unescape(/<form method="post" action="([^"]+)"/.exec(consentHtml)?.[1] ?? "/authorize");
  return browser.fetch(action, { form: { csrf: field(consentHtml, "csrf"), decision } });
}

/**
 * A second Worker sharing the connector's KV, running the same OAuth library, so tests can create
 * Claude connections the way older versions of the connector did and inspect what a token carries.
 */
const MINTER = `
import { getOAuthApi } from "./oauth-provider.js";
export default {
  async fetch(request, env) {
    const body = await request.json();
    const api = getOAuthApi({
      apiRoute: "/mcp",
      apiHandler: { fetch: () => new Response(null) },
      defaultHandler: { fetch: () => new Response(null) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["gmail"],
      resourceMetadata: { resource: body.origin + "/mcp", authorization_servers: [body.origin], scopes_supported: ["gmail"] },
    }, env);
    if (body.unwrap) return Response.json(await api.unwrapToken(body.unwrap));
    const { redirectTo } = await api.completeAuthorization({
      request: body.request, userId: "owner", metadata: {}, scope: ["gmail"], props: body.props, revokeExistingGrants: false,
    });
    return Response.json({ redirectTo });
  },
};`;

const COMPAT = { compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"] };

/** Google's revoke endpoint fails while this is set (tests a revoke Google doesn't confirm). */
let failRevoke = false;
/**
 * While set, refreshing a Google token fails: "unreachable" makes the call itself fail (Miniflare
 * reports that to the Worker as an HTTP 500), 503 is Google answering with a server error.
 */
let refreshFailure: "unreachable" | 503 | undefined;

async function startWorker(fakeGoogle: FakeGmail, bindings: Record<string, string>): Promise<Miniflare> {
  const instance = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "connector",
          modules: true,
          scriptPath: "dist-worker/index.js",
          ...COMPAT,
          kvNamespaces: ["OAUTH_KV"],
          bindings: { GOOGLE_CLIENT_ID: "google-client-id", GOOGLE_CLIENT_SECRET: "google-client-secret", ...bindings },
          outboundService: async (req: MfRequest) => {
            if (failRevoke && req.url === "https://oauth2.googleapis.com/revoke") return new MfResponse("unavailable", { status: 503 });
            const body = req.method === "GET" ? undefined : await req.text();
            if (refreshFailure && req.url === "https://oauth2.googleapis.com/token" && body?.includes("grant_type=refresh_token")) {
              if (refreshFailure === "unreachable") throw new Error("connection reset");
              return new MfResponse("upstream error", { status: 503 });
            }
            const res = await fakeGoogle.fetch(req.url, {
              method: req.method,
              headers: Object.fromEntries(req.headers),
              body,
            });
            return new MfResponse(await res.arrayBuffer(), { status: res.status, headers: Object.fromEntries(res.headers) });
          },
        },
        {
          name: "minter",
          modules: [
            { type: "ESModule", path: "minter.mjs", contents: MINTER },
            {
              type: "ESModule",
              path: "oauth-provider.js",
              contents: readFileSync("node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js", "utf8"),
            },
          ],
          ...COMPAT,
          kvNamespaces: { OAUTH_KV: "OAUTH_KV" },
        },
      ],
    }),
  );
  await instance.ready;
  return instance;
}

/** Every KV entry, to check that a request wrote nothing. */
async function kvSnapshot(instance: Miniflare): Promise<Map<string, string | null>> {
  const kv = await instance.getKVNamespace("OAUTH_KV");
  const snapshot = new Map<string, string | null>();
  for (const key of (await kv.list()).keys) snapshot.set(key.name, (await kv.get(key.name, "text")) as string | null);
  return snapshot;
}

let mf: Miniflare;
let fake: FakeGmail;

before(async () => {
  fake = new FakeGmail();
  const personal = fake.addMailbox(PERSONAL, "rt-personal");
  const work = fake.addMailbox(WORK, "rt-work");
  fake.addMailbox(STRANGER, "rt-stranger");
  for (let i = 3; i <= 5; i++) {
    const mb = fake.addMailbox(`extra${i}@example.com`, `rt-extra${i}`);
    for (let t = 0; t < 20; t++) {
      fake.deliver(mb, crlf([`From: s${t}@example.com`, `To: extra${i}@example.com`, `Subject: T${t}`, "", "x"]), {
        threadId: `x${i}-${t}`,
      });
    }
  }
  fake.deliver(
    personal,
    crlf(["From: Alice <alice@example.com>", `To: ${PERSONAL}`, "Subject: Lunch?", "Content-Type: text/plain", "", "Lunch Thursday?"]),
    { id: "p1", threadId: "pt1" },
  );
  fake.deliver(
    work,
    crlf(["From: Boss <boss@work.example>", `To: ${WORK}`, "Subject: Q3 report", "Content-Type: text/plain", "", "Numbers attached."]),
    { id: "w1", threadId: "wt1" },
  );

  mf = await startWorker(fake, { ALLOWED_EMAILS: PERSONAL });
});

after(async () => {
  await mf?.dispose();
});

async function registerClient(redirectUri = CLAUDE_CALLBACK, on = mf) {
  const res = await on.dispatchFetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, redirectUri = CLAUDE_CALLBACK) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state-123",
    scope: "gmail",
    resource: `${ORIGIN}/mcp`,
  });
  return `/authorize?${params}`;
}

let accessToken = "";
let firstClientId = "";
let mcpId = 0;
async function mcp(method: string, params: Record<string, unknown> = {}, token = accessToken) {
  const res = await mf.dispatchFetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method, params }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return callToolWith(accessToken, name, args);
}

async function callToolWith(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp("tools/call", { name, arguments: args }, token);
  const text = res.result.content[0].text as string;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: Boolean(res.result.isError), text, json };
}

/** Runs Claude's whole connect flow as the owner and returns the new access token. */
async function connectAsOwner(clientId: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const browser = new Browser(mf);
  const consent = await browser.fetch(authorizeUrl(clientId, challenge));
  const toGoogle = await answerConsent(browser, consent.text);
  const back = await browser.googleSignIn(toGoogle.location, fake, PERSONAL);
  assert.equal(back.status, 303, back.text);
  const page = await browser.fetch("/accounts");
  const done = await browser.fetch("/accounts/done", { form: { csrf: field(page.text, "csrf") } });
  const code = new URL(done.location).searchParams.get("code")!;
  return (await exchangeCode(clientId, code, verifier)).access_token;
}

async function tokenRequest(form: Record<string, string>) {
  const res = await mf.dispatchFetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function exchangeCode(clientId: string, code: string, verifier: string) {
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { access_token: string; refresh_token: string };
}

const refreshClaudeToken = (clientId: string, refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

/** An MCP request whose status may be an error. */
async function mcpStatus(token: string) {
  const res = await mf.dispatchFetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method: "tools/list", params: {} }),
  });
  return { status: res.status, wwwAuthenticate: res.headers.get("WWW-Authenticate") ?? "", text: await res.text() };
}

async function minter(body: Record<string, unknown>) {
  const res = await (await mf.getWorker("minter")).fetch("https://minter/", {
    method: "POST",
    body: JSON.stringify({ origin: ORIGIN, ...body }),
  });
  return (await res.json()) as any;
}

/** Creates a Claude connection straight through the OAuth library, with the given props, as older versions did. */
async function connectWithProps(props: Record<string, unknown>, clientId = firstClientId) {
  const verifier = randomBytes(32).toString("base64url");
  const request = {
    responseType: "code",
    clientId,
    redirectUri: CLAUDE_CALLBACK,
    scope: ["gmail"],
    state: "s",
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256",
    resource: `${ORIGIN}/mcp`,
  };
  const { redirectTo } = await minter({ request, props });
  return exchangeCode(clientId, new URL(redirectTo).searchParams.get("code")!, verifier);
}

/** Signs a new browser in as the owner and returns it with the accounts page's CSRF token. */
async function ownerBrowser() {
  const browser = new Browser(mf);
  const back = await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, PERSONAL);
  assert.equal(back.status, 303, back.text);
  const page = await browser.fetch("/accounts");
  return { browser, csrf: field(page.text, "csrf") };
}

describe("hosted connector (Cloudflare Worker)", () => {
  test("setup page shows the URLs to paste into Google and Claude", async () => {
    const res = await new Browser(mf).fetch("/");
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`${ORIGIN}/google/callback`));
    assert.match(res.text, new RegExp(`${ORIGIN}/mcp`));
    assert.match(res.text, /Not signed in yet/);
    assert.match(res.text, /Say who owns it <span class="status ok">/, "ALLOWED_EMAILS is set in these tests");
    assert.ok(res.text.indexOf("ALLOWED_EMAILS") < res.text.indexOf("Add it to Claude"), "set before signing in");
    assert.doesNotMatch(res.text, new RegExp(PERSONAL), "the allowed addresses aren't shown on this public page");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    // What Google's Branding page needs before the app can be published.
    assert.match(res.text, new RegExp(`${ORIGIN}/privacy`));
    assert.match(res.text, /<code>tester\.workers\.dev<\/code>/);
    const privacy = await new Browser(mf).fetch("/privacy");
    assert.equal(privacy.status, 200);
    assert.match(privacy.text, /Privacy policy/);
    assert.match(privacy.text, /gmail\.modify/);
  });

  test("the MCP endpoint demands OAuth and advertises discovery metadata", async () => {
    const res = await mf.dispatchFetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("WWW-Authenticate")!, /resource_metadata="https:\/\/gmail-multi-mcp\.tester\.workers\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm = (await (await mf.dispatchFetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    assert.equal(prm.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    const as = (await (await mf.dispatchFetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any;
    assert.equal(as.authorization_endpoint, `${ORIGIN}/authorize`);
    assert.equal(as.registration_endpoint, `${ORIGIN}/register`);
  });

  test("connecting from Claude: consent, Google sign-in for two accounts, then tokens", async () => {
    const clientId = await registerClient();
    firstClientId = clientId;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const browser = new Browser(mf);

    const consent = await browser.fetch(authorizeUrl(clientId, challenge));
    assert.equal(consent.status, 200, consent.text);
    assert.match(consent.text, /Connect your Gmail to Claude/);
    assert.match(consent.text, /Access will be sent to <b>claude\.ai<\/b>/);

    const toGoogle = await answerConsent(browser, consent.text);
    assert.equal(toGoogle.status, 302, toGoogle.text);
    const google = new URL(toGoogle.location);
    assert.equal(google.searchParams.get("redirect_uri"), `${ORIGIN}/google/callback`);
    assert.equal(google.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.modify");
    assert.equal(google.searchParams.get("access_type"), "offline");
    assert.equal(google.searchParams.get("code_challenge_method"), "S256");

    const back = await browser.googleSignIn(toGoogle.location, fake, PERSONAL);
    assert.equal(back.status, 303, back.text);
    assert.equal(back.location, `${ORIGIN}/accounts?linked=${encodeURIComponent(PERSONAL)}`);
    const exchange = fake.codeExchanges.at(-1)!;
    assert.equal(exchange.get("redirect_uri"), `${ORIGIN}/google/callback`);
    assert.equal(exchange.get("client_id"), "google-client-id");

    let page = await browser.fetch(back.location);
    assert.match(page.text, /Linked me\.personal@gmail\.com/);
    assert.match(page.text, /Done — connect to Claude/);

    const toGoogle2 = await browser.fetch("/accounts/link", { form: { csrf: field(page.text, "csrf") } });
    assert.equal(toGoogle2.status, 302);
    const back2 = await browser.googleSignIn(toGoogle2.location, fake, WORK);
    assert.equal(back2.status, 303, back2.text);
    assert.ok(
      back2.headers.getSetCookie().some((c) => c.startsWith("__Host-gmail-connector=") && /Max-Age=1800/.test(c)),
      "saving the session extends its cookie too",
    );
    page = await browser.fetch("/accounts");
    assert.ok(page.text.includes(PERSONAL) && page.text.includes(WORK));
    assert.match(page.text, /me\.personal@gmail\.com<span class="tag">owner<\/span>/);

    const done = await browser.fetch("/accounts/done", { form: { csrf: field(page.text, "csrf") } });
    assert.equal(done.status, 302, done.text);
    const toClaude = new URL(done.location);
    assert.equal(toClaude.origin + toClaude.pathname, CLAUDE_CALLBACK);
    assert.equal(toClaude.searchParams.get("state"), "claude-state-123");
    assert.equal(toClaude.searchParams.get("iss"), ORIGIN);

    const tokenRes = await mf.dispatchFetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: toClaude.searchParams.get("code")!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as any;
    assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
    assert.ok(tokens.access_token && tokens.refresh_token);
    accessToken = tokens.access_token;
    const unwrapped = await minter({ unwrap: accessToken });
    assert.deepEqual(unwrapped.grant.props, { email: PERSONAL }, "the connection records who approved it");
  });

  test("Claude can use both accounts through the MCP endpoint", async () => {
    const init = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "1" },
    });
    assert.equal(init.result.serverInfo.name, "gmail-multi");
    const tools = await mcp("tools/list");
    assert.equal(tools.result.tools.length, 32);

    const accounts = await callTool("list_accounts");
    assert.deepEqual(accounts.json.accounts.map((a: any) => a.email), [PERSONAL, WORK]);
    assert.match(accounts.json.manageAccounts, new RegExp(`${ORIGIN}/accounts`));

    const search = await callTool("search_threads", {});
    assert.equal(search.isError, false, search.text);
    const subjects = Object.fromEntries(
      search.json.accounts.map((a: any) => [a.account, a.threads.map((t: any) => t.subject)]),
    );
    assert.deepEqual(subjects, { [PERSONAL]: ["Lunch?"], [WORK]: ["Q3 report"] });

    const sent = await callTool("reply", { account: WORK, messageId: "w1", body: "Thanks!" });
    assert.equal(sent.isError, false, sent.text);
    assert.equal(fake.sentBy(WORK).length, 1);
    assert.match(fake.sentBy(WORK)[0].raw, /Subject: Re: Q3 report/);

    const refused = await callTool("send_message", { to: ["x@example.com"], body: "hi" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /`account` is required when sending/);
  });

  test("attachments are read inside the Worker runtime (PDF and Word)", async () => {
    const personal = fake.mailboxes.find((m) => m.email === PERSONAL)!;
    const attachment = (name: string, type: string, data: Buffer) => [
      "--A",
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      data.toString("base64"),
    ];
    fake.deliver(
      personal,
      crlf([
        "From: hr@example.com",
        `To: ${PERSONAL}`,
        "Subject: Paperwork",
        'Content-Type: multipart/mixed; boundary="A"',
        "",
        "--A",
        "Content-Type: text/plain",
        "",
        "Attached.",
        ...attachment("pay.pdf", "application/pdf", pdf(["BT 72 720 Td (Net pay this period: $2,000.00) Tj ET"])),
        ...attachment("offer.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx(["Offer letter", "Salary: $80,000"])),
        "--A--",
      ]),
      { id: "paperwork" },
    );
    const read = async (filename: string) =>
      (await mcp("tools/call", { name: "get_attachment", arguments: { account: PERSONAL, messageId: "paperwork", filename } })).result;
    const pdfResult = await read("pay.pdf");
    assert.equal(pdfResult.content[1].text, "Net pay this period: $2,000.00");
    assert.equal(pdfResult.content.length, 2);
    const wordResult = await read("offer.docx");
    assert.equal(wordResult.content[1].text, "Offer letter\nSalary: $80,000");
  });

  test("GET on the MCP endpoint is rejected (stateless server)", async () => {
    const res = await mf.dispatchFetch(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(res.status, 405);
  });

  test("a stranger's Google account can't take over the connector", async () => {
    const browser = new Browser(mf);
    const toGoogle = await browser.fetch("/accounts");
    assert.equal(toGoogle.status, 302);
    const back = await browser.googleSignIn(toGoogle.location, fake, STRANGER);
    assert.equal(back.status, 403);
    assert.match(back.text, /belongs to someone else/);
    assert.ok(fake.revokeCalls.includes("rt-stranger"), "the stranger's new token is revoked");
    const accounts = await callTool("list_accounts");
    assert.equal(accounts.json.accounts.length, 2);
  });

  test("a linked account that isn't the owner can't sign in", async () => {
    const browser = new Browser(mf);
    const back = await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, WORK);
    assert.equal(back.status, 403);
    assert.match(back.text, /Sign in with the Google account that set it up/);
    assert.ok(!fake.revokeCalls.includes("rt-work"), "revoking would also break the linked work account");
    assert.equal((await callTool("list_accounts")).json.accounts.length, 2, "the work account stays linked");
    assert.equal((await callTool("search_threads", { account: WORK })).isError, false);
  });

  test("a refused sign-in while connecting can go back to Claude", async () => {
    const browser = new Browser(mf);
    const consent = await browser.fetch(authorizeUrl(firstClientId, "y".repeat(43)));
    const toGoogle = await answerConsent(browser, consent.text);
    const refused = await browser.googleSignIn(toGoogle.location, fake, STRANGER);
    assert.equal(refused.status, 403);
    const url = new URL(linkTo(refused.text, "Back to Claude"));
    assert.equal(url.origin + url.pathname, CLAUDE_CALLBACK);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("state"), "claude-state-123");
  });

  test("connecting again doesn't disconnect an earlier connection", async () => {
    const second = await connectAsOwner(firstClientId);
    assert.notEqual(second, accessToken);
    assert.equal((await mcp("tools/list", {}, accessToken)).result.tools.length, 32, "first connection still works");
    assert.equal((await mcp("tools/list", {}, second)).result.tools.length, 32);
  });

  test("searching five linked accounts stays under Cloudflare's 50-call limit", async () => {
    const browser = new Browser(mf);
    await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, PERSONAL);
    for (let i = 3; i <= 5; i++) {
      const page = await browser.fetch("/accounts");
      const toGoogle = await browser.fetch("/accounts/link", { form: { csrf: field(page.text, "csrf") } });
      assert.equal((await browser.googleSignIn(toGoogle.location, fake, `extra${i}@example.com`)).status, 303);
    }
    fake.outboundCalls = 0;
    const res = await callTool("search_threads", {});
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.accounts.length, 5);
    assert.ok(res.json.accounts.every((a: any) => !a.error), res.text);
    assert.ok(fake.outboundCalls <= 50, `made ${fake.outboundCalls} outbound calls`);
    // Unlink the extra accounts again for the tests below.
    for (let i = 3; i <= 5; i++) {
      const page = await browser.fetch("/accounts");
      await browser.fetch("/accounts/remove", { form: { csrf: field(page.text, "csrf"), email: `extra${i}@example.com` } });
    }
    assert.equal((await callTool("list_accounts")).json.accounts.length, 2);
  });

  test("a Google redirect replayed in another browser is refused", async () => {
    const victim = new Browser(mf);
    const toGoogle = await victim.fetch("/accounts");
    const attacker = new Browser(mf);
    const res = await attacker.googleSignIn(toGoogle.location, fake, PERSONAL);
    assert.equal(res.status, 400);
    assert.match(res.text, /Sign-in link expired/);
  });

  test("only Claude may receive tokens", async () => {
    const evilClient = await registerClient("https://evil.example/callback");
    const res = await new Browser(mf).fetch(authorizeUrl(evilClient, "x".repeat(43), "https://evil.example/callback"));
    assert.equal(res.status, 403);
    assert.match(res.text, /only works with Claude/);
  });

  test("a claude.ai address with another scheme can't receive tokens", async () => {
    // `evilapp://claude.ai/…` has the host claude.ai, but the code would go to whichever app owns
    // the evilapp: scheme; plain http could be read on the way.
    for (const redirect of ["evilapp://claude.ai/cb", "http://claude.ai/cb", "intent://claude.ai/cb"]) {
      const client = await registerClient(redirect);
      const res = await new Browser(mf).fetch(authorizeUrl(client, "x".repeat(43), redirect));
      assert.equal(res.status, 403, redirect);
      assert.match(res.text, /only works with Claude/);
      assert.doesNotMatch(res.text, /Continue with Google/);
      // Request errors aren't sent there either.
      const error = await new Browser(mf).fetch(authorizeUrl(client, "x".repeat(43), redirect).replace("response_type=code", "response_type=token"));
      assert.notEqual(error.status, 302, redirect);
    }
    // A Claude app on this computer may use plain http to a loopback address, with a warning.
    const local = "http://localhost:33418/callback";
    const res = await new Browser(mf).fetch(authorizeUrl(await registerClient(local), "x".repeat(43), local));
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /This sends access to an app on your computer/);
  });

  test("visitors who haven't signed in write nothing to storage", async () => {
    const before = await kvSnapshot(mf);
    const visitor = new Browser(mf);
    await visitor.fetch("/");
    for (let i = 0; i < 3; i++) assert.equal((await visitor.fetch("/accounts")).status, 302);
    // Starting to connect from Claude, up to Google's sign-in page.
    const consent = await visitor.fetch(authorizeUrl(firstClientId, "z".repeat(43)));
    assert.equal(consent.status, 200);
    const toGoogle = await answerConsent(visitor, consent.text);
    assert.equal(toGoogle.status, 302);
    // Cancelling on the consent page.
    const declined = await answerConsent(visitor, (await visitor.fetch(authorizeUrl(firstClientId, "z".repeat(43)))).text, "deny");
    assert.equal(new URL(declined.location).searchParams.get("error"), "access_denied");
    // A stranger who signs in with Google is turned away without storing anything.
    assert.equal((await visitor.googleSignIn(toGoogle.location, fake, STRANGER)).status, 403);
    // Made-up callbacks.
    assert.equal((await visitor.fetch(`/google/callback?state=${"a".repeat(32)}&code=x`)).status, 400);
    assert.equal((await visitor.fetch("/google/callback")).status, 400);
    assert.deepEqual(await kvSnapshot(mf), before);
  });

  test("the consent form can't be submitted from another site", async () => {
    const browser = new Browser(mf);
    const consent = await browser.fetch(authorizeUrl(firstClientId, "z".repeat(43)));
    const action = unescape(/<form method="post" action="([^"]+)"/.exec(consent.text)![1]);
    // Another site's form can't read the token or send this site's (SameSite) cookie.
    const forged = await new Browser(mf).fetch(action, { form: { csrf: field(consent.text, "csrf"), decision: "approve" } });
    assert.equal(forged.status, 400);
    assert.match(forged.text, /This page expired/);
    const wrongToken = await browser.fetch(action, { form: { csrf: "b".repeat(32), decision: "approve" } });
    assert.equal(wrongToken.status, 400);
  });

  test("connections made before the approving address was recorded keep working", async () => {
    // Older versions stored only { owner: true }.
    const tokens = await connectWithProps({ owner: true });
    assert.equal((await mcpStatus(tokens.access_token)).status, 200);
    const refreshed = await refreshClaudeToken(firstClientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal((await mcp("tools/list", {}, refreshed.body.access_token)).result.tools.length > 0, true);
  });

  test("a connection approved by an address that may no longer sign in is ended", async () => {
    // As if STRANGER had been in ALLOWED_EMAILS when connecting, and was taken off since.
    const tokens = await connectWithProps({ email: STRANGER });
    const res = await mcpStatus(tokens.access_token);
    assert.equal(res.status, 401, res.text);
    assert.match(res.wwwAuthenticate, /^Bearer error="invalid_token"/);
    assert.match(res.wwwAuthenticate, /resource_metadata="https:\/\/gmail-multi-mcp\.tester\.workers\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(JSON.parse(res.text).error.message, /stranger@evil\.example.*Reconnect the connector in Claude/);
    // The connection is revoked, so Claude can't just refresh and retry: it has to reconnect.
    assert.equal((await refreshClaudeToken(firstClientId, tokens.refresh_token)).status, 400);
    assert.equal((await mcpStatus(tokens.access_token)).status, 401);
    // The owner's own connection is unaffected.
    assert.equal((await mcpStatus(accessToken)).status, 200);
  });

  test("request errors are never redirected to a site that isn't Claude", async () => {
    const evilClient = await registerClient("https://evil.example/callback");
    const url = authorizeUrl(evilClient, "x".repeat(43), "https://evil.example/callback").replace(
      "response_type=code",
      "response_type=token",
    );
    const res = await new Browser(mf).fetch(url);
    assert.notEqual(res.status, 302);
    assert.doesNotMatch(res.location, /evil\.example/);
  });

  test("the accounts page shows which accounts work, and Re-link fixes one that doesn't", async () => {
    const kv = await mf.getKVNamespace("OAUTH_KV");
    // The work account's stored token has stopped working (e.g. its password was changed).
    const rec = JSON.parse((await kv.get("gmail:owner", "text")) as string);
    rec.accounts.find((a: any) => a.email === WORK).refreshToken = "rt-work-dead";
    await kv.put("gmail:owner", JSON.stringify(rec));

    const { browser, csrf } = await ownerBrowser();
    const before = await kvSnapshot(mf);
    fake.outboundCalls = 0;
    const page = await browser.fetch("/accounts");
    assert.equal(page.status, 200);
    assert.equal(fake.outboundCalls, 2, "one token refresh per account");
    assert.deepEqual(await kvSnapshot(mf), before, "checking writes nothing");
    assert.match(accountRow(page.text, PERSONAL), /class="health ok">Working</);
    assert.doesNotMatch(accountRow(page.text, PERSONAL), /Re-link/);
    const work = accountRow(page.text, WORK);
    assert.match(work, /class="health bad">Needs re-link/);
    assert.match(work, /<form method="post" action="\/accounts\/link"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="email" value="me@work\.example"><button[^>]*>Re-link</);

    // Re-link needs the session's CSRF token, like every form on the page.
    assert.match((await browser.fetch("/accounts/link", { form: { csrf: "wrong", email: WORK } })).text, /Session expired/);
    const toGoogle = await browser.fetch("/accounts/link", { form: { csrf, email: WORK } });
    assert.equal(toGoogle.status, 302);
    assert.equal(new URL(toGoogle.location).searchParams.get("login_hint"), WORK, "Google preselects the account");
    const back = await browser.googleSignIn(toGoogle.location, fake, WORK);
    assert.equal(back.location, `${ORIGIN}/accounts?linked=${encodeURIComponent(WORK)}`);
    const relinked = JSON.parse((await kv.get("gmail:owner", "text")) as string);
    assert.equal(relinked.accounts.find((a: any) => a.email === WORK).refreshToken, "rt-work", "the new token replaces the dead one");
    const after = await browser.fetch(back.location);
    assert.match(accountRow(after.text, WORK), /class="health ok">Working</);

    // "Link another" still sends no hint.
    const another = await browser.fetch("/accounts/link", { form: { csrf } });
    assert.equal(new URL(another.location).searchParams.get("login_hint"), null);
  });

  test("the accounts page still shows when Google can't be reached", async () => {
    const { browser } = await ownerBrowser();
    for (const failure of ["unreachable", 503] as const) {
      refreshFailure = failure;
      try {
        const page = await browser.fetch("/accounts");
        assert.equal(page.status, 200, page.text);
        for (const email of [PERSONAL, WORK]) {
          assert.match(accountRow(page.text, email), /class="health warn">Couldn't check <span class="reason">[^<]+</, email);
          assert.doesNotMatch(accountRow(page.text, email), /Re-link/);
        }
        if (failure === 503) assert.match(page.text, /Google answered with an error \(HTTP 503\)/);
      } finally {
        refreshFailure = undefined;
      }
    }
  });

  test("account-page forms need the session's CSRF token", async () => {
    const browser = new Browser(mf);
    const back = await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, PERSONAL);
    assert.equal(back.status, 303);
    const res = await browser.fetch("/accounts/remove", { form: { csrf: "wrong", email: WORK } });
    assert.match(res.text, /Session expired/);
    assert.equal((await callTool("list_accounts")).json.accounts.length, 2);
  });

  test("the owner can remove an account later from /accounts", async () => {
    const browser = new Browser(mf);
    const back = await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, PERSONAL);
    assert.equal(back.status, 303, back.text);
    const page = await browser.fetch("/accounts");
    assert.doesNotMatch(page.text, /Done — connect/);
    const removed = await browser.fetch("/accounts/remove", { form: { csrf: field(page.text, "csrf"), email: WORK } });
    assert.equal(removed.status, 303);
    assert.ok(fake.revokeCalls.includes("rt-work"));
    const accounts = await callTool("list_accounts");
    assert.deepEqual(accounts.json.accounts.map((a: any) => a.email), [PERSONAL]);
  });

  test("removing an account says so when Google doesn't confirm the revoke", async () => {
    const { browser, csrf } = await ownerBrowser();
    const toGoogle = await browser.fetch("/accounts/link", { form: { csrf } });
    assert.equal((await browser.googleSignIn(toGoogle.location, fake, "extra3@example.com")).status, 303);
    failRevoke = true;
    try {
      const removed = await browser.fetch("/accounts/remove", { form: { csrf, email: "extra3@example.com" } });
      assert.equal(removed.status, 303);
      const page = await browser.fetch(removed.location);
      assert.match(page.text, /class="notice warn">Removed extra3@example\.com, but Google didn(&#39;|')t confirm/);
      assert.match(page.text, /href="https:\/\/myaccount\.google\.com\/permissions"/);
    } finally {
      failRevoke = false;
    }
    assert.ok(!(await callTool("list_accounts")).json.accounts.some((a: any) => a.email === "extra3@example.com"));
  });

  test("a revoked Google authorization tells Claude where to re-link", async () => {
    fake.revoked.add("rt-personal");
    const res = await callTool("search_threads", { account: PERSONAL });
    assert.equal(res.isError, true);
    assert.match(res.text, new RegExp(`Re-link it at ${ORIGIN}/accounts`));
    fake.revoked.delete("rt-personal");
  });

  test("signing in doesn't re-link an account that was removed", async () => {
    const browser = new Browser(mf);
    await browser.googleSignIn((await browser.fetch("/accounts")).location, fake, PERSONAL);
    let page = await browser.fetch("/accounts");
    await browser.fetch("/accounts/remove", { form: { csrf: field(page.text, "csrf"), email: PERSONAL } });
    assert.deepEqual((await callTool("list_accounts")).json.accounts, []);

    // The owner signs in again just to manage accounts: that must not bring the account back.
    const again = new Browser(mf);
    const back = await again.googleSignIn((await again.fetch("/accounts")).location, fake, PERSONAL);
    assert.equal(back.status, 303);
    page = await again.fetch(back.location);
    assert.match(page.text, /isn(&#39;|')t linked/);
    assert.deepEqual((await callTool("list_accounts")).json.accounts, []);

    // Linking it on purpose works.
    const toGoogle = await again.fetch("/accounts/link", { form: { csrf: field(page.text, "csrf") } });
    assert.equal((await again.googleSignIn(toGoogle.location, fake, PERSONAL)).status, 303);
    assert.deepEqual((await callTool("list_accounts")).json.accounts.map((a: any) => a.email), [PERSONAL]);
  });

  test("Disconnect Claude ends every Claude connection", async () => {
    const second = await connectAsOwner(await registerClient());
    const legacy = await connectWithProps({ owner: true });
    for (const token of [accessToken, second, legacy.access_token]) assert.equal((await mcpStatus(token)).status, 200);

    const { browser, csrf } = await ownerBrowser();
    const page = await browser.fetch("/accounts");
    assert.match(page.text, /Disconnect Claude/);
    const res = await browser.fetch("/accounts/disconnect", { form: { csrf } });
    assert.equal(res.status, 303);
    const after = await browser.fetch(res.location);
    assert.match(after.text, /Disconnected Claude \(\d+ connections\)/);

    for (const token of [accessToken, second, legacy.access_token]) assert.equal((await mcpStatus(token)).status, 401);
    assert.equal((await refreshClaudeToken(firstClientId, legacy.refresh_token)).status, 400);
    assert.deepEqual((await callToolWith(await connectAsOwner(firstClientId), "list_accounts")).json.accounts.map((a: any) => a.email), [PERSONAL], "connecting again works");
    // The linked accounts stay linked, and a second click finds nothing left to disconnect except the new one.
    const again = await browser.fetch((await browser.fetch("/accounts/disconnect", { form: { csrf } })).location);
    assert.match(again.text, /Disconnected Claude \(1 connection\)/);
  });
});

describe("a new connector without ALLOWED_EMAILS", () => {
  let mf2: Miniflare;
  let fake2: FakeGmail;
  before(async () => {
    fake2 = new FakeGmail();
    fake2.addMailbox(PERSONAL, "rt-personal");
    fake2.addMailbox(STRANGER, "rt-stranger");
    mf2 = await startWorker(fake2, {});
  });
  after(async () => {
    await mf2?.dispose();
  });

  test("refuses every sign-in until ALLOWED_EMAILS is set, so nobody can claim it first", async () => {
    const setup = await new Browser(mf2).fetch("/");
    assert.match(setup.text, /Say who owns it <span class="status todo">/);

    const browser = new Browser(mf2);
    const refused = await browser.googleSignIn((await browser.fetch("/accounts")).location, fake2, PERSONAL);
    assert.equal(refused.status, 403);
    assert.match(refused.text, /add a variable named ALLOWED_EMAILS with your Gmail address/);
    assert.ok(fake2.revokeCalls.includes("rt-personal"), "the unneeded Google grant is revoked");
    assert.equal(await (await mf2.getKVNamespace("OAUTH_KV")).get("gmail:owner"), null, "nobody became the owner");

    // The same while connecting from Claude, with a way back to Claude.
    const clientId = await registerClient(CLAUDE_CALLBACK, mf2);
    const claude = new Browser(mf2);
    const consent = await claude.fetch(authorizeUrl(clientId, "x".repeat(43)));
    const toGoogle = await answerConsent(claude, consent.text);
    const refusedAgain = await claude.googleSignIn(toGoogle.location, fake2, STRANGER);
    assert.equal(refusedAgain.status, 403);
    assert.match(refusedAgain.text, /ALLOWED_EMAILS/);
    assert.equal(new URL(linkTo(refusedAgain.text, "Back to Claude")).searchParams.get("error"), "access_denied");
  });

  test("a connector that already has an owner works as before", async () => {
    // Claimed by an older version, before ALLOWED_EMAILS was required.
    await (await mf2.getKVNamespace("OAUTH_KV")).put("gmail:owner", JSON.stringify({ version: 1, owner: PERSONAL, accounts: [] }));
    const owner = new Browser(mf2);
    const back = await owner.googleSignIn((await owner.fetch("/accounts")).location, fake2, PERSONAL);
    assert.equal(back.status, 303, back.text);
    assert.equal((await owner.fetch(back.location)).status, 200);
    const stranger = new Browser(mf2);
    const refused = await stranger.googleSignIn((await stranger.fetch("/accounts")).location, fake2, STRANGER);
    assert.equal(refused.status, 403);
    assert.match(refused.text, /belongs to someone else/);
  });
});
