import * as fs from 'node:fs';
import * as path from 'node:path';
import { bareAddress } from './format.js';
const MIME_TYPES = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.ics': 'text/calendar',
    '.eml': 'message/rfc822',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.7z': 'application/x-7z-compressed',
};
export function mimeTypeFor(filename) {
    return MIME_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
export function loadAttachment(spec) {
    const s = typeof spec === 'string' ? { path: spec } : spec;
    let data;
    let filename;
    if (s.path) {
        const p = s.path.startsWith('~') ? path.join(process.env.HOME ?? '', s.path.slice(1)) : s.path;
        if (!fs.existsSync(p))
            throw new Error(`Attachment not found: ${p}`);
        data = fs.readFileSync(p);
        filename = s.filename ?? path.basename(p);
    }
    else if (s.content) {
        data = Buffer.from(s.content, 'base64');
        filename = s.filename ?? 'attachment';
    }
    else {
        throw new Error('Each attachment needs either "path" (local file) or "content" (base64).');
    }
    return {
        filename,
        mimeType: s.mimeType ?? mimeTypeFor(filename),
        data,
        inline: !!s.inline,
        contentId: s.inline ? (s.contentId ?? filename) : undefined,
    };
}
export const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
/** Escape text and hyperlink bare URLs (trailing punctuation stays outside the link). */
export function linkify(escaped) {
    return escaped.replace(URL_RE, (url) => {
        const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
        const href = trail ? url.slice(0, -trail.length) : url;
        return `<a href="${href}">${href}</a>${trail}`;
    });
}
/** Plain text to simple HTML: one <div> per line, blank lines as <div><br></div>, URLs linked. */
export function textToHtml(text) {
    const lines = text.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
    return lines.map((l) => `<div>${l ? linkify(escapeHtml(l)) : '<br>'}</div>`).join('');
}
// --- RFC 2047 / 2231 helpers ------------------------------------------------
const needsEncoding = (s) => /[^\x20-\x7e]/.test(s);
export function encodeHeaderWord(s) {
    return needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=` : s;
}
/** Encode the display-name part of "Name <addr>" if needed; addresses pass through. */
export function encodeAddress(addr) {
    const m = addr.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    if (!m)
        return addr.trim();
    const name = m[1].replace(/^"|"$/g, '');
    if (!name)
        return `<${m[2]}>`;
    if (needsEncoding(name))
        return `${encodeHeaderWord(name)} <${m[2]}>`;
    return /[^\w\s.'-]/.test(name) ? `"${name.replace(/"/g, '\\"')}" <${m[2]}>` : `${name} <${m[2]}>`;
}
function encodeFilenameParam(filename) {
    if (!needsEncoding(filename) && !/["\\]/.test(filename))
        return `filename="${filename}"`;
    return `filename*=UTF-8''${encodeURIComponent(filename)}`;
}
const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');
let counter = 0;
const boundary = (tag) => `----=_${tag}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
/**
 * Assemble an RFC 822 message. Structure, outermost first, only as deep as needed:
 *   multipart/mixed      (when there are regular attachments)
 *     multipart/related  (when there are inline images)
 *       multipart/alternative (when both text and html)
 *         text/plain, text/html
 */
export function buildMime(m) {
    const H = [];
    if (m.from)
        H.push(`From: ${encodeAddress(m.from)}`);
    if (m.to?.length)
        H.push(`To: ${m.to.map(encodeAddress).join(', ')}`);
    if (m.cc?.length)
        H.push(`Cc: ${m.cc.map(encodeAddress).join(', ')}`);
    if (m.bcc?.length)
        H.push(`Bcc: ${m.bcc.map(encodeAddress).join(', ')}`);
    if (m.replyTo)
        H.push(`Reply-To: ${encodeAddress(m.replyTo)}`);
    H.push(`Subject: ${encodeHeaderWord(m.subject ?? '')}`);
    if (m.inReplyTo)
        H.push(`In-Reply-To: ${m.inReplyTo}`);
    if (m.references)
        H.push(`References: ${m.references}`);
    for (const [k, v] of Object.entries(m.extraHeaders ?? {}))
        H.push(`${k}: ${v}`);
    H.push('MIME-Version: 1.0');
    const textPart = () => `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        wrap76(Buffer.from(m.text ?? '', 'utf-8').toString('base64')) +
        '\r\n';
    const htmlPart = () => `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        wrap76(Buffer.from(m.html ?? '', 'utf-8').toString('base64')) +
        '\r\n';
    let body;
    if (m.html && m.text !== undefined) {
        const b = boundary('alt');
        body =
            `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n` +
                `--${b}\r\n${textPart()}--${b}\r\n${htmlPart()}--${b}--\r\n`;
    }
    else if (m.html) {
        body = htmlPart();
    }
    else {
        body = textPart();
    }
    const attachmentPart = (a) => `Content-Type: ${a.mimeType}; name="${a.filename.replace(/"/g, '')}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        (a.inline
            ? `Content-ID: <${a.contentId ?? a.filename}>\r\nContent-Disposition: inline; ${encodeFilenameParam(a.filename)}\r\n`
            : `Content-Disposition: attachment; ${encodeFilenameParam(a.filename)}\r\n`) +
        `\r\n${wrap76(a.data.toString('base64'))}\r\n`;
    const inline = (m.attachments ?? []).filter((a) => a.inline);
    const regular = (m.attachments ?? []).filter((a) => !a.inline);
    if (inline.length) {
        const b = boundary('rel');
        body =
            `Content-Type: multipart/related; boundary="${b}"\r\n\r\n--${b}\r\n${body}` +
                inline.map((a) => `--${b}\r\n${attachmentPart(a)}`).join('') +
                `--${b}--\r\n`;
    }
    if (regular.length) {
        const b = boundary('mix');
        body =
            `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}` +
                regular.map((a) => `--${b}\r\n${attachmentPart(a)}`).join('') +
                `--${b}--\r\n`;
    }
    return H.join('\r\n') + '\r\n' + body;
}
export const toBase64Url = (s) => Buffer.from(s).toString('base64url');
const SIG_MARKER = 'gmail_signature';
/** Regex matching the signature text with any whitespace run (including nbsp) treated as equivalent. */
function signatureRegex(text) {
    const escaped = text
        .trim()
        .split(/[\s\u00a0]+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\u00a0]+');
    return new RegExp(escaped, 'g');
}
/** Ensure `text` ends with exactly one copy of the plain signature, separated by a blank line. */
export function signText(text, sig) {
    const body = text.replace(/\r/g, '').replace(/\s+$/, '');
    if (!sig?.text)
        return body;
    const clean = sig.text.replace(/\u00a0/g, ' ').trim();
    const stripped = body.replace(signatureRegex(clean), '').replace(/\s+$/, '');
    return stripped ? `${stripped}\n\n${clean}` : clean;
}
/** Append the HTML signature unless the body already carries one. */
export function signHtml(html, sig) {
    if (!sig?.html)
        return html;
    if (html.includes(SIG_MARKER))
        return html;
    let body = html;
    if (sig.text)
        body = body.replace(signatureRegex(escapeHtml(sig.text.replace(/\u00a0/g, ' ').trim())), '');
    return `${body}<div><br></div><div class="${SIG_MARKER}" data-smartmail="${SIG_MARKER}">${sig.html}</div>`;
}
/** Derive an HTML signature from a plain one (URLs become links, lines become <div>s). */
export function signatureFromText(text) {
    return { text: text.trim(), html: textToHtml(text.trim()) };
}
function attributionLine(src) {
    const when = src.date ? formatQuoteDate(src.date) : 'an earlier date';
    return `On ${when}, ${src.from ?? 'someone'} wrote:`;
}
function formatQuoteDate(dateHeader) {
    const d = new Date(dateHeader);
    if (Number.isNaN(d.getTime()))
        return dateHeader;
    const day = d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const time = d
        .toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true })
        .replace(/\s?([ap])\.?m\.?/i, ' $1m');
    return `${day} at ${time}`;
}
export function quoteText(src) {
    const body = (src.text ?? '').replace(/\r/g, '').trimEnd();
    return (`${attributionLine(src)}\n` +
        body
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'));
}
export function quoteHtml(src) {
    const inner = src.html ?? textToHtml(src.text ?? '');
    return (`<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(attributionLine(src))}<br></div>` +
        `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
        `${inner}</blockquote></div>`);
}
function forwardHeaderLines(src) {
    const lines = [];
    if (src.from)
        lines.push(['From', src.from]);
    if (src.date)
        lines.push(['Date', formatQuoteDate(src.date)]);
    if (src.subject)
        lines.push(['Subject', src.subject]);
    if (src.to?.length)
        lines.push(['To', src.to.join(', ')]);
    if (src.cc?.length)
        lines.push(['Cc', src.cc.join(', ')]);
    return lines;
}
export function forwardText(src) {
    const head = forwardHeaderLines(src)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    return `---------- Forwarded message ---------\n${head}\n\n${(src.text ?? '').replace(/\r/g, '').trimEnd()}`;
}
export function forwardHtml(src) {
    const head = forwardHeaderLines(src)
        .map(([k, v]) => `${escapeHtml(k)}: ${linkify(escapeHtml(v))}<br>`)
        .join('');
    const inner = src.html ?? textToHtml(src.text ?? '');
    return (`<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>${head}</div><br><br>` +
        `${inner}</div>`);
}
/** Reply subject: add "Re: " unless already present (any case, any language variant). */
export function replySubject(subject) {
    return /^\s*(re|aw|sv|vs)\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}
export function forwardSubject(subject) {
    return /^\s*(fwd?|wg|tr)\s*:/i.test(subject) ? subject.trim() : `Fwd: ${subject.trim()}`;
}
/** Remove the user's own addresses from a recipient list (case-insensitive by bare address). */
export function withoutSelf(addrs, self) {
    const seen = new Set();
    return addrs.filter((a) => {
        const b = bareAddress(a);
        if (self.has(b) || seen.has(b))
            return false;
        seen.add(b);
        return true;
    });
}
