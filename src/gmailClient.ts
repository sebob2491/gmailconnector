import type { LinkedAccount } from "./accounts.js";
import { AuthError, defaultFetch, refreshAccessToken, type FetchLike, type OAuthClientConfig } from "./google.js";

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
    private relinkHint = "Re-link it with: gmail-multi-mcp accounts add",
  ) {}

  async get(account: LinkedAccount, forceRefresh = false): Promise<string> {
    const cached = this.cache.get(account.refreshToken);
    if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    this.client ??= this.loadClient();
    try {
      const res = await refreshAccessToken(await this.client, account.refreshToken, this.fetchImpl);
      this.cache.set(account.refreshToken, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
      return res.access_token;
    } catch (err) {
      if (err instanceof AuthError) {
        throw new AuthError(`Gmail account ${account.email}: ${err.message}. ${this.relinkHint}`);
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
  upload?: { body: string; contentType: string };
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

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(path, opts.upload ? UPLOAD_BASE : API_BASE);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === "") continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
    }
    if (opts.upload) url.searchParams.set("uploadType", "multipart");

    let body: string | undefined;
    let contentType: string | undefined;
    if (opts.upload) {
      body = opts.upload.body;
      contentType = opts.upload.contentType;
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      contentType = "application/json";
    }

    let forceRefresh = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get(this.account, forceRefresh);
      const res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { "Content-Type": contentType } : {}) },
        body,
      });
      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 3 ** attempt));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let message = text;
        try {
          message = JSON.parse(text).error?.message ?? text;
        } catch {
          /* keep raw text */
        }
        throw new GmailApiError(res.status, `Gmail API ${method} ${path} failed (${res.status}): ${message}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** Builds a multipart/related upload body: JSON metadata followed by the RFC 822 message. */
  static uploadBody(metadata: unknown, rfc822: string): { body: string; contentType: string } {
    const boundary = `gmail_mcp_upload_${Math.random().toString(36).slice(2)}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n${rfc822}\r\n--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }
}
