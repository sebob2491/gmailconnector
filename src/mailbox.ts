import { GmailClient } from "./gmailClient.js";
import {
  METADATA_HEADERS,
  apiFormat,
  bareAddress,
  extractContent,
  formatMessage,
  header,
  parseAddressList,
  viewUrl,
  type ApiMessage,
  type FormattedMessage,
  type MessageFormat,
} from "./format.js";
import {
  buildMime,
  decodeBase64,
  escapeHtml,
  htmlToText,
  MimeError,
  type OutgoingAttachment,
  type OutgoingMessage,
} from "./mime.js";

export interface AttachmentInput {
  content: string;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: AttachmentInput[];
}

export type ThreadView = "THREAD_VIEW_MINIMAL" | "THREAD_VIEW_METADATA_ONLY";
export type DraftView = "DRAFT_VIEW_METADATA_ONLY" | "DRAFT_VIEW_FULL";

export const LABEL_COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: "#000000", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: "#434343", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: "#666666", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: "#cccccc", textColor: "#000000" },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: "#ffffff", textColor: "#000000" },
  LABEL_COLOR_PRESET_RED: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: "#ffad47", textColor: "#000000" },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: "#fad165", textColor: "#000000" },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: "#16a765", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: "#43d692", textColor: "#000000" },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: "#f691b2", textColor: "#000000" },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: "#822111", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: "#a46a21", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: "#076239", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: "#1c4587", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: "#41236d", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: "#83334c", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: "#7a4706", textColor: "#ffffff" },
};

const LABEL_LIST_VISIBILITY: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MESSAGE_LIST_VISIBILITY: Record<string, string> = { SHOW: "show", HIDE: "hide" };

export interface LabelInput {
  displayName?: string;
  colorPreset?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
}

