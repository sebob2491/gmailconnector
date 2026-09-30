#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccountStore, describeAccount, normalizeAlias } from "./accountStore.js";
import { TokenProvider } from "./gmailClient.js";
import { fetchProfileEmail, loadOAuthClient, persistOAuthClient, revokeToken, runInteractiveAuth } from "./oauth.js";
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

const RELINK_HINT = "Re-link it by running the `accounts add` command again (see README).";

const log = (msg: string) => process.stderr.write(msg + "\n");

const REVOKE_HELP = "You can remove access by hand at https://myaccount.google.com/permissions";

/**
 * Parses `--name value`, `--name=value` and boolean `--name` flags. Unknown flags and extra
 * positional arguments are errors, so typos don't silently change what a command does.
 */
function parseArgs(args: string[], spec: { values?: string[]; booleans?: string[]; positionals: number; usage: string }) {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.split(/=(.*)/s, 2);
    if (spec.booleans?.includes(name) && inline === undefined) {
      booleans.add(name);
    } else if (spec.values?.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
        throw new Error(`${name} needs a value.\nUsage: ${spec.usage}`);
      }
      values[name] = value;
    } else {
      throw new Error(`Unknown option "${arg}".\nUsage: ${spec.usage}`);
    }
  }
  if (positionals.length !== spec.positionals) throw new Error(`Usage: ${spec.usage}`);
  return { values, booleans, positionals };
}

async function accountsCommand(args: string[]): Promise<void> {
  const store = new AccountStore();
  const sub = args.shift();
  switch (sub) {
    case "add": {
      const { values, booleans } = parseArgs(args, {
        values: ["--alias", "--credentials"],
        booleans: ["--no-browser"],
        positionals: 0,
        usage: "gmail-multi-mcp accounts add [--alias NAME] [--credentials FILE] [--no-browser]",
      });
      // Check the alias before sending anyone through Google's sign-in.
      const alias = values["--alias"] !== undefined ? normalizeAlias(values["--alias"]) : undefined;
      const client = await loadOAuthClient(values["--credentials"]);
      const saved = await persistOAuthClient(client);
      if (saved) log(`Saved the OAuth client to ${saved} so the server Claude launches can use it.`);

      const auth = await runInteractiveAuth(client, { openBrowser: !booleans.has("--no-browser"), log });
      let email: string | undefined;
      try {
        email = await fetchProfileEmail(auth.accessToken);
        await store.upsert({
          email,
          alias,
          refreshToken: auth.refreshToken,
          scopes: auth.scopes,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        // Don't leave an unused grant active at Google, unless the account is already linked:
        // revoking would also end the grant behind its saved refresh token.
        const linked = (await store.list()).some((a) => email !== undefined && a.email.toLowerCase() === email.toLowerCase());
        if (!linked) await revokeToken(auth.refreshToken);
        throw err;
      }
      const all = await store.list();
      log(`Linked ${email}${alias ? ` as "${alias}"` : ""}. ${all.length} account(s) linked.`);
      if (all.length > 1) log(`Tip: run "accounts add" again to link another, or "accounts default" to pick a default.`);
      return;
    }
    case "list":
    case undefined: {
      parseArgs(args, { positionals: 0, usage: "gmail-multi-mcp accounts list" });
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
      const [ref] = parseArgs(args, { positionals: 1, usage: "gmail-multi-mcp accounts remove ACCOUNT" }).positionals;
      const removed = await store.remove(ref);
      const revoked = await revokeToken(removed.refreshToken);
      log(
        revoked
          ? `Removed ${removed.email} and revoked its access.`
          : `Removed ${removed.email}, but Google didn't confirm revoking its access. ${REVOKE_HELP}`,
      );
      return;
    }
    case "default": {
      const [ref] = parseArgs(args, { positionals: 1, usage: "gmail-multi-mcp accounts default ACCOUNT" }).positionals;
      const account = await store.setDefault(ref);
      log(`Default account is now ${describeAccount(account)}.`);
      return;
    }
    case "alias": {
      const [ref, alias] = parseArgs(args, { positionals: 2, usage: "gmail-multi-mcp accounts alias ACCOUNT NAME" })
        .positionals;
      const account = await store.setAlias(ref, alias);
      log(`${account.email} is now also "${account.alias}".`);
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

  const server = createServer({
    store: new AccountStore(),
    tokens: new TokenProvider(() => loadOAuthClient(), undefined, RELINK_HINT),
  });
  await server.connect(new StdioServerTransport());
  log("gmail-multi-mcp running on stdio");
}

main().catch((err) => {
  log(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
