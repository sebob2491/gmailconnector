import type { LinkedAccount } from "./accounts.js";
import { AuthError, defaultFetch, refreshAccessToken, type FetchLike, type OAuthClientConfig } from "./google.js";
import { assembleMime, type MimeChunk } from "./mime.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const UPLOAD_BASE = "https://gmail.googleapis.com/upload/gmail/v1/users/me/";

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Caches short-lived access tokens per refresh token and refreshes them on demand. */
export class TokenProvider {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  private client?: Promise<OAuthClientConfig>;

  constructor(
    private loadClient: () => Promise<OAuthClientConfig>,
    private fetchImpl: FetchLike = defaultFetch,
    /** Tells the user how to re-link an account whose authorization was revoked. */
    private relinkHint = "Re-link it by running the `accounts add` command again.",
  ) {}

  private async oauthClient(): Promise<OAuthClientConfig> {
    this.client ??= this.loadClient();
    try {
      return await this.client;
    } catch (err) {
      // Don't remember a failed load: fixing the configuration should work without a restart.
      this.client = undefined;
      throw err;
    }
  }

  async get(account: LinkedAccount, forceRefresh = false): Promise<string> {
    const cached = this.cache.get(account.refreshToken);
    if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const client = await this.oauthClient();
    try {
      const res = await refreshAccessToken(client, account.refreshToken, this.fetchImpl);
      this.cache.set(account.refreshToken, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
      return res.access_token;
    } catch (err) {
      if (err instanceof AuthError) {
        const hint = err.code === "invalid_grant" ? ` ${this.relinkHint}` : "";
        throw new AuthError(`Gmail account ${account.email}: ${err.message}.${hint}`, err.code);
      }
      throw err;
    }
  }
}

type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  json?: unknown;
  /** Sends a pre-built body to the upload endpoint (used for RFC 822 messages). */
  upload?: { body: string | Uint8Array<ArrayBuffer>; contentType: string };
}

export interface BatchItem {
  path: string;
  query?: Record<string, QueryValue>;
}

export type BatchResult<T> = { ok: true; value: T } | { ok: false; error: GmailApiError };

const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
/** Gmail allows 100 calls per batch but rate-limits batches larger than 50. */
const BATCH_SIZE = 50;
const MAX_RETRIES = 2;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorInfo(text: string): { message: string; reasons: string[] } {
  try {
    const err = JSON.parse(text).error;
    return {
      message: err?.message ?? text,
      reasons: (err?.errors ?? []).map((e: { reason?: string }) => e.reason).filter(Boolean),
    };
  } catch {
    return { message: text, reasons: [] };
  }
}

function apiError(method: string, path: string, status: number, text: string): GmailApiError {
  return new GmailApiError(status, `Gmail API ${method} ${path} failed (${status}): ${errorInfo(text).message}`);
}

/** 429s and 403 rate-limit errors are rejected before any work is done, so they are always safe to retry. */
function isRateLimited(status: number, text: string): boolean {
  return status === 429 || (status === 403 && errorInfo(text).reasons.some((r) => RATE_LIMIT_REASONS.has(r)));
}

function retryDelay(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5000);
  return 400 * 3 ** attempt;
}

function withQuery(url: URL, query: Record<string, QueryValue> | undefined): URL {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
  }
  return url;
}

/** Splits a multipart/mixed batch response into per-call HTTP responses, in request order. */
export function parseBatchResponse(
  text: string,
  contentType: string,
  count: number,
): ({ status: number; body: string } | undefined)[] {
  const out = new Array<{ status: number; body: string } | undefined>(count);
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return out;
  for (const rawPart of text.split(`--${boundary}`)) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r?\n/, "");
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd < 0) continue;
    const id = /Content-ID:\s*<response-item-(\d+)>/i.exec(part.slice(0, headerEnd))?.[1];
    const http = part.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
    const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(http)?.[1];
    if (id === undefined || !status || Number(id) >= count) continue;
    const bodyStart = http.search(/\r?\n\r?\n/);
    out[Number(id)] = {
      status: Number(status),
      body: bodyStart < 0 ? "" : http.slice(bodyStart).replace(/^\r?\n\r?\n/, "").trim(),
    };
  }
  return out;
}

/** Thin authenticated wrapper around the Gmail REST API for one linked account. */
export class GmailClient {
  constructor(
    readonly account: LinkedAccount,
    private tokens: TokenProvider,
    private fetchImpl: FetchLike = defaultFetch,
  ) {}

  get email(): string {
    return this.account.email;
  }

