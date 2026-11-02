/**
 * Which version of the connector is running, and whether the original repository has a newer one.
 *
 * The build (worker/write-version.mjs) records the commit. The update check asks GitHub's public API
 * for the newest commit on the upstream repository's main branch, at most once an hour per isolate,
 * and says nothing when anything goes wrong: it is a hint, never an error.
 */
import { defaultFetch, type FetchLike } from "../src/google.js";
import { BUILD } from "./version.generated.js";

export const DEFAULT_UPSTREAM = "sebob2491/gmailconnector";
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface VersionEnv {
  /** "owner/repo" of the repository copies are made from, if not this project's own. */
  UPSTREAM_REPO?: string;
}

export interface BuildInfo {
  version: string;
  commit: string;
  commitDate: string;
  builtAt: string;
  branch: string;
  repo: string;
}

export const build: BuildInfo = {
  version: String(BUILD.version || "0.0.0"),
  commit: /^[0-9a-f]{40}$/.test(BUILD.commit) ? BUILD.commit : "unknown",
  commitDate: BUILD.commitDate || "",
  builtAt: BUILD.builtAt || "",
  branch: BUILD.branch || "",
  repo: REPO_PATTERN.test(BUILD.repo) ? BUILD.repo : "",
};

export function upstreamRepo(env: VersionEnv): string {
  const configured = env.UPSTREAM_REPO?.trim() ?? "";
  return REPO_PATTERN.test(configured) ? configured : DEFAULT_UPSTREAM;
}

/** What GET /version answers: nothing secret (no repository of the copy, no settings). */
export function versionJson(env: VersionEnv): Record<string, string> {
  return {
    version: build.version,
    commit: build.commit,
    commitDate: build.commitDate,
    builtAt: build.builtAt,
    upstream: upstreamRepo(env),
  };
}

/** "0.1.0 (abc1234, built 2 Nov 2026)" */
export function versionLabel(): string {
  const parts = [build.commit === "unknown" ? "commit unknown" : build.commit.slice(0, 7)];
  const built = Date.parse(build.builtAt);
  if (!Number.isNaN(built)) {
    parts.push(`built ${new Date(built).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`);
  }
  return `${build.version} (${parts.join(", ")})`;
}

export interface UpdateAvailable {
  upstream: string;
  latestCommit: string;
  latestDate: string;
  /** GitHub's page of the changes since the running commit. */
  compareUrl: string;
  /** The upstream's list of commits on main, for when the compare page can't show the running commit. */
  commitsUrl: string;
}

interface LatestCommit {
  sha: string;
  date: string;
}

const UPDATE_CACHE_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const updateCache = new Map<string, { at: number; result: Promise<LatestCommit | undefined> }>();

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const SHA = /^[0-9a-f]{40}$/;

async function latestCommit(upstream: string, fetchImpl: FetchLike): Promise<LatestCommit | undefined> {
  const userAgent = "gmail-multi-mcp-update-check";
  try {
    const res = await fetchWithTimeout(fetchImpl, `https://api.github.com/repos/${upstream}/commits/main`, {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (res.ok) {
      const body = (await res.json()) as { sha?: unknown; commit?: { committer?: { date?: unknown } } };
      const sha = typeof body.sha === "string" ? body.sha.toLowerCase() : "";
      const date = typeof body.commit?.committer?.date === "string" ? body.commit.committer.date : "";
      return SHA.test(sha) && !Number.isNaN(Date.parse(date)) ? { sha, date } : undefined;
    }
    await res.body?.cancel();
    // Unauthenticated API calls are limited per IP address, and Cloudflare's addresses are shared:
    // when the API says no, the commit feed (an ordinary web page) gives the same answer.
    if (res.status !== 403 && res.status !== 429) return undefined;
    const feed = await fetchWithTimeout(fetchImpl, `https://github.com/${upstream}/commits/main.atom`, { "User-Agent": userAgent });
    if (!feed.ok) {
      await feed.body?.cancel();
      return undefined;
    }
    const entry = /<entry>([\s\S]*?)<\/entry>/.exec((await feed.text()).slice(0, 200_000))?.[1] ?? "";
    const sha = /Commit\/([0-9a-f]{40})</i.exec(entry)?.[1]?.toLowerCase() ?? "";
    const date = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1] ?? "";
    return SHA.test(sha) && !Number.isNaN(Date.parse(date)) ? { sha, date } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the upstream repository's main branch has a commit newer than the one running. A copy
 * whose own commit is newer (it merged the update, or has changes of its own) counts as up to date,
 * so a merge commit made by the update workflow doesn't keep the notice up. Undefined when the
 * running commit is unknown, GitHub can't be asked, or there is nothing newer.
 */
export async function checkForUpdate(env: VersionEnv, fetchImpl: FetchLike = defaultFetch, now = Date.now()): Promise<UpdateAvailable | undefined> {
  if (build.commit === "unknown") return undefined;
  const upstream = upstreamRepo(env);
  let cached = updateCache.get(upstream);
  if (!cached || now - cached.at >= UPDATE_CACHE_MS) {
    cached = { at: now, result: latestCommit(upstream, fetchImpl) };
    updateCache.set(upstream, cached);
  }
  const latest = await cached.result;
  if (!latest || latest.sha === build.commit) return undefined;
  const running = Date.parse(build.commitDate || build.builtAt);
  if (Number.isNaN(running) || Date.parse(latest.date) <= running) return undefined;
  return {
    upstream,
    latestCommit: latest.sha,
    latestDate: latest.date,
    compareUrl: `https://github.com/${upstream}/compare/${build.commit}...main`,
    commitsUrl: `https://github.com/${upstream}/commits/main`,
  };
}
