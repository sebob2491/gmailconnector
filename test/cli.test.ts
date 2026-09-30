import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.js");
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function cli(args: string[], env: Record<string, string> = {}) {
  const dir = env.GMAIL_MCP_CONFIG_DIR ?? mkdtempSync(path.join(os.tmpdir(), "gmail-cli-"));
  dirs.push(dir);
  const { GOOGLE_CLIENT_ID: _a, GOOGLE_CLIENT_SECRET: _b, GMAIL_MCP_CREDENTIALS: _c, ...base } = process.env;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...base, GMAIL_MCP_CONFIG_DIR: dir, ...env },
    encoding: "utf8",
    input: "",
  });
  return { code: res.status, out: res.stdout, err: res.stderr, dir };
}

test("unknown options and extra arguments are rejected", () => {
  assert.match(cli(["accounts", "add", "--credential", "x.json"]).err, /Unknown option "--credential"/);
  assert.match(cli(["accounts", "list", "extra"]).err, /Usage: gmail-multi-mcp accounts list/);
  assert.equal(cli(["accounts", "remove"]).code, 1);
});

test("the alias is checked before sending anyone to Google", () => {
  const res = cli(["accounts", "add", "--alias=all"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /"all" is reserved/);
});

test("--flag=value works", () => {
  // Gets past argument parsing to the (missing) OAuth client.
  const res = cli(["accounts", "add", "--alias=home", "--no-browser"]);
  assert.match(res.err, /No Google OAuth client found/);
});

test("alias, default and list", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-cli-"));
  writeFileSync(
    path.join(dir, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ email: "w@x.com", refreshToken: "t", scopes: [], addedAt: "" }] }),
  );
  assert.equal(cli(["accounts", "alias", "w@x.com", " job "], { GMAIL_MCP_CONFIG_DIR: dir }).code, 0);
  assert.equal(cli(["accounts", "default", "job"], { GMAIL_MCP_CONFIG_DIR: dir }).code, 0);
  assert.equal(cli(["accounts", "list"], { GMAIL_MCP_CONFIG_DIR: dir }).out, "w@x.com (job)  [default]\n");
});

test("an OAuth client given with --credentials is saved for the server Claude launches", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmail-cli-"));
  dirs.push(dir);
  process.env.GMAIL_MCP_CONFIG_DIR = dir;
  try {
    const { persistOAuthClient, loadOAuthClient } = await import("../src/oauth.js");
    const client = { clientId: "id.apps.googleusercontent.com", clientSecret: "s3cret" };
    const saved = await persistOAuthClient(client);
    assert.equal(saved, path.join(dir, "credentials.json"));
    assert.equal(statSync(saved!).mode & 0o777, 0o600);
    assert.deepEqual(await loadOAuthClient(), client);
    assert.equal(await persistOAuthClient(client), undefined, "unchanged client isn't rewritten");
    assert.match(readFileSync(saved!, "utf8"), /"installed"/);
  } finally {
    delete process.env.GMAIL_MCP_CONFIG_DIR;
  }
});
