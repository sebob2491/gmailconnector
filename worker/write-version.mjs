// Writes worker/version.generated.ts: which commit this Worker is built from, and when. Runs before
// every bundle (wrangler.jsonc "build"), on Cloudflare's Workers Builds and locally. Workers Builds
// sets WORKERS_CI_COMMIT_SHA and WORKERS_CI_BRANCH; elsewhere git is asked, and without git the
// commit is "unknown". Nothing here may fail the build.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** "owner/repo" of a github.com remote URL, without any credentials it may carry; "" otherwise. */
export function githubRepo(remote) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? match[1] : "";
}

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? version;
} catch {
  // keep the default
}
const sha = /^[0-9a-f]{40}$/i.test(process.env.WORKERS_CI_COMMIT_SHA ?? "") ? process.env.WORKERS_CI_COMMIT_SHA : git("rev-parse", "HEAD");
const commit = /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : "unknown";
const commitDate = commit === "unknown" ? "" : git("show", "-s", "--format=%cI", commit);
const build = {
  version: String(version),
  commit,
  commitDate: Number.isNaN(Date.parse(commitDate)) ? "" : new Date(commitDate).toISOString(),
  builtAt: new Date().toISOString(),
  branch: (process.env.WORKERS_CI_BRANCH || git("rev-parse", "--abbrev-ref", "HEAD")).replace(/[^\w./-]/g, "").slice(0, 100),
  repo: githubRepo(git("remote", "get-url", "origin")),
};

writeFileSync(
  join(root, "worker", "version.generated.ts"),
  `// Written by worker/write-version.mjs when the Worker is built. Not committed.\nexport const BUILD = ${JSON.stringify(build, null, 2)};\n`,
);
