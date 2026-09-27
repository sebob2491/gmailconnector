#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccountStore, describeAccount } from "./accountStore.js";
import { TokenProvider } from "./gmailClient.js";
import { fetchProfileEmail, loadOAuthClient, revokeToken, runInteractiveAuth } from "./oauth.js";
import { createServer } from "./server.js";

const HELP = `gmail-multi-mcp — a Gmail MCP connector that works with several Gmail accounts.

Usage:
  gmail-multi-mcp                         Run the MCP server over stdio (what Claude launches)
  gmail-multi-mcp accounts add [--alias NAME] [--credentials FILE] [--no-browser]
                                          Link a Gmail account (run once per account)
  gmail-multi-mcp accounts list           Show linked accounts
  gmail-multi-mcp accounts remove ACCOUNT Unlink an account and revoke its token
  gmail-multi-mcp accounts default ACCOUNT
                                          Use ACCOUNT when a tool call doesn't name one
  gmail-multi-mcp accounts alias ACCOUNT NAME
                                          Give ACCOUNT a short name such as "work"

ACCOUNT is an email address or alias. Accounts are stored in ${new AccountStore().file}
(override the folder with GMAIL_MCP_CONFIG_DIR).`;

const log = (msg: string) => process.stderr.write(msg + "\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

async function accountsCommand(args: string[]): Promise<void> {
  const store = new AccountStore();
  const sub = args.shift();
  switch (sub) {
    case "add": {
      const alias = flag(args, "--alias");
      const credentials = flag(args, "--credentials");
      const noBrowser = bool(args, "--no-browser");
      const client = await loadOAuthClient(credentials);
      const auth = await runInteractiveAuth(client, { openBrowser: !noBrowser, log });
      const email = await fetchProfileEmail(auth.accessToken);
      await store.upsert({
        email,
        alias,
        refreshToken: auth.refreshToken,
        scopes: auth.scopes,
        addedAt: new Date().toISOString(),
      });
      const all = await store.list();
      log(`Linked ${email}${alias ? ` as "${alias}"` : ""}. ${all.length} account(s) linked.`);
      if (all.length > 1) log(`Tip: run "gmail-multi-mcp accounts add" again to link another, or "accounts default" to pick a default.`);
      return;
    }
    case "list":
    case undefined: {
      const data = await store.load();
      if (!data.accounts.length) {
        log(`No accounts linked yet. Run: gmail-multi-mcp accounts add`);
        return;
      }
      for (const a of data.accounts) {
        const isDefault = data.defaultAccount?.toLowerCase() === a.email.toLowerCase();
        process.stdout.write(`${describeAccount(a)}${isDefault ? "  [default]" : ""}\n`);
      }
      return;
    }
    case "remove": {
      const ref = args.shift();
      if (!ref) throw new Error("Usage: gmail-multi-mcp accounts remove ACCOUNT");
      const removed = await store.remove(ref);
      await revokeToken(removed.refreshToken);
      log(`Removed ${removed.email} and revoked its access.`);
      return;
    }
    case "default": {
      const ref = args.shift();
      if (!ref) throw new Error("Usage: gmail-multi-mcp accounts default ACCOUNT");
      const account = await store.setDefault(ref);
      log(`Default account is now ${describeAccount(account)}.`);
      return;
    }
    case "alias": {
      const [ref, alias] = args;
      if (!ref || !alias) throw new Error("Usage: gmail-multi-mcp accounts alias ACCOUNT NAME");
      const account = await store.setAlias(ref, alias);
      log(`${account.email} is now also "${alias}".`);
      return;
    }
    default:
      throw new Error(`Unknown accounts command "${sub}".\n\n${HELP}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    log(HELP);
    return;
  }
  if (cmd === "accounts") {
    await accountsCommand(args);
    process.exit(0);
  }
  if (cmd && cmd !== "serve") throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);

  const server = createServer({ store: new AccountStore(), tokens: new TokenProvider(() => loadOAuthClient()) });
  await server.connect(new StdioServerTransport());
  log("gmail-multi-mcp running on stdio");
}

main().catch((err) => {
  log(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
