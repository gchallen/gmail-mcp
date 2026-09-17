import * as fs from 'node:fs';
import * as path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { gmailClient } from './auth.js';
import { loadUserConfig } from './config.js';
import {
  METADATA_HEADERS,
  apiFormat,
  bareAddress,
  decodeHeaderValue,
  formatMessage,
  getHeader,
  htmlToText,
  type AttachmentInfo,
  type MessageFormat,
  type MessageView,
} from './format.js';
import {
  buildMime,
  forwardHtml,
  forwardSubject,
  forwardText,
  loadAttachment,
  quoteHtml,
  quoteText,
  replySubject,
  signHtml,
  signText,
  signatureFromText,
  textToHtml,
  toBase64Url,
  withoutSelf,
  type AttachmentSpec,
  type LoadedAttachment,
  type OutgoingMessage,
  type Signature,
} from './mime.js';

// Above this the raw message goes up as a media upload instead of inline JSON.
const MEDIA_UPLOAD_THRESHOLD = 4 * 1024 * 1024;
const CONCURRENCY = 6;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: (AttachmentSpec | string)[];
  replyToMessageId?: string;
  replyThreadId?: string;
  quote?: boolean;
  signature?: boolean;
  from?: string;
}

export interface ThreadSummary {
  id: string;
  historyId?: string;
  snippet?: string;
  subject?: string;
  messageCount: number;
  lastMessageDate?: string;
  participants: string[];
  labelIds: string[];
  messages: MessageView[];
}

export const LABEL_COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
  BLACK: { backgroundColor: '#000000', textColor: '#ffffff' },
  DARK_GRAY: { backgroundColor: '#434343', textColor: '#ffffff' },
  GRAY: { backgroundColor: '#666666', textColor: '#ffffff' },
  LIGHT_GRAY: { backgroundColor: '#cccccc', textColor: '#000000' },
  WHITE: { backgroundColor: '#ffffff', textColor: '#000000' },
  RED: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
  ORANGE: { backgroundColor: '#ffad47', textColor: '#000000' },
  YELLOW: { backgroundColor: '#fad165', textColor: '#000000' },
  GREEN: { backgroundColor: '#16a765', textColor: '#ffffff' },
  MINT: { backgroundColor: '#43d692', textColor: '#000000' },
  TEAL: { backgroundColor: '#2da2bb', textColor: '#ffffff' },
  BLUE: { backgroundColor: '#4a86e8', textColor: '#ffffff' },
  PURPLE: { backgroundColor: '#a479e2', textColor: '#ffffff' },
  PINK: { backgroundColor: '#f691b2', textColor: '#000000' },
  DARK_RED: { backgroundColor: '#822111', textColor: '#ffffff' },
  DARK_ORANGE: { backgroundColor: '#a46a21', textColor: '#ffffff' },
  DARK_GREEN: { backgroundColor: '#076239', textColor: '#ffffff' },
  DARK_BLUE: { backgroundColor: '#1c4587', textColor: '#ffffff' },
  DARK_PURPLE: { backgroundColor: '#41236d', textColor: '#ffffff' },
  DARK_PINK: { backgroundColor: '#83334c', textColor: '#ffffff' },
  BROWN: { backgroundColor: '#7a4706', textColor: '#ffffff' },
};

export class GmailService {
  private profile?: gmail_v1.Schema$Profile;
  private selfAddresses?: Set<string>;
  private signature?: Signature | null;

  private get api(): gmail_v1.Gmail {
    return gmailClient();
  }

  // ---- identity -------------------------------------------------------------

  async getProfile(): Promise<gmail_v1.Schema$Profile> {
    if (!this.profile) {
      this.profile = (await this.api.users.getProfile({ userId: 'me' })).data;
    }
    return this.profile;
  }