interface ApiLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { backgroundColor?: string; textColor?: string };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function uniqueAddresses(list: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((a) => a.toLowerCase()));
  const out: string[] = [];
  for (const address of list.map(bareAddress)) {
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

function toAttachments(inputs: AttachmentInput[] | undefined): OutgoingAttachment[] {
  return (inputs ?? []).map((a) => ({
    content: decodeBase64(a.content),
    filename: a.filename,
    mimeType: a.mimeType,
    inline: a.inline,
  }));
}

function mentionsDrafts(query: string | undefined): boolean {
  return /\b(in|is):drafts?\b/i.test(query ?? "");
}

const THREAD_PREVIEW_MESSAGES = 5;

/** All Gmail operations for a single linked account. */
export class Mailbox {
  constructor(readonly client: GmailClient) {}

  get email(): string {
    return this.client.email;
  }

  private loader(messageId: string) {
    return async (attachmentId: string) =>
      (await this.client.request("GET", `messages/${messageId}/attachments/${attachmentId}`)).data as string;
  }

  private format(msg: ApiMessage, format: MessageFormat): Promise<FormattedMessage> {
    return formatMessage(msg, format, this.email, this.loader(msg.id));
  }

  // ---------- threads & messages ----------

  async searchThreads(opts: {
    query?: string;
    pageSize?: number;
    pageToken?: string;
    includeTrash?: boolean;
    view?: ThreadView;
  }) {
    const includeDrafts = mentionsDrafts(opts.query);
    const q = opts.query?.trim()
      ? includeDrafts
        ? opts.query
        : `(${opts.query}) -in:draft`
      : "-in:draft";
    const list = await this.client.request("GET", "threads", {
      query: {
        q,
        maxResults: Math.min(Math.max(opts.pageSize ?? 20, 1), 50),
        pageToken: opts.pageToken,
        includeSpamTrash: opts.includeTrash || undefined,
      },
    });
    const format: MessageFormat = opts.view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const threads = await mapLimit((list.threads ?? []) as { id: string }[], 8, async (t) => {
      const thread = await this.client.request("GET", `threads/${t.id}`, {
        query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
      });
      let messages = (thread.messages ?? []) as ApiMessage[];
      if (!includeDrafts) messages = messages.filter((m) => !m.labelIds?.includes("DRAFT"));
      const recent = messages.slice(-THREAD_PREVIEW_MESSAGES);
      return {
        id: t.id,
        viewUrl: viewUrl(this.email, `all/${t.id}`),
        totalMessages: messages.length,
        ...(messages.length > recent.length ? { omittedOlderMessages: messages.length - recent.length } : {}),
        messages: await Promise.all(recent.map((m) => this.format(m, format))),
      };
    });
    return { threads, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
  }

  async getThread(threadId: string, format: MessageFormat) {
    if (format === "RAW") throw new MimeError("RAW format is not supported for threads; use get_message instead.");
    const thread = await this.client.request("GET", `threads/${threadId}`, {
      query: { format: apiFormat(format), metadataHeaders: format === "MINIMAL" || format === "METADATA_ONLY" ? METADATA_HEADERS : undefined },
    });
    const messages = ((thread.messages ?? []) as ApiMessage[]).filter((m) => !m.labelIds?.includes("DRAFT"));
    return {
      id: thread.id as string,
      viewUrl: viewUrl(this.email, `all/${thread.id}`),
      messages: await Promise.all(messages.map((m) => this.format(m, format))),
    };
  }

  async getRawMessage(messageId: string, format: "full" | "metadata" = "full"): Promise<ApiMessage> {
    return this.client.request("GET", `messages/${messageId}`, {
      query: { format, metadataHeaders: format === "metadata" ? METADATA_HEADERS : undefined },
    });
  }

  async getMessage(messageId: string, format: MessageFormat) {
    const msg: ApiMessage = await this.client.request("GET", `messages/${messageId}`, {
      query: { format: apiFormat(format), metadataHeaders: apiFormat(format) === "metadata" ? METADATA_HEADERS : undefined },
    });
    return this.format(msg, format);
  }

  /** Downloads every attachment of a message so it can be re-attached (forwarding, draft edits). */
  private async downloadAttachments(msg: ApiMessage): Promise<OutgoingAttachment[]> {
    const content = await extractContent(msg.payload, this.loader(msg.id));
    return mapLimit(content.attachments, 4, async (a) => {
      const data = a.id ? await this.loader(msg.id)(a.id) : (findPart(msg, a.partId)?.body?.data ?? "");
      return {
        content: Buffer.from(data, "base64url"),
        filename: a.filename,
        mimeType: a.mimeType,
        inline: a.inline && Boolean(a.contentId),
        contentId: a.contentId,
      };
    });
  }

  // ---------- sending ----------

  private async upload(method: string, path: string, metadata: unknown, mime: string) {
    return this.client.request(method, path, { upload: GmailClient.uploadBody(metadata, mime) });
  }

  /** Threading headers and default recipients for replying to `messageId`. */
  async replyContext(messageId: string, replyAll = false) {
    const original = await this.getRawMessage(messageId, "full");
    const p = original.payload;
    const self = this.email.toLowerCase();
    const from = header(p, "From") ?? "";
    const origTo = parseAddressList(header(p, "To"));
    const origCc = parseAddressList(header(p, "Cc"));
    const sentBySelf = bareAddress(from) === self;
    const to = sentBySelf
      ? uniqueAddresses(origTo)
      : uniqueAddresses(parseAddressList(header(p, "Reply-To") || from));
    const cc = replyAll ? uniqueAddresses(sentBySelf ? origCc : [...origTo, ...origCc], [self, ...to]) : [];
    const rfcId = header(p, "Message-ID");
    const subject = header(p, "Subject") ?? "";
    const content = await extractContent(p, this.loader(original.id));
    return {
      original,
      threadId: original.threadId,
      inReplyTo: rfcId,
      references: [header(p, "References"), rfcId].filter(Boolean).join(" ") || undefined,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
      to,
      cc,
      quote: {
        attribution: `On ${header(p, "Date") ?? "an earlier date"}, ${from} wrote:`,
        text: content.text ?? (content.html !== undefined ? htmlToText(content.html) : ""),
        html: content.html,
      },
    };
  }

  private withQuote(
    input: ComposeInput,
    quote: { attribution: string; text: string; html?: string },
  ): { text?: string; html?: string } {
    const quotedText = `${quote.attribution}\n${quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n")}`;
    const text = `${input.body ?? (input.htmlBody ? htmlToText(input.htmlBody) : "")}\n\n${quotedText}`;
    if (!input.htmlBody) return { text };
    const quotedHtml = quote.html ?? escapeHtml(quote.text).replace(/\n/g, "<br>");
    const html =
      `${input.htmlBody}<br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(quote.attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${quotedHtml}</blockquote></div>`;
    return { text, html };
  }

  async sendMessage(input: ComposeInput & { draftId?: string; replyThreadId?: string; replyToMessageId?: string }) {
    if (input.draftId) {
      const sent = await this.client.request("POST", "drafts/send", { json: { id: input.draftId } });
      return this.sentResult(sent);
    }
    const to = input.to ?? [];
    if (!to.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc (or a draftId).");
    }
    const msg: OutgoingMessage = {
      to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.body,
      html: input.htmlBody,
      attachments: toAttachments(input.attachments),
    };
    let threadId = input.replyThreadId;
    if (input.replyToMessageId) {
      const ctx = await this.replyContext(input.replyToMessageId);
      msg.inReplyTo = ctx.inReplyTo;
      msg.references = ctx.references;
      msg.subject ??= ctx.subject;
      threadId = ctx.threadId;
    }
    const sent = await this.upload("POST", "messages/send", threadId ? { threadId } : {}, buildMime(msg));
    return this.sentResult(sent);
  }

  async reply(input: ComposeInput & { messageId: string; replyAll?: boolean }) {
    if (!input.body && !input.htmlBody) throw new MimeError("Provide body or htmlBody for the reply.");
    const ctx = await this.replyContext(input.messageId, input.replyAll);
    const { text, html } = this.withQuote(input, ctx.quote);
    const mime = buildMime({
      to: input.to?.length ? input.to : ctx.to,
      cc: input.cc?.length ? input.cc : ctx.cc,
      bcc: input.bcc,
      subject: ctx.subject,
      text,
      html,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
    });
    const sent = await this.upload("POST", "messages/send", { threadId: ctx.threadId }, mime);
    return this.sentResult(sent);
  }

  async forward(input: {
    messageId: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    forwardText?: string;
    htmlBody?: string;
  }) {
    if (!input.to?.length && !input.cc?.length && !input.bcc?.length) {
      throw new MimeError("Provide at least one recipient in to, cc or bcc.");
    }
    const original = await this.getRawMessage(input.messageId, "full");
    const p = original.payload;
    const content = await extractContent(p, this.loader(original.id));
    const origText = content.text ?? (content.html !== undefined ? htmlToText(content.html) : "");
    const meta: [string, string | undefined][] = [
      ["From", header(p, "From")],
      ["Date", header(p, "Date")],
      ["Subject", header(p, "Subject")],
      ["To", header(p, "To")],
      ["Cc", header(p, "Cc")],
    ];
    const present = meta.filter((m): m is [string, string] => Boolean(m[1]));
    const intro = input.forwardText ?? (input.htmlBody ? htmlToText(input.htmlBody) : "");
    const text =
      `${intro}\n\n---------- Forwarded message ---------\n` +
      present.map(([k, v]) => `${k}: ${v}`).join("\n") +
      `\n\n${origText}`;
    const introHtml = input.htmlBody ?? escapeHtml(input.forwardText ?? "").replace(/\n/g, "<br>");
    const html =
      `${introHtml}<br><br><div class="gmail_quote">---------- Forwarded message ---------<br>` +
      present.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`).join("") +
      `<br>${content.html ?? escapeHtml(origText).replace(/\n/g, "<br>")}</div>`;
    const subject = header(p, "Subject") ?? "";
    const rfcId = header(p, "Message-ID");
    const mime = buildMime({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`.trim(),
      text,
      html,
      inReplyTo: rfcId,
      references: [header(p, "References"), rfcId].filter(Boolean).join(" ") || undefined,
      attachments: await this.downloadAttachments(original),
    });
    const sent = await this.upload("POST", "messages/send", { threadId: original.threadId }, mime);
    return this.sentResult(sent);
  }

  private sentResult(sent: { id: string; threadId: string; labelIds?: string[] }) {
    return {
      id: sent.id,
      threadId: sent.threadId,
      labelIds: sent.labelIds ?? [],
      viewUrl: viewUrl(this.email, `all/${sent.id}`),
    };
  }

  // ---------- drafts ----------

  private draftUrl(messageId: string): string {
    return viewUrl(this.email, `drafts?compose=${messageId}`);
  }

  private draftResult(draft: { id: string; message: { id: string; threadId: string } }) {
    return {
      id: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId,
      viewUrl: this.draftUrl(draft.message.id),
    };
  }

  private async formatDraft(draft: { id: string; message: ApiMessage }, format: MessageFormat) {
    const { id: messageId, viewUrl: _v, ...rest } = await this.format(draft.message, format);
    return { id: draft.id, messageId, ...rest, viewUrl: this.draftUrl(messageId) };
  }

  async listDrafts(opts: { query?: string; pageSize?: number; pageToken?: string; view?: DraftView }) {
    const list = await this.client.request("GET", "drafts", {
      query: { q: opts.query, maxResults: Math.min(Math.max(opts.pageSize ?? 20, 1), 50), pageToken: opts.pageToken },
    });
    const full = opts.view === "DRAFT_VIEW_FULL";
    const drafts = await mapLimit((list.drafts ?? []) as { id: string }[], 8, async (d) => {
      const draft = await this.client.request("GET", `drafts/${d.id}`, { query: { format: full ? "full" : "metadata" } });
      const formatted = await this.formatDraft(draft, full ? "PLAIN_TEXT" : "METADATA_ONLY");
      if (full) {
        const { htmlBody: _h, snippet: _s, attachments: _a, labelIds: _l, ...rest } = formatted as FormattedMessage;
        return rest;
      }
      const { labelIds: _l, ...rest } = formatted as FormattedMessage;
      return rest;
    });
    return { drafts, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
  }

  async getDraft(draftId: string, format: MessageFormat) {
    // drafts.get has no metadataHeaders parameter; metadata format returns every header.
    const draft = await this.client.request("GET", `drafts/${draftId}`, { query: { format: apiFormat(format) } });
    return this.formatDraft(draft, format);
  }

  async createDraft(input: ComposeInput & { replyToMessageId?: string }) {
    const msg: OutgoingMessage = {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.body,
      html: input.htmlBody,
      attachments: toAttachments(input.attachments),
    };
    let threadId: string | undefined;
    if (input.replyToMessageId) {
      const ctx = await this.replyContext(input.replyToMessageId);
      Object.assign(msg, this.withQuote(input, ctx.quote));
      msg.inReplyTo = ctx.inReplyTo;
      msg.references = ctx.references;
      msg.subject = input.subject || ctx.subject;
      if (!input.to?.length) msg.to = ctx.to;
      threadId = ctx.threadId;
    }
    const draft = await this.upload("POST", "drafts", { message: threadId ? { threadId } : {} }, buildMime(msg));
    return this.draftResult(draft);
  }

  /**
   * Merge-updates a draft: non-empty fields replace the draft's values, omitted ones are kept.
   * Existing attachments are kept unless `attachments` is given (pass [] to remove them all).
   */
  async updateDraft(input: ComposeInput & { draftId: string }) {
    const existing = await this.client.request("GET", `drafts/${input.draftId}`, { query: { format: "full" } });
    const msg = existing.message as ApiMessage;
    const p = msg.payload;
    const content = await extractContent(p, this.loader(msg.id));
    const pick = (value: string[] | undefined, headerName: string) =>
      value?.length ? value : parseAddressList(header(p, headerName)).map(bareAddress);
    const bodyChanged = Boolean(input.body || input.htmlBody);
    const inReplyTo = header(p, "In-Reply-To");
    const mime = buildMime({
      to: pick(input.to, "To"),
      cc: pick(input.cc, "Cc"),
      bcc: pick(input.bcc, "Bcc"),
      subject: input.subject || header(p, "Subject") || "",
      text: bodyChanged ? input.body : content.text,
      html: bodyChanged ? input.htmlBody : content.html,
      inReplyTo,
      references: header(p, "References"),
      attachments: input.attachments ? toAttachments(input.attachments) : await this.downloadAttachments(msg),
    });
    const draft = await this.upload(
      "PUT",
      `drafts/${input.draftId}`,
      { id: input.draftId, message: inReplyTo ? { threadId: msg.threadId } : {} },
      mime,
    );
    return this.draftResult(draft);
  }

  async deleteDraft(draftId: string) {
    await this.client.request("DELETE", `drafts/${draftId}`);
    return { deleted: draftId };
  }

  // ---------- labels ----------

  async listLabels() {
    const res = await this.client.request("GET", "labels");
    const labels = ((res.labels ?? []) as ApiLabel[])
      .map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        ...(l.color ? { color: l.color } : {}),
        ...(l.labelListVisibility ? { labelListVisibility: l.labelListVisibility } : {}),
        ...(l.messageListVisibility ? { messageListVisibility: l.messageListVisibility } : {}),
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
    return { labels };
  }

  private labelBody(input: LabelInput) {
    return {
      ...(input.displayName ? { name: input.displayName } : {}),
      ...(input.colorPreset && LABEL_COLOR_PRESETS[input.colorPreset] ? { color: LABEL_COLOR_PRESETS[input.colorPreset] } : {}),
      ...(input.labelListVisibility && LABEL_LIST_VISIBILITY[input.labelListVisibility]
        ? { labelListVisibility: LABEL_LIST_VISIBILITY[input.labelListVisibility] }
        : {}),
      ...(input.messageListVisibility && MESSAGE_LIST_VISIBILITY[input.messageListVisibility]
        ? { messageListVisibility: MESSAGE_LIST_VISIBILITY[input.messageListVisibility] }
        : {}),
    };
  }

  async createLabel(input: LabelInput & { displayName: string; autoCreateParentLabels?: boolean }) {
    const name = input.displayName.split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (!name) throw new MimeError("displayName must not be empty.");
    const created: string[] = [];
    if (input.autoCreateParentLabels !== false && name.includes("/")) {
      const existing = new Set(((await this.client.request("GET", "labels")).labels ?? []).map((l: ApiLabel) => l.name.toLowerCase()));
      const segments = name.split("/");
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        if (existing.has(parent.toLowerCase())) continue;
        await this.client.request("POST", "labels", { json: { name: parent } });
        created.push(parent);
      }
    }
    const label: ApiLabel = await this.client.request("POST", "labels", {
      json: { labelListVisibility: "labelShow", messageListVisibility: "show", ...this.labelBody(input), name },
    });
    return { ...label, ...(created.length ? { createdParentLabels: created } : {}) };
  }

  async updateLabel(labelRef: string, input: LabelInput) {
    const [labelId] = await this.resolveLabelIds([labelRef]);
    return this.client.request("PATCH", `labels/${labelId}`, { json: this.labelBody(input) });
  }

  async deleteLabel(labelRef: string) {
    const [labelId] = await this.resolveLabelIds([labelRef]);
    await this.client.request("DELETE", `labels/${labelId}`);
    return { deleted: labelId };
  }

  /** Accepts label IDs or display names (case-insensitive) and returns IDs for this account. */
  async resolveLabelIds(refs: string[] | undefined): Promise<string[]> {
    if (!refs?.length) return [];
    const labels = ((await this.client.request("GET", "labels")).labels ?? []) as ApiLabel[];
    return refs.map((ref) => {
      const byId = labels.find((l) => l.id === ref);
      if (byId) return byId.id;
      const byName = labels.find((l) => l.name.toLowerCase() === ref.trim().toLowerCase());
      if (byName) return byName.id;
      throw new MimeError(`Label "${ref}" not found in ${this.email}. Use list_labels to see this account's labels.`);
    });
  }

  async modify(kind: "messages" | "threads", id: string, add: string[] | undefined, remove: string[] | undefined) {
    const addLabelIds = await this.resolveLabelIds(add);
    const removeLabelIds = await this.resolveLabelIds(remove);
    if (!addLabelIds.length && !removeLabelIds.length) throw new MimeError("Provide at least one label to add or remove.");
    return this.modifyIds(kind, id, addLabelIds, removeLabelIds);
  }

  async modifyIds(kind: "messages" | "threads", id: string, addLabelIds: string[], removeLabelIds: string[]) {
    const res = await this.client.request("POST", `${kind}/${id}/modify`, { json: { addLabelIds, removeLabelIds } });
    return this.modifyResult(kind, res);
  }

  async trash(kind: "messages" | "threads", id: string, untrash = false) {
    const res = await this.client.request("POST", `${kind}/${id}/${untrash ? "untrash" : "trash"}`);
    return this.modifyResult(kind, res);
  }

  private modifyResult(kind: "messages" | "threads", res: any) {
    if (kind === "messages") return { id: res.id, threadId: res.threadId, labelIds: res.labelIds ?? [] };
    return {
      id: res.id,
      messages: ((res.messages ?? []) as ApiMessage[]).map((m) => ({ id: m.id, labelIds: m.labelIds ?? [] })),
    };
  }
}

function findPart(msg: ApiMessage, partId: string | undefined) {
  if (partId === undefined) return undefined;
  const stack = msg.payload ? [msg.payload] : [];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.partId === partId) return part;
    stack.push(...(part.parts ?? []));
  }
  return undefined;
}
