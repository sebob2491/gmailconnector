#!/usr/bin/env node
/**
 * Builds the Claude Desktop extension (MCP Bundle): dist-desktop/gmail-multi-mcp.mcpb.
 * Run with `npm run pack:desktop` (which compiles dist/ first; the tool list is read from it).
 *
 * GMAIL_MCP_DESKTOP_CLIENT_ID / GMAIL_MCP_DESKTOP_CLIENT_SECRET, when set, are written into the
 * bundle as server/google-client.json: the built-in Google "Desktop app" client. Without them the
 * bundle still works, but each user has to enter their own client in the extension's settings.
 * GMAIL_MCP_DESKTOP_VERSION overrides the bundle's version (the release workflow passes the tag's).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeIcon } from "./icon.mjs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const NODE_TARGET = "node20";
const BUNDLE_NAME = "gmail-multi-mcp.mcpb";
const DISPLAY_NAME = "Gmail (multiple accounts)";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-desktop");
const stage = path.join(outDir, "bundle");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const log = (msg) => process.stderr.write(msg + "\n");

function bundleVersion() {
  const v = process.env.GMAIL_MCP_DESKTOP_VERSION?.trim().replace(/^v/, "");
  if (!v) return pkg.version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`GMAIL_MCP_DESKTOP_VERSION "${v}" is not a semantic version.`);
  return v;
}

function run(cmd, args) {
  // npx is a .cmd script on Windows, which needs a shell; the arguments here are fixed paths.
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status ?? res.error?.message})`);
}

/** The built-in client from the environment (the release workflow passes repository secrets). */
function builtinClient() {
  const id = process.env.GMAIL_MCP_DESKTOP_CLIENT_ID?.trim();
  const secret = process.env.GMAIL_MCP_DESKTOP_CLIENT_SECRET?.trim();
  if (!id && !secret) return undefined;
  if (!id || !secret) throw new Error("Set both GMAIL_MCP_DESKTOP_CLIENT_ID and GMAIL_MCP_DESKTOP_CLIENT_SECRET, or neither.");
  if (!/\.apps\.googleusercontent\.com$/.test(id)) log(`Warning: ${id} doesn't look like a Google OAuth client ID.`);
  return { client_id: id, client_secret: secret };
}

/** The tools the server offers, read from the compiled server (with a throwaway account store). */
async function listTools() {
  const dist = (p) => pathToFileURL(path.join(root, "dist/src", p)).href;
  const { createServer } = await import(dist("server.js"));
  const { registerAccountTools } = await import(dist("desktop.js"));
  const { AccountStore } = await import(dist("accountStore.js"));
  const { TokenProvider } = await import(dist("gmailClient.js"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmail-pack-"));
  try {
    const store = new AccountStore(tmp);
    const loadClient = async () => ({ clientId: "x", clientSecret: "x" });
    const server = createServer({ store, tokens: new TokenProvider(loadClient) });
    registerAccountTools(server, { store, loadClient });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "pack", version: "0" });
    await client.connect(a);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => ({ name: t.name, description: t.title ?? t.annotations?.title ?? t.name }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function manifest(tools, hasBuiltin) {
  const repo = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
  const owner = repo.split("/")[3];
  const clientHelp = hasBuiltin
    ? "Optional. Leave empty to sign in with the Google client built into this extension. "
    : "This copy of the extension has no built-in Google client, so enter one here before linking an account. ";
  return {
    $schema: "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/dist/mcpb-manifest-v0.3.schema.json",
    manifest_version: "0.3",
    name: pkg.name,
    display_name: DISPLAY_NAME,
    version: bundleVersion(),
    description: "Read, search, organise and send email in several Gmail accounts at once.",
    long_description:
      "Links any number of Gmail accounts to Claude. Ask Claude to \"link my Gmail\": Google's sign-in page opens in your browser, " +
      "and the account is ready as soon as you allow access. Searches cover every linked account at once; replies, drafts, labels, " +
      "attachments and unsubscribing work per account.\n\nEverything runs on your computer: the sign-in tokens are stored in " +
      "~/.config/gmail-multi-mcp/accounts.json (readable only by you) and the extension talks only to Google." +
      (hasBuiltin
        ? ""
        : "\n\nThis build has no built-in Google client: enter your own Google OAuth \"Desktop app\" client in the extension's settings (see the README)."),
    author: { name: owner || "gmail-multi-mcp", ...(owner ? { url: `https://github.com/${owner}` } : {}) },
    ...(repo ? { repository: { type: "git", url: repo }, homepage: repo, documentation: `${repo}#readme`, support: `${repo}/issues` } : {}),
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.mjs"],
        env: {
          GMAIL_MCP_USER_CLIENT_ID: "${user_config.google_client_id}",
          GMAIL_MCP_USER_CLIENT_SECRET: "${user_config.google_client_secret}",
        },
      },
    },
    tools,
    keywords: ["gmail", "email", "google", "multiple accounts"],
    license: pkg.license,
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: ">=20.0.0" },
    },
    user_config: {
      google_client_id: {
        type: "string",
        title: "Your own Google client ID",
        description:
          clientHelp +
          "To use your own Google Cloud project, enter the client ID of an OAuth client of type \"Desktop app\" (it ends in .apps.googleusercontent.com). " +
          "Accounts linked with another client must be linked again afterwards.",
        required: false,
      },
      google_client_secret: {
        type: "string",
        title: "Your own Google client secret",
        description: clientHelp + "The client secret of that same \"Desktop app\" client.",
        sensitive: true,
        required: false,
      },
    },
  };
}