  /** The user's primary address plus every send-as alias, for reply-all self-removal. */
  async selfSet(): Promise<Set<string>> {
    if (this.selfAddresses) return this.selfAddresses;
    const set = new Set<string>();
    const profile = await this.getProfile();
    if (profile.emailAddress) set.add(profile.emailAddress.toLowerCase());
    try {
      const res = await this.api.users.settings.sendAs.list({ userId: 'me' });
      for (const s of res.data.sendAs ?? [])
        if (s.sendAsEmail) set.add(s.sendAsEmail.toLowerCase());
    } catch {
      // settings scope missing: primary address is enough.
    }
    this.selfAddresses = set;
    return set;
  }

  /**
   * Signature precedence: config.json / env, then the signature configured in
   * Gmail's own settings for the primary send-as address, then none.
   */
  async getSignature(): Promise<Signature | undefined> {
    if (this.signature !== undefined) return this.signature ?? undefined;
    const cfg = loadUserConfig();
    if (cfg.appendSignature === false) {
      this.signature = null;
      return undefined;
    }
    if (cfg.signature || cfg.signatureHtml) {
      const text = cfg.signature ?? htmlToText(cfg.signatureHtml!);
      this.signature = { text, html: cfg.signatureHtml ?? signatureFromText(text).html };
      return this.signature;
    }
    try {
      const res = await this.api.users.settings.sendAs.list({ userId: 'me' });
      const primary = (res.data.sendAs ?? []).find((s) => s.isPrimary) ?? res.data.sendAs?.[0];
      if (primary?.signature) {
        this.signature = { text: htmlToText(primary.signature), html: primary.signature };
        return this.signature;
      }
    } catch {
      // No settings scope.
    }
    this.signature = null;
    return undefined;
  }

  // ---- reading --------------------------------------------------------------

  async getMessage(id: string, format: MessageFormat = 'plain_text'): Promise<MessageView> {
    const f = apiFormat(format);
    const res = await this.api.users.messages.get({
      userId: 'me',
      id,
      format: f,
      ...(f === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {}),
    });
    return formatMessage(res.data, format);
  }

  async getMessages(ids: string[], format: MessageFormat): Promise<MessageView[]> {
    return mapLimit(ids, CONCURRENCY, (id) => this.getMessage(id, format));
  }

  async getThread(id: string, format: MessageFormat = 'plain_text'): Promise<ThreadSummary> {
    const f = apiFormat(format === 'raw' ? 'full' : format);
    const res = await this.api.users.threads.get({
      userId: 'me',
      id,
      format: f,
      ...(f === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {}),
    });
    return this.summarizeThread(res.data, format === 'raw' ? 'full' : format);
  }

  private summarizeThread(t: gmail_v1.Schema$Thread, format: MessageFormat): ThreadSummary {
    const messages = (t.messages ?? []).map((m) => formatMessage(m, format));
    const labels = new Set<string>();
    const people = new Set<string>();
    for (const m of messages) {
      m.labelIds?.forEach((l) => labels.add(l));
      if (m.from) people.add(m.from);
    }
    const last = messages[messages.length - 1];
    return {
      id: t.id!,
      historyId: t.historyId ?? undefined,
      snippet: t.snippet ?? last?.snippet,
      subject: messages.find((m) => m.subject)?.subject,
      messageCount: messages.length,
      lastMessageDate: last?.internalDate ?? last?.date,
      participants: [...people],
      labelIds: [...labels],
      messages,
    };
  }

