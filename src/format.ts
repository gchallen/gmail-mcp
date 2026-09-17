import type { gmail_v1 } from 'googleapis';

/** Shapes returned to the model. Field names follow the official Gmail MCP server. */
export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Content-ID for inline images, without angle brackets. */
  contentId?: string;
  inline?: boolean;
}

export interface MessageView {
  id: string;
  threadId: string;
  date?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  snippet?: string;
  labelIds?: string[];
  sizeEstimate?: number;
  internalDate?: string;
  messageIdHeader?: string;
  plaintextBody?: string;
  htmlBody?: string;
  attachments?: AttachmentInfo[];
  raw?: string;
}

export type MessageFormat = 'minimal' | 'metadata' | 'plain_text' | 'full' | 'raw';

export const FORMAT_DESCRIPTION =
  'Which fields to return. "plain_text" (default): headers, snippet, labels, attachments list and the text body ' +
  '(HTML converted to text when there is no text part). "full": plain_text plus htmlBody. "minimal": headers, ' +
  'snippet and labels only, no body. "metadata": like minimal but without subject or snippet. "raw": the RFC 822 source.';

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

export function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf-8');
}

/** Split an address header into individual addresses, respecting quoted names. */
export function splitAddresses(header: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "Name <a@b>" -> "a@b"; "a@b" -> "a@b". Lower-cased. */
export function bareAddress(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

/** Decode RFC 2047 encoded words (=?utf-8?B?...?=, =?utf-8?Q?...?=) in a header value. */
export function decodeHeaderValue(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_m, charset: string, enc: string, text: string) => {
      try {
        const cs = charset.toLowerCase().replace('utf8', 'utf-8');
        if (enc.toUpperCase() === 'B')
          return Buffer.from(text, 'base64').toString(cs as BufferEncoding);
        const bytes = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
        return Buffer.from(bytes, 'latin1').toString(cs as BufferEncoding);
      } catch {
        return text;
      }
    },
  );
}

interface Collected {
  text: string[];
  html: string[];
  attachments: AttachmentInfo[];
}

function walk(part: gmail_v1.Schema$MessagePart | undefined, acc: Collected, depth = 0): void {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const disposition = getHeader(part.headers, 'Content-Disposition').toLowerCase();
  const contentId = getHeader(part.headers, 'Content-ID').replace(/^<|>$/g, '');

  if (part.body?.attachmentId) {
    acc.attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename || contentId || `part-${acc.attachments.length + 1}`,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
      ...(contentId ? { contentId } : {}),
      ...(disposition.startsWith('inline') || (contentId && !part.filename)
        ? { inline: true }
        : {}),
    });
  } else if (mime === 'text/plain' && !part.filename) {
    acc.text.push(decodeBody(part.body?.data));
  } else if (mime === 'text/html' && !part.filename) {
    acc.html.push(decodeBody(part.body?.data));
  } else if (part.filename && part.body?.data) {
    // Small attachment delivered inline in the payload (rare, but happens for tiny files).
    acc.attachments.push({
      attachmentId: '',
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
    });
  }

  // multipart/alternative: prefer the richest text we can find, but keep both kinds.
  for (const p of part.parts ?? []) walk(p, acc, depth + 1);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  trade: '™',
  middot: '·',
  bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Small, dependency-free HTML to text conversion for reading mail whose sender
 * only provided an HTML part. Block elements become line breaks, list items
 * get a bullet, links keep their URL in parentheses when it differs from the
 * link text, and style/script/head content is dropped.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/\r/g, '');
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Gmail quotes: keep them, but mark the boundary.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|blockquote|pre|table)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = s.replace(
    /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      const h = decodeEntities(href);
      if (!label) return h;
      if (/^(mailto:|tel:|#)/i.test(h)) return label;
      return label === h ||
        label.replace(/\/$/, '') === h.replace(/\/$/, '') ||
        label === h.replace(/^https?:\/\//, '')
        ? h
        : `${label} (${h})`;
    },
  );
  s = s.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, '[$1]');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
  s = s.replace(/[ \t\u00a0]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function addresses(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string[] | undefined {
  const v = getHeader(headers, name);
  if (!v) return undefined;
  return splitAddresses(decodeHeaderValue(v));
}

/** Build the model-facing view of a message from an API payload. */
export function formatMessage(
  msg: gmail_v1.Schema$Message,
  format: MessageFormat = 'plain_text',
): MessageView {
  const headers = msg.payload?.headers;
  const view: MessageView = { id: msg.id!, threadId: msg.threadId! };

  if (format === 'raw') {
    view.raw = decodeBody(msg.raw);
    return view;
  }

  view.date = getHeader(headers, 'Date') || undefined;
  view.from = decodeHeaderValue(getHeader(headers, 'From')) || undefined;
  view.to = addresses(headers, 'To');
  view.cc = addresses(headers, 'Cc');
  view.bcc = addresses(headers, 'Bcc');
  const replyTo = getHeader(headers, 'Reply-To');
  if (replyTo) view.replyTo = decodeHeaderValue(replyTo);
  if (format !== 'metadata') {
    view.subject = decodeHeaderValue(getHeader(headers, 'Subject'));
    view.snippet = msg.snippet ? decodeEntities(msg.snippet) : undefined;
  }
  view.labelIds = msg.labelIds ?? undefined;
  view.sizeEstimate = msg.sizeEstimate ?? undefined;
  view.internalDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : undefined;
  const mid = getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id');
  if (mid) view.messageIdHeader = mid;

  if (format === 'minimal' || format === 'metadata') return view;

  const acc: Collected = { text: [], html: [], attachments: [] };
  walk(msg.payload, acc);
  const text = acc.text.join('\n').trim();
  const html = acc.html.join('\n').trim();
  view.plaintextBody = text || (html ? htmlToText(html) : '');
  if (format === 'full' && html) view.htmlBody = html;
  if (acc.attachments.length) view.attachments = acc.attachments;
  return view;
}

/** Map our format names onto the API's `format` parameter. */
export function apiFormat(format: MessageFormat): 'minimal' | 'metadata' | 'full' | 'raw' {
  switch (format) {
    case 'raw':
      return 'raw';
    case 'minimal':
    case 'metadata':
      return 'metadata';
    default:
      return 'full';
  }
}

export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Subject',
  'Date',
  'Reply-To',
  'Message-ID',
];
