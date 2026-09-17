import { describe, expect, test } from 'bun:test';
import {
  buildMime,
  encodeAddress,
  forwardSubject,
  htmlFromText,
  quoteText,
  replySubject,
  signHtml,
  signText,
  textToHtml,
  withoutSelf,
} from './mime.js';
import { htmlToText, splitAddresses, bareAddress, decodeHeaderValue } from './format.js';

const sig = {
  text: 'Geoffrey Challen // https://geoffreychallen.com',
  html: '<div>Geoffrey Challen // <a href="https://geoffreychallen.com">https://geoffreychallen.com</a></div>',
};

describe('signature', () => {
  test('appends once with a blank line', () => {
    expect(signText('Hi Kathryn,\n\nThanks.', sig)).toBe(
      'Hi Kathryn,\n\nThanks.\n\nGeoffrey Challen // https://geoffreychallen.com',
    );
  });
  test('de-duplicates a typed signature', () => {
    const t = signText('Thanks.\n\nGeoffrey Challen // https://geoffreychallen.com\n', sig);
    expect(t.split('Geoffrey Challen').length).toBe(2);
  });
  test('html appended once', () => {
    const h = signHtml('<div>Hi</div>', sig);
    expect(h).toContain('gmail_signature');
    expect(signHtml(h, sig)).toBe(h);
  });
  test('a text-only body still gets the signature as a hyperlink', () => {
    const text = signText('Hi Kathryn,\n\nThanks.', sig);
    const h = htmlFromText(text, sig);
    expect(h).toContain('<a href="https://geoffreychallen.com">https://geoffreychallen.com</a>');
    expect(h.split('Geoffrey Challen').length).toBe(2);
    expect(h).toContain('gmail_signature');
  });
});

describe('mime', () => {
  test('plain text only is a single text/plain part', () => {
    const raw = buildMime({ to: ['a@b.com'], subject: 'Hi', text: 'hello' });
    expect(raw).toMatch(/^From:|^To: a@b.com/m);
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).not.toContain('multipart');
  });
  test('text + html + attachment nests alternative inside mixed', () => {
    const raw = buildMime({
      to: ['a@b.com'],
      subject: 'Hi',
      text: 'hello',
      html: '<p>hello</p>',
      attachments: [
        { filename: 'x.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf'), inline: false },
      ],
    });
    expect(raw.indexOf('multipart/mixed')).toBeLessThan(raw.indexOf('multipart/alternative'));
    expect(raw).toContain('Content-Disposition: attachment; filename="x.pdf"');
  });
  test('inline image goes in multipart/related with a Content-ID', () => {
    const raw = buildMime({
      to: ['a@b.com'],
      subject: 'Hi',
      text: 'hello',
      html: '<img src="cid:logo.png">',
      attachments: [
        {
          filename: 'logo.png',
          mimeType: 'image/png',
          data: Buffer.from('png'),
          inline: true,
          contentId: 'logo.png',
        },
      ],
    });
    expect(raw).toContain('multipart/related');
    expect(raw).toContain('Content-ID: <logo.png>');
  });
  test('non-ascii subject and name are RFC 2047 encoded', () => {
    const raw = buildMime({ to: ['Zoë <z@b.com>'], subject: 'Café', text: 'x' });
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('To: =?UTF-8?B?');
  });
  test('threading headers', () => {
    const raw = buildMime({
      to: ['a@b.com'],
      subject: 'Re: x',
      text: 'x',
      inReplyTo: '<m1@x>',
      references: '<m0@x> <m1@x>',
    });
    expect(raw).toContain('In-Reply-To: <m1@x>');
    expect(raw).toContain('References: <m0@x> <m1@x>');
  });
});

describe('helpers', () => {
  test('subjects', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fw: Hello')).toBe('Fw: Hello');
  });
  test('addresses', () => {
    expect(splitAddresses('"Last, First" <a@b.com>, c@d.com')).toEqual([
      '"Last, First" <a@b.com>',
      'c@d.com',
    ]);
    expect(bareAddress('Name <A@B.com>')).toBe('a@b.com');
    expect(encodeAddress('Last, First <a@b.com>')).toBe('"Last, First" <a@b.com>');
    expect(withoutSelf(['Me <me@x.com>', 'a@b.com', 'A@b.com'], new Set(['me@x.com']))).toEqual([
      'a@b.com',
    ]);
  });
  test('encoded header words', () => {
    expect(decodeHeaderValue('=?UTF-8?B?Q2Fmw6k=?= <c@d.com>')).toBe('Café <c@d.com>');
    expect(decodeHeaderValue('=?utf-8?Q?Caf=C3=A9?=')).toBe('Café');
  });
  test('quote', () => {
    const q = quoteText({
      from: 'A <a@b.com>',
      date: 'Wed, 16 Sep 2026 17:24:00 +1000',
      text: 'line1\n\nline2',
    });
    expect(q).toMatch(/^On .*2026.*, A <a@b.com> wrote:\n> line1\n>\n> line2$/);
  });
  test('html to text', () => {
    const t = htmlToText(
      '<div>Hi<br>there</div><p>See <a href="https://x.com/a">the doc</a> and <a href="https://y.com">https://y.com</a>.</p><ul><li>one</li><li>two</li></ul><style>p{}</style>&amp; &#8217;',
    );
    expect(t).toBe(
      'Hi\nthere\n\nSee the doc (https://x.com/a) and https://y.com.\n\n• one\n• two\n& ’',
    );
  });
  test('text to html links urls', () => {
    expect(textToHtml('see https://x.com/a.\n\nbye')).toBe(
      '<div>see <a href="https://x.com/a">https://x.com/a</a>.</div><div><br></div><div>bye</div>',
    );
  });
});

describe('signature whitespace', () => {
  test('nbsp in the configured signature still de-duplicates a typed one', () => {
    const s = { text: 'Geoffrey Challen // https://geoffreychallen.com/', html: '' };
    const out = signText('Thanks.\n\nGeoffrey Challen // https://geoffreychallen.com/', s);
    expect(out).toBe('Thanks.\n\nGeoffrey Challen // https://geoffreychallen.com/');
  });
});
