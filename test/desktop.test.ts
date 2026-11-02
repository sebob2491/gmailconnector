import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AccountStore } from "../src/accountStore.js";
import {
  DESKTOP_MANAGE_HINT,
  DESKTOP_RELINK_HINT,
  NO_CLIENT_MESSAGE,
  registerAccountTools,
  resolveOAuthClient,
  USER_CLIENT_ID_ENV,
  USER_CLIENT_SECRET_ENV,
} from "../src/desktop.js";
import { TokenProvider } from "../src/gmailClient.js";
import { sendAsCache } from "../src/mailbox.js";
import { createServer } from "../src/server.js";
import { FakeGmail } from "./fakeGmail.js";

const HOME = "me.home@gmail.com";
const WORK = "me@work.example";
const CLIENT = { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" };

const tmpDirs: string[] = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmpDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-desktop-test-"));
  tmpDirs.push(dir);
  return dir;
};

/**
 * A browser that signs in as `email` (or, with `error`, declines) and follows Google's redirect back
 * to the loopback URL in the sign-in link. `pages` collects what the tab ends up showing.
 */
function fakeBrowser(fake: FakeGmail, who: { email?: string; error?: string; delayMs?: number; opens?: boolean } = {}) {
  const pages: Promise<string>[] = [];
  const opened: string[] = [];
  const visit = (link: string) => {
    const auth = new URL(link);
    const back = new URL(auth.searchParams.get("redirect_uri")!);
    back.searchParams.set("state", auth.searchParams.get("state")!);
    if (who.error) {
      back.searchParams.set("error", who.error);
    } else {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      fake.codes.set(code, who.email!);
      back.searchParams.set("code", code);
    }
    const page = new Promise<void>((r) => setTimeout(r, who.delayMs ?? 0)).then(async () => (await fetch(back)).text());
    pages.push(page);
    return page;
  };
  const openUrl = async (link: string) => {
    opened.push(link);
    if (who.opens === false) return false;
    void visit(link).catch(() => undefined);
    return true;
  };
  return { openUrl, opened, pages, visit, who };
}

async function setup(opts: { browser?: Parameters<typeof fakeBrowser>[1]; timeoutMs?: number; progressIntervalMs?: number; noClient?: boolean } = {}) {
  sendAsCache.clear();
  const store = new AccountStore(tmpDir());
  const fake = new FakeGmail();
  fake.addMailbox(HOME, "rt-home");
  fake.addMailbox(WORK, "rt-work");
  const browser = fakeBrowser(fake, opts.browser ?? { email: HOME });
  const logs: string[] = [];
  const loadClient = async () => {
    if (opts.noClient) throw new Error(NO_CLIENT_MESSAGE);
    return CLIENT;
  };

  const server = createServer({
    store,
    fetchImpl: fake.fetch,
    tokens: new TokenProvider(loadClient, fake.fetch, DESKTOP_RELINK_HINT),
    manageHint: DESKTOP_MANAGE_HINT,
  });
  registerAccountTools(server, {
    store,
    loadClient,
    openUrl: browser.openUrl,
    fetchImpl: fake.fetch,
    timeoutMs: opts.timeoutMs,
    progressIntervalMs: opts.progressIntervalMs,
    log: (m) => logs.push(m),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}, onprogress?: (p: unknown) => void) => {
    const res = (await client.callTool({ name, arguments: args }, CallToolResultSchema, onprogress ? { onprogress } : undefined)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = res.content[0].text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(res.isError), text, json };
  };
  return { store, fake, browser, call, client, logs };
}

