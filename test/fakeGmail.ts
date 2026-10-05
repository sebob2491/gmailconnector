/**
 * In-memory stand-in for the Google token endpoint and the parts of the Gmail REST API the
 * connector uses. Outgoing RFC 822 messages are parsed back into Gmail-style payloads so tests
 * can read drafts and sent mail the way the real API would return them.
 */
import type { ApiMessage, ApiMessagePart } from "../src/format.js";

interface Label {
  id: string;
  name: string;
  type: string;
}

export interface FakeMailbox {
  email: string;
  refreshToken: string;
  messages: Map<string, ApiMessage>;
  labels: Label[];
  drafts: Map<string, string>; // draftId -> messageId
  attachments: Map<string, string>; // `${messageId}/${attachmentId}` -> base64url data
  sent: { metadata: any; raw: string; message: ApiMessage }[];
  pageSize?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  email?: string;
  body?: any;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${(++counter).toString(16).padStart(6, "0")}`;

// ---------- minimal MIME parser ----------

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, enc: string, text: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))),
    );
}

export function parseHeaders(text: string): { name: string; value: string }[] {
  return text
    .replace(/\r\n[ \t]/g, " ")
    .split("\r\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      return { name: line.slice(0, i), value: decodeWords(line.slice(i + 1).trim()) };
    });
}

export function parseMime(
  raw: string,
  onAttachment: (data: string) => string,
  partId = "",
): ApiMessagePart {
  const split = raw.indexOf("\r\n\r\n");
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? "" : raw.slice(split + 4);
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
  const contentType = get("Content-Type") ?? "text/plain";
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (mimeType.startsWith("multipart/")) {
    const boundary = /boundary="?([^";]+)"?/.exec(contentType)![1];
    const segments = body.split(`--${boundary}`).slice(1);
    const parts = segments
      .filter((s) => !s.startsWith("--"))
      .map((s, i) => parseMime(s.replace(/^\r\n/, "").replace(/\r\n$/, ""), onAttachment, partId ? `${partId}.${i}` : `${i}`));
    return { partId, mimeType, filename: "", headers, body: { size: 0 }, parts };
  }
  const bytes =
    (get("Content-Transfer-Encoding") ?? "").toLowerCase() === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : Buffer.from(body, "utf8");
  const disposition = get("Content-Disposition") ?? "";
  const filename =
    /filename="((?:[^"\\]|\\.)*)"/.exec(disposition)?.[1] ?? /name="((?:[^"\\]|\\.)*)"/.exec(contentType)?.[1] ?? "";
  const data = bytes.toString("base64url");
  if (filename) {
    return { partId, mimeType, filename, headers, body: { attachmentId: onAttachment(data), size: bytes.length } };
  }
  return { partId, mimeType, filename: "", headers, body: { data, size: bytes.length } };
}

function parseUpload(body: string, contentType: string): { metadata: any; raw: string } {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1];
  const [, jsonPart, rawPart] = body.split(`--${boundary}`);
  const json = jsonPart.slice(jsonPart.indexOf("\r\n\r\n") + 4).trim();
  let raw = rawPart.slice(rawPart.indexOf("\r\n\r\n") + 4);
  raw = raw.replace(/\r\n$/, "");
  return { metadata: JSON.parse(json), raw };
}

// ---------- the fake ----------

export class FakeGmail {
  mailboxes: FakeMailbox[] = [];
  requests: RecordedRequest[] = [];
  revoked = new Set<string>();
  expiredTokens = new Set<string>();
  tokenCalls = 0;
  /** Authorization codes Google would hand to the redirect URI, mapped to the account that signed in. */
  codes = new Map<string, string>();
  codeExchanges: URLSearchParams[] = [];
  revokeCalls: string[] = [];
  /** Every HTTP call the code under test made (a batch counts once), like Cloudflare's subrequest count. */
  outboundCalls = 0;
  batchCalls = 0;
  batchModifyCalls: any[] = [];
  /** Paths (prefix match) that answer with this status once, to exercise retries. */
  failOnce = new Map<string, number>();
  /** Paths (prefix match) that keep answering with this status, like a stuck rate limit. */
  failAlways = new Map<string, number>();
  /** Called before each API request; returning a status makes that request fail with it. */
  intercept?: (method: string, path: string) => number | undefined;

  addMailbox(email: string, refreshToken: string): FakeMailbox {
    const mb: FakeMailbox = {
      email,
      refreshToken,
      messages: new Map(),
      labels: ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT"].map((id) => ({
        id,
        name: id,
        type: "system",
      })),
      drafts: new Map(),
      attachments: new Map(),
      sent: [],
    };
    this.mailboxes.push(mb);
    return mb;
  }

  /** Stores an RFC 822 message as the API would, returning the stored message. */
  deliver(mb: FakeMailbox, raw: string, opts: { threadId?: string; labelIds?: string[]; id?: string } = {}): ApiMessage {
    const id = opts.id ?? nextId("18f");
    const payload = parseMime(raw, (data) => {
      const attId = nextId("ANGj");
      mb.attachments.set(`${id}/${attId}`, data);
      return attId;
    });
    const msg: ApiMessage = {
      id,
      threadId: opts.threadId ?? id,
      labelIds: opts.labelIds ?? ["INBOX", "UNREAD"],
      snippet: "snippet of " + id,
      internalDate: String(Date.UTC(2026, 8, 1, 12, 0, 0) + counter * 1000),
      payload,
    };
    mb.messages.set(id, msg);
    return msg;
  }

  private threadMessages(mb: FakeMailbox, threadId: string): ApiMessage[] {
    return [...mb.messages.values()].filter((m) => m.threadId === threadId);
  }

  private stripBodies(msg: ApiMessage): ApiMessage {
    const strip = (p: ApiMessagePart): ApiMessagePart => ({
      ...p,
      body: { size: p.body?.size ?? 0 },
      parts: p.parts?.map(strip),
    });
    return { ...msg, payload: msg.payload && { ...strip(msg.payload), parts: undefined } };
  }

  private view(msg: ApiMessage, format: string | null): ApiMessage {
    return format === "metadata" ? this.stripBodies(msg) : msg;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    this.outboundCalls++;
    return this.handle(input, init);
  };

  /** Gmail's batch endpoint: runs each embedded GET and returns the answers as multipart/mixed. */
  private async batch(init: RequestInit): Promise<Response> {
    this.batchCalls++;
    const contentType = new Headers(init.headers).get("Content-Type") ?? "";
    const boundary = /boundary=([^;]+)/.exec(contentType)![1];
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    const parts = String(init.body)
      .split(`--${boundary}`)
      .filter((p) => p.trim() && !p.startsWith("--"));
    const out: string[] = [];
    for (const part of parts) {
      const id = /Content-ID: <([^>]+)>/.exec(part)![1];
      const line = part.split("\r\n\r\n")[1].split("\r\n")[0];
      const [method, path] = line.split(" ");
      const res = await this.handle(`https://gmail.googleapis.com${path}`, { method, headers: { Authorization: auth } });
      const reason = res.status === 200 ? "OK" : "Error";
      out.push(
        `--batch_resp\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n` +
          `HTTP/1.1 ${res.status} ${reason}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${await res.text()}\r\n`,
      );
    }
    return new Response(out.join("") + "--batch_resp--", {
      status: 200,
      headers: { "Content-Type": "multipart/mixed; boundary=batch_resp" },
    });
  }

  private handle = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const json = (status: number, value: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.href === "https://oauth2.googleapis.com/revoke") {
      const token = new URLSearchParams(String(init.body)).get("token")!;
      this.revokeCalls.push(token);
      this.revoked.add(token);
      return json(200, {});
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      this.tokenCalls++;
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        this.codeExchanges.push(form);
        const email = this.codes.get(form.get("code") ?? "");
        const signedIn = this.mailboxes.find((m) => m.email === email);
        if (!signedIn || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
        this.codes.delete(form.get("code")!);
        this.revoked.delete(signedIn.refreshToken);
        return json(200, {
          access_token: `at-${signedIn.email}-${this.tokenCalls}`,
          refresh_token: signedIn.refreshToken,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }
      const mb = this.mailboxes.find((m) => m.refreshToken === form.get("refresh_token"));
      if (!mb || this.revoked.has(mb.refreshToken)) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `at-${mb.email}-${this.tokenCalls}`, expires_in: 3600 });
    }

    const auth = new Headers(init.headers).get("Authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const mb = this.mailboxes.find((m) => token.startsWith(`at-${m.email}-`));
    // Revoking a grant at Google also invalidates the access tokens issued from it.
    if (!mb || this.expiredTokens.has(token) || this.revoked.has(mb.refreshToken)) {
      return json(401, { error: { message: "Invalid Credentials" } });
    }

    if (url.pathname === "/batch/gmail/v1") return this.batch(init);

    const prefix = url.pathname.startsWith("/upload/") ? "/upload/gmail/v1/users/me/" : "/gmail/v1/users/me/";
    const path = url.pathname.slice(prefix.length);
    for (const [failPath, status] of this.failOnce) {
      if (path.startsWith(failPath)) {
        this.failOnce.delete(failPath);
        return json(status, { error: { code: status, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } });
      }
    }
    const intercepted = this.intercept?.(method, path);
    if (intercepted) return json(intercepted, { error: { code: intercepted, message: "Backend Error" } });
    for (const [failPath, status] of this.failAlways) {
      if (path.startsWith(failPath)) {
        return json(status, { error: { code: status, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } });
      }
    }
    let body: any;
    const contentType = new Headers(init.headers).get("Content-Type") ?? "";
    if (init.body && contentType.startsWith("application/json")) body = JSON.parse(String(init.body));
    if (init.body && contentType.startsWith("multipart/related")) body = parseUpload(String(init.body), contentType);
    this.requests.push({ method, path, query: url.searchParams, email: mb.email, body });

    const seg = path.split("/");
    const notFound = () => json(404, { error: { message: "Requested entity was not found." } });

    // threads
    if (method === "GET" && path === "threads") {
      const threadIds = [...new Set([...mb.messages.values()].reverse().map((m) => m.threadId))];
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = mb.pageSize ?? Number(url.searchParams.get("maxResults") ?? 20);
      const page = threadIds.slice(start, start + size);
      const next = start + size < threadIds.length ? String(start + size) : undefined;
      return json(200, { threads: page.map((id) => ({ id })), ...(next ? { nextPageToken: next } : {}) });
    }
    if (seg[0] === "threads" && seg.length === 2 && method === "GET") {
      const msgs = this.threadMessages(mb, seg[1]);
      if (!msgs.length) return notFound();
      return json(200, { id: seg[1], messages: msgs.map((m) => this.view(m, url.searchParams.get("format"))) });
    }
    if (seg[0] === "threads" && seg.length === 3 && method === "POST") {
      const msgs = this.threadMessages(mb, seg[1]);
      if (!msgs.length) return notFound();
      for (const m of msgs) this.applyModify(m, seg[2], body);
      return json(200, { id: seg[1], messages: msgs.map((m) => ({ id: m.id, labelIds: m.labelIds })) });
    }

    // messages
    if (method === "GET" && path === "messages") {
      const q = url.searchParams.get("q") ?? "";
      const labelIds = url.searchParams.getAll("labelIds");
      const all = [...mb.messages.values()]
        .reverse()
        .filter((m) => labelIds.every((id) => m.labelIds?.includes(id)))
        .filter((m) => this.matches(mb, m, q, url.searchParams.get("includeSpamTrash") === "true"));
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return json(200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: all.length,
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    if (method === "POST" && path === "messages/batchModify") {
      this.batchModifyCalls.push(body);
      for (const id of body.ids) {
        const msg = mb.messages.get(id);
        if (msg) this.applyModify(msg, "modify", body);
      }
      return json(204, undefined);
    }
    if (method === "POST" && path === "messages/send") {
      const { metadata, raw } = body;
      const message = this.deliver(mb, raw, { threadId: metadata.threadId, labelIds: ["SENT"] });
      mb.sent.push({ metadata, raw, message });
      return json(200, { id: message.id, threadId: message.threadId, labelIds: message.labelIds });
    }
    if (seg[0] === "messages") {
      const msg = mb.messages.get(seg[1]);
      if (!msg) return notFound();
      if (seg.length === 2 && method === "GET") {
        if (url.searchParams.get("format") === "raw") return json(200, { ...msg, payload: undefined, raw: Buffer.from("raw!").toString("base64url") });
        return json(200, this.view(msg, url.searchParams.get("format")));
      }
      if (seg[2] === "attachments") {
        const data = mb.attachments.get(`${seg[1]}/${seg[3]}`);
        return data ? json(200, { data, size: Buffer.from(data, "base64url").length }) : notFound();
      }
      if (method === "POST") {
        this.applyModify(msg, seg[2], body);
        return json(200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
      }
    }

    // labels
    if (path === "labels" && method === "GET") return json(200, { labels: mb.labels });
    if (path === "labels" && method === "POST") {
      if (mb.labels.some((l) => l.name === body.name)) return json(409, { error: { message: "Label name exists or conflicts" } });
      const label = { id: nextId("Label_"), type: "user", ...body };
      mb.labels.push(label);
      return json(200, label);
    }
    if (seg[0] === "labels" && seg.length === 2) {
      const label = mb.labels.find((l) => l.id === seg[1]);
      if (!label) return notFound();
      if (method === "PATCH") return json(200, Object.assign(label, body));
      if (method === "DELETE") {
        mb.labels = mb.labels.filter((l) => l !== label);
        return json(204, undefined);
      }
    }

    // drafts
    if (path === "drafts" && method === "GET") {
      return json(200, { drafts: [...mb.drafts.entries()].map(([id, messageId]) => ({ id, message: { id: messageId } })) });
    }
    if (path === "drafts" && method === "POST") {
      const { metadata, raw } = body;
      const message = this.deliver(mb, raw, { threadId: metadata.message?.threadId, labelIds: ["DRAFT"] });
      const id = nextId("r-");
      mb.drafts.set(id, message.id);
      return json(200, { id, message: { id: message.id, threadId: message.threadId, labelIds: message.labelIds } });
    }
    if (path === "drafts/send" && method === "POST") {
      const messageId = mb.drafts.get(body.id);
      if (!messageId) return notFound();
      mb.drafts.delete(body.id);
      const msg = mb.messages.get(messageId)!;
      msg.labelIds = ["SENT"];
      return json(200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
    }
    if (seg[0] === "drafts" && seg.length === 2) {
      const messageId = mb.drafts.get(seg[1]);
      if (!messageId) return notFound();
      if (method === "GET") {
        return json(200, { id: seg[1], message: this.view(mb.messages.get(messageId)!, url.searchParams.get("format")) });
      }
      if (method === "DELETE") {
        mb.drafts.delete(seg[1]);
        mb.messages.delete(messageId);
        return json(204, undefined);
      }
      if (method === "PUT") {
        const { metadata, raw } = body;
        const old = mb.messages.get(messageId)!;
        mb.messages.delete(messageId);
        const message = this.deliver(mb, raw, { threadId: metadata.message?.threadId ?? old.threadId, labelIds: ["DRAFT"] });
        mb.drafts.set(seg[1], message.id);
        return json(200, { id: seg[1], message: { id: message.id, threadId: message.threadId, labelIds: message.labelIds } });
      }
    }

    if (path === "profile") return json(200, { emailAddress: mb.email });
    return json(400, { error: { message: `fake: unhandled ${method} ${path}` } });
  };

  /**
   * A small subset of Gmail search: category:, from:, is:, in:, label: (quoted names too), "-" to
   * negate, ( ) and OR, which as in Gmail binds tighter than the implicit AND. Other terms match all.
   */
  private matches(mb: FakeMailbox, msg: ApiMessage, q: string, includeSpamTrash: boolean): boolean {
    const labels = msg.labelIds ?? [];
    const wantsTrashOrSpam = /(?:^|[\s({])in:(trash|spam|anywhere)\b/i.test(q);
    if (!includeSpamTrash && !wantsTrashOrSpam && (labels.includes("TRASH") || labels.includes("SPAM"))) return false;
    const term = (token: string): boolean => {
      const negate = token.startsWith("-");
      const body = token.replace(/^-/, "");
      const colon = body.indexOf(":");
      if (colon < 0) return true;
      const key = body.slice(0, colon).toLowerCase();
      const value = body.slice(colon + 1).replace(/^"(.*)"$/, "$1");
      let hit: boolean;
      if (key === "category") hit = labels.includes(`CATEGORY_${value.toLowerCase() === "primary" ? "PERSONAL" : value.toUpperCase()}`);
      else if (key === "from") hit = (msg.payload?.headers?.find((h) => h.name === "From")?.value ?? "").toLowerCase().includes(value.toLowerCase());
      else if (key === "is") hit = labels.includes(value.toUpperCase());
      else if (key === "in") hit = value === "anywhere" || labels.includes(value.toUpperCase());
      else if (key === "label") hit = labels.some((l) => l === value || mb.labels.find((x) => x.id === l)?.name.toLowerCase() === value.toLowerCase());
      else return true;
      return hit !== negate;
    };
    // Tokens: "(", ")", "OR", and terms (a quoted value may contain spaces and parentheses).
    const tokens = q.match(/[()]|-?[^\s()"]*"[^"]*"|[^\s()]+/g) ?? [];
    let pos = 0;
    const all = (): boolean => {
      let result = true;
      while (pos < tokens.length && tokens[pos] !== ")") result = anyOf() && result;
      return result;
    };
    const anyOf = (): boolean => {
      let result = one();
      while (tokens[pos] === "OR") {
        pos++;
        result = one() || result;
      }
      return result;
    };
    const one = (): boolean => {
      const token = tokens[pos++];
      if (token !== "(") return term(token);
      const result = all();
      pos++; // ")"
      return result;
    };
    return all();
  }

  private applyModify(msg: ApiMessage, action: string, body: any) {
    let labels = new Set(msg.labelIds ?? []);
    if (action === "modify") {
      for (const id of body.removeLabelIds ?? []) labels.delete(id);
      for (const id of body.addLabelIds ?? []) labels.add(id);
    } else if (action === "trash") {
      labels.add("TRASH");
    } else if (action === "untrash") {
      labels.delete("TRASH");
    }
    msg.labelIds = [...labels];
  }

  sentBy(email: string) {
    return this.mailboxes.find((m) => m.email === email)!.sent;
  }
}
