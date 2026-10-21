/**
 * Checks that run before the OAuth library sees a request, against abuse of the endpoints anyone
 * on the internet can call:
 *
 * - Rate limits on client registration (each registration is a storage write; the free plan allows
 *   1,000 a day) and on the consent page. They are counted in memory, per isolate: Cloudflare runs a
 *   Worker in many isolates and restarts them freely, so this is best effort. It blunts a single
 *   source without being a quota.
 * - A token request whose client_id is a URL names a client ID metadata document, which the library
 *   fetches from that URL before anything else is checked. Only Claude's hosts are fetched.
 */
import { clientIdAllowed, type Env } from "./owner.js";
import { messagePage } from "./pages.js";

/** Counts events per key over a sliding window. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Records an event for `key`, unless `key` has already had `limit` of them in the window (then false). */
  allow(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    // Forget keys that have gone quiet, so the map can't grow without bound.
    if (this.hits.size >= 1000) {
      for (const [k, times] of this.hits) if ((times[times.length - 1] ?? 0) <= since) this.hits.delete(k);
    }
    const times = (this.hits.get(key) ?? []).filter((t) => t > since);
    const allowed = times.length < this.limit;
    if (allowed) times.push(now);
    this.hits.set(key, times);
    return allowed;
  }
}

const MINUTE = 60_000;
const registerPerAddress = new RateLimiter(5, MINUTE);
const registerPerIsolate = new RateLimiter(20, MINUTE);
const consentPerAddress = new RateLimiter(30, MINUTE);

/** The client's address as Cloudflare reports it (set by the edge; a client can't choose it). */
const clientAddress = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

const RETRY_AFTER = { "Retry-After": "60", "Cache-Control": "no-store" };

function tooManyRegistrations(): Response {
  return new Response(JSON.stringify({ error: "too_many_requests", error_description: "Too many client registrations; try again in a minute." }), {
    status: 429,
    headers: { ...RETRY_AFTER, "Content-Type": "application/json" },
  });
}

/** The client_id a token request presents, in its form or its Basic credentials; undefined when it has neither. */
async function tokenClientId(request: Request): Promise<string | undefined> {
  const basic = /^Basic\s+(\S+)/i.exec(request.headers.get("Authorization") ?? "");
  if (basic) {
    let pair: string;
    try {
      pair = atob(basic[1]);
    } catch {
      return undefined;
    }
    const id = pair.slice(0, pair.includes(":") ? pair.indexOf(":") : pair.length);
    try {
      return decodeURIComponent(id);
    } catch {
      return id;
    }
  }
  if (!/^application\/x-www-form-urlencoded/i.test(request.headers.get("Content-Type") ?? "")) return undefined;
  try {
    const id = (await request.clone().formData()).get("client_id");
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A response that ends the request before the OAuth library runs, or undefined to carry on. */
export async function guard(request: Request, env: Env): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/register") {
    if (!registerPerAddress.allow(clientAddress(request)) || !registerPerIsolate.allow("all")) return tooManyRegistrations();
  } else if (request.method === "GET" && pathname === "/authorize") {
    if (!consentPerAddress.allow(clientAddress(request))) {
      return messagePage("Too many requests", "Please wait a minute, then start connecting again from Claude.", { status: 429, kind: "warn", headers: new Headers(RETRY_AFTER) });
    }
  } else if (request.method === "POST" && pathname === "/token") {
    const clientId = await tokenClientId(request);
    if (clientId !== undefined && !clientIdAllowed(env, clientId)) {
      return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client metadata is only read from Claude's hosts." }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }
  return undefined;
}