  /**
   * Sends an authenticated request. A 401 refreshes the access token once; rate-limit responses are
   * retried with backoff, and 5xx responses too when `idempotent` (a failed send may still have gone out).
   */
  private async send(
    method: string,
    url: URL | string,
    body: string | Uint8Array<ArrayBuffer> | undefined,
    contentType: string | undefined,
    idempotent: boolean,
    asBytes = false,
  ): Promise<{ res: Response; text: string; bytes?: Uint8Array }> {
    let refreshed = false;
    for (let attempt = 0; ; ) {
      const token = await this.tokens.get(this.account, false);
      const res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { "Content-Type": contentType } : {}) },
        body,
      });
      // A large successful answer can be kept as bytes, skipping text decoding.
      if (asBytes && res.ok) return { res, text: "", bytes: new Uint8Array(await res.arrayBuffer()) };
      const text = await res.text();
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.get(this.account, true);
        continue;
      }
      const retryable = isRateLimited(res.status, text) || (idempotent && res.status >= 500);
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(retryDelay(res, attempt));
        attempt++;
        continue;
      }
      return { res, text };
    }
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = withQuery(new URL(path, opts.upload ? UPLOAD_BASE : API_BASE), opts.query);
    if (opts.upload) url.searchParams.set("uploadType", "multipart");

    let body: string | Uint8Array<ArrayBuffer> | undefined;
    let contentType: string | undefined;
    if (opts.upload) {
      body = opts.upload.body;
      contentType = opts.upload.contentType;
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      contentType = "application/json";
    }
    // Sending mail and creating things aren't safe to repeat after a server error.
    const idempotent = method !== "POST" || /\/(modify|trash|untrash|batchModify)$/.test(path);
    const { res, text } = await this.send(method, url, body, contentType, idempotent);
    if (!res.ok) throw apiError(method, path, res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A GET whose successful answer is returned as raw bytes (e.g. an attachment's JSON, for slicing). */
  async getBytes(path: string, query?: Record<string, QueryValue>): Promise<Uint8Array> {
    const { res, text, bytes } = await this.send("GET", withQuery(new URL(path, API_BASE), query), undefined, undefined, true, true);
    if (!bytes) throw apiError("GET", path, res.status, text);
    return bytes;
  }

  /**
   * Runs many GET calls through Gmail's batch endpoint: one HTTP request per 50 calls instead of one
   * each (which keeps the hosted connector under Cloudflare's per-request subrequest limit).
   * Calls that come back rate-limited or with a server error are retried once.
   */
  async batchGet<T = any>(items: BatchItem[]): Promise<BatchResult<T>[]> {
    const results = new Array<BatchResult<T>>(items.length);
    let pending = items.map((_, i) => i);
    for (let round = 0; pending.length; round++) {
      if (round > 0) await sleep(500 * round);
      const retry: number[] = [];
      for (let start = 0; start < pending.length; start += BATCH_SIZE) {
        const chunk = pending.slice(start, start + BATCH_SIZE);
        const responses = await this.sendBatch(chunk.map((i) => items[i]));
        chunk.forEach((index, k) => {
          const r = responses[k];
          const path = items[index].path;
          if (r && r.status >= 200 && r.status < 300) {
            results[index] = { ok: true, value: (r.body ? JSON.parse(r.body) : undefined) as T };
          } else if (round < MAX_RETRIES - 1 && (!r || isRateLimited(r.status, r.body) || r.status >= 500)) {
            retry.push(index);
          } else {
            const error = r
              ? apiError("GET", path, r.status, r.body)
              : new GmailApiError(502, `Gmail API GET ${path} failed: no response in batch`);
            results[index] = { ok: false, error };
          }
        });
      }
      pending = retry;
    }
    return results;
  }

  private async sendBatch(items: BatchItem[]): Promise<({ status: number; body: string } | undefined)[]> {
    const boundary = `batch_gmail_mcp_${Math.random().toString(36).slice(2)}`;
    const body =
      items
        .map((item, k) => {
          const url = withQuery(new URL(item.path, API_BASE), item.query);
          return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${k}>\r\n\r\nGET ${url.pathname}${url.search}\r\n\r\n`;
        })
        .join("") + `--${boundary}--`;
    const { res, text } = await this.send("POST", BATCH_URL, body, `multipart/mixed; boundary=${boundary}`, true);
    if (!res.ok) throw apiError("POST", "batch", res.status, text);
    return parseBatchResponse(text, res.headers.get("Content-Type") ?? "", items.length);
  }

  /**
   * Builds a multipart/related upload body: JSON metadata followed by the RFC 822 message, as one
   * byte array allocated once (attachments are written straight into it, never into a string).
   */
  static uploadBody(metadata: unknown, rfc822: string | MimeChunk[]): { body: Uint8Array<ArrayBuffer>; contentType: string } {
    const boundary = `gmail_mcp_upload_${Math.random().toString(36).slice(2)}`;
    const body = assembleMime([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
      ...(typeof rfc822 === "string" ? [rfc822] : rfc822),
      `\r\n--${boundary}--`,
    ]);
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }
}