describe("linking accounts from inside Claude", () => {
  test("with no accounts linked, the tools say to ask Claude to link Gmail", async () => {
    const { call } = await setup();
    const search = await call("search_threads", { query: "lunch" });
    assert.equal(search.isError, true);
    assert.match(search.text, /No Gmail accounts are linked yet\. Ask Claude to link your Gmail \(link_account\)/);
    const list = await call("list_accounts");
    assert.deepEqual(list.json.accounts, []);
    assert.match(list.json.manageAccounts, /^No accounts linked yet\. Ask Claude to link your Gmail \(link_account\)/);
  });

  test("link_account signs in through the browser, and the account works at once", async () => {
    const { call, store, fake, browser } = await setup();
    const res = await call("link_account", { nickname: " home " });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.text, `Linked ${HOME} (home). 1 Gmail account is linked now.`);
    assert.match(await browser.pages[0], new RegExp(`^Linked ${HOME} to Claude\\. You can close this tab`));

    // The sign-in link: Google's consent page, PKCE, a loopback redirect on a random port.
    const link = new URL(browser.opened[0]);
    assert.equal(link.origin + link.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(link.searchParams.get("client_id"), CLIENT.clientId);
    assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    assert.match(link.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(fake.codeExchanges.length, 1);
    assert.ok(fake.codeExchanges[0].get("code_verifier"));

    const [account] = await store.list();
    assert.equal(account.email, HOME);
    assert.equal(account.alias, "home");
    assert.equal(account.refreshToken, "rt-home");

    // Same server, no restart: the new account is used right away.
    const list = await call("list_accounts");
    assert.equal(list.json.accounts[0].email, HOME);
    assert.equal(list.json.accounts[0].status, "ok");
    assert.equal((await call("search_threads", { query: "lunch" })).isError, false);

    // The loopback listener is gone once the flow is over.
    await assert.rejects(fetch(link.searchParams.get("redirect_uri")!));
  });

  test("a second account can be linked next to the first, and re-linking keeps one entry", async () => {
    const { call, store, browser } = await setup();
    await call("link_account");
    browser.who.email = WORK;
    const second = await call("link_account", { nickname: "work" });
    assert.equal(second.text, `Linked ${WORK} (work). 2 Gmail accounts are linked now.`);
    assert.deepEqual((await store.list()).map((a) => a.email), [HOME, WORK]);

    browser.who.email = HOME;
    const again = await call("link_account", { nickname: "home" });
    assert.equal(again.text, `Linked ${HOME} (home). 2 Gmail accounts are linked now.`);
    assert.deepEqual((await store.list()).map((a) => [a.email, a.alias]), [[HOME, "home"], [WORK, "work"]]);
  });

  test("when no browser can be opened, the link is returned and signing in later still links the account", async () => {
    const { call, store, browser } = await setup({ browser: { email: WORK, opens: false } });
    const res = await call("link_account");
    assert.equal(res.isError, false);
    assert.match(res.text, /Couldn't open a browser/);
    const link = res.text.match(/https:\/\/accounts\.google\.com\S+/)![0];
    assert.equal(link, browser.opened[0]);
    assert.deepEqual(await store.list(), []);

    assert.match(await browser.visit(link), new RegExp(`^Linked ${WORK} to Claude`));
    assert.deepEqual((await store.list()).map((a) => a.email), [WORK]);
  });

  test("a sign-in that nobody finishes times out with a clear message", async () => {
    const { call, store } = await setup({ browser: { opens: true, email: HOME, delayMs: 400 }, timeoutMs: 150 });
    const res = await call("link_account");
    assert.equal(res.isError, true);
    assert.match(res.text, /Nobody finished signing in with Google within 150 ms\. Nothing was linked\. To try again, call link_account again\./);
    assert.deepEqual(await store.list(), []);
  });

  test("declining on Google's consent screen links nothing", async () => {
    const { call, store, browser } = await setup({ browser: { error: "access_denied" } });
    const res = await call("link_account");
    assert.equal(res.isError, true);
    assert.match(res.text, /Google returned an error: access_denied/);
    assert.match(await browser.pages[0], /Authorization failed: access_denied/);
    assert.deepEqual(await store.list(), []);
  });

  test("a nickname another account uses is refused, and the new grant is revoked again", async () => {
    const { call, store, fake } = await setup({ browser: { email: HOME } });
    await store.upsert({ email: WORK, alias: "work", refreshToken: "rt-work", scopes: [], addedAt: "" });
    const bad = await call("link_account", { nickname: "all" });
    assert.match(bad.text, /"all" is reserved/);
    assert.equal(fake.codeExchanges.length, 0, "checked before anyone is sent to Google");

    const res = await call("link_account", { nickname: "work" });
    assert.equal(res.isError, true);
    assert.match(res.text, /Alias "work" is already used by me@work\.example/);
    assert.deepEqual(fake.revokeCalls, ["rt-home"]);
    assert.deepEqual((await store.list()).map((a) => a.email), [WORK]);
  });

  test("progress is reported while waiting for the browser", async () => {
    const { call } = await setup({ browser: { email: HOME, delayMs: 120 }, progressIntervalMs: 20 });
    const progress: unknown[] = [];
    const res = await call("link_account", {}, (p) => progress.push(p));
    assert.equal(res.isError, false, res.text);
    assert.ok(progress.length >= 1, "at least one progress notification");
  });

  test("without any Google client, link_account says how to configure one", async () => {
    const { call, browser } = await setup({ noClient: true });
    const res = await call("link_account");
    assert.equal(res.isError, true);
    assert.match(res.text, /no built-in Google sign-in client/);
    assert.match(res.text, /Settings → Extensions/);
    assert.deepEqual(browser.opened, []);
  });

  test("unlink_account revokes and removes; set_account_nickname renames", async () => {
    const { call, store, fake } = await setup();
    await store.upsert({ email: HOME, refreshToken: "rt-home", scopes: [], addedAt: "" });
    await store.upsert({ email: WORK, refreshToken: "rt-work", scopes: [], addedAt: "" });

    const renamed = await call("set_account_nickname", { account: WORK, nickname: "job" });
    assert.equal(renamed.text, `${WORK} is now also "job".`);
    assert.match((await call("set_account_nickname", { account: HOME, nickname: "job" })).text, /already used/);
    assert.match((await call("set_account_nickname", { account: "nobody", nickname: "x" })).text, /No linked Gmail account matches "nobody"/);

    const unlinked = await call("unlink_account", { account: "job" });
    assert.equal(unlinked.isError, false);
    assert.equal(unlinked.text, `Unlinked ${WORK} and revoked the connector's access to it. 1 account(s) still linked.`);
    assert.deepEqual(fake.revokeCalls, ["rt-work"]);
    assert.deepEqual((await store.list()).map((a) => a.email), [HOME]);
    assert.equal((await call("unlink_account", {})).isError, true, "the account is required");
  });
});

describe("choosing the Google OAuth client", () => {
  const saved = { ...process.env };
  const withEnv = async (dir: string, fn: () => Promise<void>) => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GMAIL_MCP_CREDENTIALS;
    process.env.GMAIL_MCP_CONFIG_DIR = dir;
    try {
      await fn();
    } finally {
      for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_MCP_CREDENTIALS", "GMAIL_MCP_CONFIG_DIR"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };

  test("settings, then credentials.json, then the built-in client, then a clear error", async () => {
    const dir = tmpDir();
    const builtinFile = path.join(dir, "google-client.json");
    await withEnv(dir, async () => {
      await assert.rejects(resolveOAuthClient({ env: {}, builtinFile }), (err: Error) => err.message === NO_CLIENT_MESSAGE);

      writeFileSync(builtinFile, JSON.stringify({ client_id: "builtin-id", client_secret: "builtin-secret" }));
      assert.deepEqual(await resolveOAuthClient({ env: {}, builtinFile }), {
        clientId: "builtin-id",
        clientSecret: "builtin-secret",
        source: "built-in",
      });

      // Claude Desktop leaves the placeholder when an optional setting is empty.
      const unset = { [USER_CLIENT_ID_ENV]: "${user_config.google_client_id}", [USER_CLIENT_SECRET_ENV]: " " };
      assert.equal((await resolveOAuthClient({ env: unset, builtinFile })).source, "built-in");

      writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ installed: { client_id: "file-id", client_secret: "file-secret" } }));
      assert.deepEqual(await resolveOAuthClient({ env: unset, builtinFile }), { clientId: "file-id", clientSecret: "file-secret", source: "credentials" });

      const mine = { [USER_CLIENT_ID_ENV]: " my-id ", [USER_CLIENT_SECRET_ENV]: "my-secret" };
      assert.deepEqual(await resolveOAuthClient({ env: mine, builtinFile }), { clientId: "my-id", clientSecret: "my-secret", source: "your settings" });

      await assert.rejects(resolveOAuthClient({ env: { [USER_CLIENT_ID_ENV]: "my-id" }, builtinFile }), /only one of/);

      writeFileSync(path.join(dir, "credentials.json"), "{}");
      await assert.rejects(resolveOAuthClient({ env: {}, builtinFile }), /does not look like a Google OAuth client file/);
    });
  });

  test("the error without a client says what to do", () => {
    assert.match(NO_CLIENT_MESSAGE, /no built-in Google sign-in client/);
    assert.match(NO_CLIENT_MESSAGE, /Configure/);
    assert.match(NO_CLIENT_MESSAGE, /Desktop app/);
  });
});