  async searchMessages(opts: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
    format?: MessageFormat;
  }) {
    const res = await this.api.users.messages.list({
      userId: 'me',
      q: opts.query,
      maxResults: Math.min(opts.maxResults ?? 20, 500),
      pageToken: opts.pageToken,
      labelIds: opts.labelIds,
      includeSpamTrash: opts.includeSpamTrash,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id!);
    const messages = await this.getMessages(ids, opts.format ?? 'minimal');
    return {
      messages,
      nextPageToken: res.data.nextPageToken ?? undefined,
      resultSizeEstimate: res.data.resultSizeEstimate ?? undefined,
    };
  }

  async searchThreads(opts: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
    view?: 'minimal' | 'metadata' | 'messages';
  }) {
    // Match the official server: threads consisting only of drafts are hidden
    // unless the query asks for drafts.
    let q = opts.query ?? '';
    if (!/\b(in|is|label):drafts?\b/i.test(q)) q = `${q} -in:draft`.trim();
    const res = await this.api.users.threads.list({
      userId: 'me',
      q,
      maxResults: Math.min(opts.maxResults ?? 20, 500),
      pageToken: opts.pageToken,
      labelIds: opts.labelIds,
      includeSpamTrash: opts.includeSpamTrash,
    });
    const view = opts.view ?? 'minimal';
    const threads = await mapLimit(res.data.threads ?? [], CONCURRENCY, async (t) => {
      const full = await this.api.users.threads.get({
        userId: 'me',
        id: t.id!,
        format: 'metadata',
        metadataHeaders: METADATA_HEADERS,
      });
      const summary = this.summarizeThread(full.data, view === 'metadata' ? 'metadata' : 'minimal');
      if (view === 'messages') return summary;
      const { messages, ...rest } = summary;
      return {
        ...rest,
        messageIds: messages.map((m) => m.id),
        lastFrom: messages[messages.length - 1]?.from,
      };
    });
    return {
      threads,
      nextPageToken: res.data.nextPageToken ?? undefined,
      resultSizeEstimate: res.data.resultSizeEstimate ?? undefined,
    };
  }

  // ---- attachments ----------------------------------------------------------

  async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const m = await this.getMessage(messageId, 'plain_text');
    return m.attachments ?? [];
  }

  private async fetchAttachment(messageId: string, att: AttachmentInfo): Promise<Buffer> {
    if (!att.attachmentId) {
      // Tiny attachment carried inline in the payload: re-read the part.
      const res = await this.api.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const find = (p?: gmail_v1.Schema$MessagePart): string | undefined => {
        if (!p) return undefined;
        if (p.filename === att.filename && p.body?.data) return p.body.data;
        for (const c of p.parts ?? []) {
          const d = find(c);
          if (d) return d;
        }
        return undefined;
      };
      return Buffer.from(find(res.data.payload) ?? '', 'base64url');
    }
    const res = await this.api.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: att.attachmentId,
    });
    return Buffer.from(res.data.data ?? '', 'base64url');
  }

  /** Download attachments to a directory; returns the written paths. */
  async saveAttachments(opts: {
    messageId: string;
    directory: string;
    filenameContains?: string;
    attachmentId?: string;
    includeInline?: boolean;
    overwrite?: boolean;
  }): Promise<{
    saved: { path: string; filename: string; mimeType: string; size: number }[];
    skipped: string[];
  }> {
    const all = await this.listAttachments(opts.messageId);
    let wanted = all;
    if (opts.attachmentId) wanted = all.filter((a) => a.attachmentId === opts.attachmentId);
    else {
      if (!opts.includeInline) wanted = wanted.filter((a) => !a.inline);
      if (opts.filenameContains) {
        const needle = opts.filenameContains.toLowerCase();
        wanted = wanted.filter((a) => a.filename.toLowerCase().includes(needle));
      }
    }
    if (!wanted.length) {
      throw new Error(
        all.length
          ? `No attachment matched (available: ${all.map((a) => a.filename).join(', ')})`
          : 'No attachments on that message.',
      );
    }
    const dir = opts.directory.startsWith('~')
      ? path.join(process.env.HOME ?? '', opts.directory.slice(1))
      : opts.directory;
    fs.mkdirSync(dir, { recursive: true });
    const saved: { path: string; filename: string; mimeType: string; size: number }[] = [];
    const skipped: string[] = [];
    for (const a of wanted) {
      const safe = path.basename(a.filename).replace(/[\/\\:\0]/g, '_') || 'attachment';
      let dest = path.join(dir, safe);
      if (fs.existsSync(dest) && !opts.overwrite) {
        const ext = path.extname(safe);
        const stem = safe.slice(0, safe.length - ext.length);
        let n = 1;
        while (fs.existsSync(dest)) dest = path.join(dir, `${stem} (${n++})${ext}`);
      }
      const data = await this.fetchAttachment(opts.messageId, a);
      if (!data.length) {
        skipped.push(a.filename);
        continue;
      }
      fs.writeFileSync(dest, data);
      saved.push({ path: dest, filename: a.filename, mimeType: a.mimeType, size: data.length });
    }
    return { saved, skipped };
  }

  /** Pull every attachment of a message into memory, to re-attach on forward or draft update. */
  private async loadMessageAttachments(
    messageId: string,
    includeInline = true,
  ): Promise<LoadedAttachment[]> {
    const atts = await this.listAttachments(messageId);
    return mapLimit(
      atts.filter((a) => includeInline || !a.inline),
      CONCURRENCY,
      async (a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        data: await this.fetchAttachment(messageId, a),
        inline: !!a.inline,
        contentId: a.contentId,
      }),
    );
  }

  // ---- composing ------------------------------------------------------------

  /**
   * Turn a compose request into a MIME message. Handles threading headers,
   * quoting of the replied-to message, and the signature. Returns the raw
   * message plus the thread it belongs to.
   */
  async compose(
    input: ComposeInput,
    mode: 'new' | 'reply' | 'forward' = 'new',
  ): Promise<{ raw: string; threadId?: string; summary: Record<string, unknown> }> {
    const out: OutgoingMessage = {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      from: input.from,
      attachments: (input.attachments ?? []).map(loadAttachment),
    };
    let threadId = input.replyThreadId;
    let original: MessageView | undefined;

    if (input.replyToMessageId) {
      original = await this.getMessage(input.replyToMessageId, 'full');
      threadId = original.threadId;
      const mid = original.messageIdHeader;
      if (mid) {
        out.inReplyTo = mid;
        const refs = await this.referencesFor(input.replyToMessageId);
        out.references = [refs, mid].filter(Boolean).join(' ');
      }
      if (!out.subject && original.subject !== undefined) {
        out.subject =
          mode === 'forward' ? forwardSubject(original.subject) : replySubject(original.subject);
      }
    } else if (threadId && !out.subject) {
      const t = await this.getThread(threadId, 'minimal');
      if (t.subject) out.subject = replySubject(t.subject);
      const last = t.messages[t.messages.length - 1];
      if (last?.messageIdHeader) {
        out.inReplyTo = last.messageIdHeader;
        out.references = [await this.referencesFor(last.id), last.messageIdHeader]
          .filter(Boolean)
          .join(' ');
      }
    }

    const sig = input.signature === false ? undefined : await this.getSignature();
    const wantHtml = input.htmlBody !== undefined;
    let text = signText(input.body ?? (wantHtml ? htmlToText(input.htmlBody!) : ''), sig);
    let html = wantHtml ? signHtml(input.htmlBody!, sig) : undefined;

    if (original && input.quote !== false && mode !== 'new') {
      const src = {
        from: original.from,
        date: original.date,
        to: original.to,
        cc: original.cc,
        subject: original.subject,
        text: original.plaintextBody,
        html: original.htmlBody,
      };
      const qText = mode === 'forward' ? forwardText(src) : quoteText(src);
      const qHtml = mode === 'forward' ? forwardHtml(src) : quoteHtml(src);
      text = `${text}\n\n${qText}`;
      // A reply to an HTML message keeps its formatting by going out as HTML too.
      if (html === undefined && original.htmlBody)
        html = signHtml(textToHtml(input.body ?? ''), sig);
      if (html !== undefined) html = `${html}<br><div><br></div>${qHtml}`;
    }
    out.text = text;
    out.html = html;

    const raw = buildMime(out);
    return {
      raw,
      threadId,
      summary: {
        to: out.to,
        cc: out.cc,
        bcc: out.bcc,
        subject: out.subject,
        attachments: out.attachments?.map((a) => ({
          filename: a.filename,
          size: a.data.length,
          inline: a.inline || undefined,
        })),
        threadId,
        bytes: raw.length,
      },
    };
  }

  private async referencesFor(messageId: string): Promise<string> {
    const res = await this.api.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['References'],
    });
    return getHeader(res.data.payload?.headers, 'References');
  }

  /** Reply recipients following Gmail's rules, unless overridden. */
  private async replyRecipients(original: MessageView, replyAll: boolean) {
    const self = await this.selfSet();
    const fromIsSelf = original.from ? self.has(bareAddress(original.from)) : false;
    const primary = original.replyTo ?? original.from;
    let to: string[];
    let cc: string[] = [];
    if (fromIsSelf) {
      // Replying to one's own message: continue to its recipients.
      to = original.to ?? [];
      if (replyAll) cc = original.cc ?? [];
    } else {
      to = primary ? [primary] : [];
      if (replyAll) {
        to = withoutSelf([...to, ...(original.to ?? [])], self);
        cc = withoutSelf(original.cc ?? [], new Set([...self, ...to.map(bareAddress)]));
      }
    }
    return { to: withoutSelf(to, fromIsSelf ? new Set() : self), cc };
  }

  private async upload(kind: 'draft' | 'send', raw: string, threadId?: string, draftId?: string) {
    const big = raw.length > MEDIA_UPLOAD_THRESHOLD;
    const message = { threadId, ...(big ? {} : { raw: toBase64Url(raw) }) };
    const media = big ? { mimeType: 'message/rfc822', body: raw } : undefined;
    if (kind === 'send') {
      const res = await this.api.users.messages.send({ userId: 'me', requestBody: message, media });
      return res.data;
    }
    if (draftId) {
      const res = await this.api.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message },
        media,
      });
      return res.data;
    }
    const res = await this.api.users.drafts.create({
      userId: 'me',
      requestBody: { message },
      media,
    });
    return res.data;
  }

  private draftLink(draft: gmail_v1.Schema$Draft) {
    return `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message?.id ?? ''}`;
  }

  async createDraft(input: ComposeInput, mode: 'new' | 'reply' | 'forward' = 'new') {
    const { raw, threadId, summary } = await this.compose(input, mode);
    const draft = (await this.upload('draft', raw, threadId)) as gmail_v1.Schema$Draft;
    return {
      draftId: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId ?? threadId,
      link: this.draftLink(draft),
      ...summary,
    };
  }

  async sendNew(input: ComposeInput, mode: 'new' | 'reply' | 'forward' = 'new') {
    const { raw, threadId, summary } = await this.compose(input, mode);
    const sent = (await this.upload('send', raw, threadId)) as gmail_v1.Schema$Message;
    return { messageId: sent.id, threadId: sent.threadId, labelIds: sent.labelIds, ...summary };
  }

  async sendDraft(draftId: string) {
    const res = await this.api.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return { messageId: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds };
  }

  async reply(opts: ComposeInput & { messageId: string; replyAll?: boolean; asDraft?: boolean }) {
    const original = await this.getMessage(opts.messageId, 'minimal');
    const defaults = await this.replyRecipients(original, !!opts.replyAll);
    const input: ComposeInput = {
      ...opts,
      to: opts.to?.length ? opts.to : defaults.to,
      cc: opts.cc?.length ? opts.cc : defaults.cc,
      replyToMessageId: opts.messageId,
    };
    return opts.asDraft ? this.createDraft(input, 'reply') : this.sendNew(input, 'reply');
  }

  async forward(
    opts: ComposeInput & { messageId: string; includeAttachments?: boolean; asDraft?: boolean },
  ) {
    const originalAttachments =
      opts.includeAttachments === false
        ? []
        : await this.loadMessageAttachments(opts.messageId, true);
    const input: ComposeInput = {
      ...opts,
      replyToMessageId: opts.messageId,
      attachments: [
        ...(opts.attachments ?? []),
        ...originalAttachments.map((a) => ({
          content: a.data.toString('base64'),
          filename: a.filename,
          mimeType: a.mimeType,
          inline: a.inline,
          contentId: a.contentId,
        })),
      ],
    };
    // A forward is a new conversation for the recipient, but Gmail keeps it in
    // the original thread, as the web UI does.
    return opts.asDraft ? this.createDraft(input, 'forward') : this.sendNew(input, 'forward');
  }

  // ---- drafts ---------------------------------------------------------------

  async listDrafts(opts: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    view?: 'metadata' | 'full';
  }) {
    const res = await this.api.users.drafts.list({
      userId: 'me',
      q: opts.query,
      maxResults: Math.min(opts.maxResults ?? 20, 500),
      pageToken: opts.pageToken,
    });
    const drafts = await mapLimit(res.data.drafts ?? [], CONCURRENCY, async (d) => {
      const full = await this.api.users.drafts.get({
        userId: 'me',
        id: d.id!,
        format: opts.view === 'full' ? 'full' : 'metadata',
      });
      const m = formatMessage(full.data.message!, opts.view === 'full' ? 'plain_text' : 'minimal');
      return { draftId: d.id, messageId: m.id, ...m, link: this.draftLink(full.data) };
    });
    return {
      drafts,
      nextPageToken: res.data.nextPageToken ?? undefined,
      resultSizeEstimate: res.data.resultSizeEstimate ?? undefined,
    };
  }

  async getDraft(draftId: string, format: MessageFormat = 'plain_text') {
    const res = await this.api.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: apiFormat(format),
    });
    const m = formatMessage(res.data.message!, format);
    return { draftId: res.data.id, messageId: m.id, ...m, link: this.draftLink(res.data) };
  }

  /**
   * Merge semantics: only the fields given change. Unlike the official server,
   * existing attachments survive unless `attachments` is given (replace) or
   * `clearAttachments` is set. Threading headers are preserved.
   */
  async updateDraft(opts: {
    draftId: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    attachments?: (AttachmentSpec | string)[];
    clearAttachments?: boolean;
    signature?: boolean;
  }) {
    const res = await this.api.users.drafts.get({ userId: 'me', id: opts.draftId, format: 'full' });
    const msg = res.data.message!;
    const existing = formatMessage(msg, 'full');
    const headers = msg.payload?.headers;

    let attachments: LoadedAttachment[] = [];
    if (opts.attachments) attachments = opts.attachments.map(loadAttachment);
    else if (!opts.clearAttachments && existing.attachments?.length)
      attachments = await this.loadMessageAttachments(msg.id!, true);

    const bodyChanged = opts.body !== undefined || opts.htmlBody !== undefined;
    const sig =
      opts.signature === false ? undefined : bodyChanged ? await this.getSignature() : undefined;
    let text: string;
    let html: string | undefined;
    if (bodyChanged) {
      // A new body replaces the old one wholesale; a quoted original in the
      // old draft is not carried over (say so in the tool description).
      html = opts.htmlBody !== undefined ? signHtml(opts.htmlBody, sig) : undefined;
      text = signText(
        opts.body ?? (opts.htmlBody !== undefined ? htmlToText(opts.htmlBody) : ''),
        sig,
      );
    } else {
      text = existing.plaintextBody ?? '';
      html = existing.htmlBody;
    }

    const out: OutgoingMessage = {
      to: opts.to?.length ? opts.to : existing.to,
      cc: opts.cc?.length ? opts.cc : existing.cc,
      bcc: opts.bcc?.length ? opts.bcc : existing.bcc,
      subject: opts.subject ?? existing.subject,
      inReplyTo: getHeader(headers, 'In-Reply-To') || undefined,
      references: getHeader(headers, 'References') || undefined,
      text,
      html,
      attachments,
    };
    const raw = buildMime(out);
    const draft = (await this.upload(
      'draft',
      raw,
      msg.threadId ?? undefined,
      opts.draftId,
    )) as gmail_v1.Schema$Draft;
    return {
      draftId: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      link: this.draftLink(draft),
      to: out.to,
      cc: out.cc,
      bcc: out.bcc,
      subject: out.subject,
      attachments: attachments.map((a) => ({ filename: a.filename, size: a.data.length })),
    };
  }

  async deleteDraft(draftId: string) {
    await this.api.users.drafts.delete({ userId: 'me', id: draftId });
    return { deleted: draftId };
  }

  // ---- labels ---------------------------------------------------------------

  async listLabels() {
    const res = await this.api.users.labels.list({ userId: 'me' });
    const labels = (res.data.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      ...(l.color ? { color: l.color } : {}),
      ...(l.labelListVisibility ? { labelListVisibility: l.labelListVisibility } : {}),
      ...(l.messageListVisibility ? { messageListVisibility: l.messageListVisibility } : {}),
    }));
    labels.sort((a, b) =>
      a.type === b.type ? (a.name ?? '').localeCompare(b.name ?? '') : a.type === 'system' ? -1 : 1,
    );
    return labels;
  }

  async getLabel(labelId: string) {
    return (await this.api.users.labels.get({ userId: 'me', id: labelId })).data;
  }

  /** Resolve a label given as an ID or a display name (case-insensitive) to its ID. */
  async resolveLabelIds(labels: string[]): Promise<string[]> {
    const known = await this.listLabels();
    return labels.map((l) => {
      if (known.some((k) => k.id === l)) return l;
      const byName = known.find((k) => (k.name ?? '').toLowerCase() === l.toLowerCase());
      if (byName?.id) return byName.id;
      const sys = l.toUpperCase();
      if (known.some((k) => k.id === sys)) return sys;
      throw new Error(`Unknown label "${l}". Use list_labels to see IDs and names.`);
    });
  }

  private colorFor(preset?: string, backgroundColor?: string, textColor?: string) {
    if (preset) {
      const key = preset.replace(/^LABEL_COLOR_PRESET_/, '').toUpperCase();
      const c = LABEL_COLOR_PRESETS[key];
      if (!c)
        throw new Error(
          `Unknown color preset "${preset}". One of: ${Object.keys(LABEL_COLOR_PRESETS).join(', ')}`,
        );
      return c;
    }
    if (backgroundColor || textColor)
      return { backgroundColor: backgroundColor ?? '#ffffff', textColor: textColor ?? '#000000' };
    return undefined;
  }

  async createLabel(opts: {
    name: string;
    colorPreset?: string;
    backgroundColor?: string;
    textColor?: string;
    labelListVisibility?: string;
    messageListVisibility?: string;
    autoCreateParents?: boolean;
  }) {
    const color = this.colorFor(opts.colorPreset, opts.backgroundColor, opts.textColor);
    if (opts.autoCreateParents !== false && opts.name.includes('/')) {
      const existing = new Set((await this.listLabels()).map((l) => (l.name ?? '').toLowerCase()));
      const parts = opts.name.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (!existing.has(parent.toLowerCase())) {
          await this.api.users.labels.create({ userId: 'me', requestBody: { name: parent } });
        }
      }
    }
    const res = await this.api.users.labels.create({
      userId: 'me',
      requestBody: {
        name: opts.name,
        ...(color ? { color } : {}),
        labelListVisibility: opts.labelListVisibility ?? 'labelShow',
        messageListVisibility: opts.messageListVisibility ?? 'show',
      },
    });
    return res.data;
  }

  async updateLabel(opts: {
    labelId: string;
    name?: string;
    colorPreset?: string;
    backgroundColor?: string;
    textColor?: string;
    labelListVisibility?: string;
    messageListVisibility?: string;
  }) {
    const color = this.colorFor(opts.colorPreset, opts.backgroundColor, opts.textColor);
    const res = await this.api.users.labels.patch({
      userId: 'me',
      id: opts.labelId,
      requestBody: {
        ...(opts.name ? { name: opts.name } : {}),
        ...(color ? { color } : {}),
        ...(opts.labelListVisibility ? { labelListVisibility: opts.labelListVisibility } : {}),
        ...(opts.messageListVisibility
          ? { messageListVisibility: opts.messageListVisibility }
          : {}),
      },
    });
    return res.data;
  }

  async deleteLabel(labelId: string) {
    await this.api.users.labels.delete({ userId: 'me', id: labelId });
    return { deleted: labelId };
  }

  async modifyMessage(messageId: string, add: string[] = [], remove: string[] = []) {
    const res = await this.api.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: add.length ? await this.resolveLabelIds(add) : undefined,
        removeLabelIds: remove.length ? await this.resolveLabelIds(remove) : undefined,
      },
    });
    return { id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds };
  }

  async modifyThread(threadId: string, add: string[] = [], remove: string[] = []) {
    const res = await this.api.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: {
        addLabelIds: add.length ? await this.resolveLabelIds(add) : undefined,
        removeLabelIds: remove.length ? await this.resolveLabelIds(remove) : undefined,
      },
    });
    const labels = new Set<string>();
    res.data.messages?.forEach((m) => m.labelIds?.forEach((l) => labels.add(l)));
    return { id: res.data.id, messageCount: res.data.messages?.length ?? 0, labelIds: [...labels] };
  }

  /** Bulk label change over explicit IDs or over everything matching a query. */
  async batchModify(opts: {
    messageIds?: string[];
    query?: string;
    maxMessages?: number;
    add?: string[];
    remove?: string[];
  }) {
    let ids = opts.messageIds ?? [];
    if (opts.query) {
      const cap = Math.min(opts.maxMessages ?? 500, 5000);
      let pageToken: string | undefined;
      while (ids.length < cap) {
        const res = await this.api.users.messages.list({
          userId: 'me',
          q: opts.query,
          maxResults: Math.min(500, cap - ids.length),
          pageToken,
        });
        ids.push(...(res.data.messages ?? []).map((m) => m.id!));
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
    }
    if (!ids.length) return { modified: 0, messageIds: [] };
    const addLabelIds = opts.add?.length ? await this.resolveLabelIds(opts.add) : undefined;
    const removeLabelIds = opts.remove?.length
      ? await this.resolveLabelIds(opts.remove)
      : undefined;
    for (let i = 0; i < ids.length; i += 1000) {
      await this.api.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: ids.slice(i, i + 1000), addLabelIds, removeLabelIds },
      });
    }
    return { modified: ids.length, messageIds: ids };
  }

  // ---- trash and spam -------------------------------------------------------

  async trashMessage(id: string) {
    const r = (await this.api.users.messages.trash({ userId: 'me', id })).data;
    return { id: r.id, labelIds: r.labelIds };
  }
  async untrashMessage(id: string) {
    const r = (await this.api.users.messages.untrash({ userId: 'me', id })).data;
    return { id: r.id, labelIds: r.labelIds };
  }
  async trashThread(id: string) {
    await this.api.users.threads.trash({ userId: 'me', id });
    return { id, trashed: true };
  }
  async untrashThread(id: string) {
    await this.api.users.threads.untrash({ userId: 'me', id });
    return { id, trashed: false };
  }
  spamMessage = (id: string) => this.modifyMessage(id, ['SPAM'], ['INBOX']);
  unspamMessage = (id: string) => this.modifyMessage(id, ['INBOX'], ['SPAM']);
  spamThread = (id: string) => this.modifyThread(id, ['SPAM'], ['INBOX']);
  unspamThread = (id: string) => this.modifyThread(id, ['INBOX'], ['SPAM']);
}

export const displayName = (addr: string) =>
  decodeHeaderValue(addr)
    .replace(/<[^>]+>/, '')
    .trim()
    .replace(/^"|"$/g, '') || bareAddress(addr);