/** Starts the bundled server the way Claude Desktop does and checks it lists the account tools. */
async function smokeTest(serverFile) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmail-pack-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverFile],
    env: { ...process.env, GMAIL_MCP_CONFIG_DIR: tmp, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "pack-smoke", version: "0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes("link_account")) throw new Error("the bundled server doesn't offer link_account");
    const list = await client.callTool({ name: "list_accounts", arguments: {} });
    if (list.isError) throw new Error(`list_accounts failed in the bundled server: ${list.content[0]?.text}`);
    return names.length;
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const client = builtinClient();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(stage, "server"), { recursive: true });

  const serverFile = path.join(stage, "server", "index.mjs");
  await build({
    entryPoints: [path.join(root, "src/index.ts")],
    outfile: serverFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: NODE_TARGET,
    minify: true,
    legalComments: "linked",
    // Some dependencies are CommonJS and require() Node built-ins.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "warning",
  });

  if (client) writeFileSync(path.join(stage, "server", "google-client.json"), JSON.stringify(client, null, 2) + "\n");
  writeFileSync(path.join(stage, "icon.png"), makeIcon(512));
  const tools = await listTools();
  writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest(tools, Boolean(client)), null, 2) + "\n");
  for (const file of ["README.md"]) writeFileSync(path.join(stage, file), readFileSync(path.join(root, file)));
  writeFileSync(path.join(stage, "LICENSE.txt"), `${pkg.name} is licensed under the ${pkg.license} license; see ${pkg.repository?.url ?? "the repository"}.\n`);

  const toolCount = await smokeTest(serverFile);
  run("npx", ["--yes", MCPB_CLI, "validate", path.join(stage, "manifest.json")]);
  const bundle = path.join(outDir, BUNDLE_NAME);
  run("npx", ["--yes", MCPB_CLI, "pack", stage, bundle]);

  const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} KB`;
  log(`\nBuilt ${path.relative(root, bundle)} (${kb(bundle)}; server ${kb(serverFile)}, ${toolCount} tools).`);
  log(
    client
      ? `Built-in Google client: ${client.client_id}`
      : "No built-in Google client (GMAIL_MCP_DESKTOP_CLIENT_ID/SECRET not set): users must enter their own client in the extension's settings.",
  );
}

main().catch((err) => {
  log(`pack:desktop failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
