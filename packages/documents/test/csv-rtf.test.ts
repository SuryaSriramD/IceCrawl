import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DocumentError, convertDocument, csvToHtml, parseCsv, rtfToHtml, sniffDelimiter } from '../src';

const bytes = (s: string) => new TextEncoder().encode(s);
const limits = DEFAULT_LIMITS;

describe('csv', () => {
  it('parses quoted fields with delimiters, quotes and line breaks', () => {
    const { rows } = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n', ',', 100);
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
  });

  it('skips blank lines, keeps a last row without a trailing newline and empty cells', () => {
    expect(parseCsv('a,b\n\n1,\n2,3', ',', 100).rows).toEqual([['a', 'b'], ['1', ''], ['2', '3']]);
  });

  it('sniffs semicolon, tab and pipe delimiters, and ignores delimiters inside quotes', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|');
    expect(sniffDelimiter('"a,b";c\n"1,2";3')).toBe(';');
    expect(sniffDelimiter('single column')).toBe(',');
  });

  it('turns the first row into a header and escapes HTML', () => {
    const { html, title, warnings } = csvToHtml(bytes('name,note\n<b>x</b>,"a & b"\n'), limits);
    expect(html).toContain('<thead><tr><th>name</th><th>note</th></tr></thead>');
    expect(html).toContain('<td>&lt;b&gt;x&lt;/b&gt;</td><td>a &amp; b</td>');
    expect(title).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('strips a byte order mark and reads UTF-16', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('x,y\n1,2')]);
    expect(csvToHtml(bom, limits).html).toContain('<th>x</th>');
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('x,y\n1,2', 'utf16le')]);
    expect(csvToHtml(utf16, limits).html).toContain('<th>y</th>');
  });

  it('stops at maxRows and says so', () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i},v`).join('\n');
    const r = csvToHtml(bytes(text), { ...limits, maxRows: 10 });
    expect(r.html.match(/<tr>/g)).toHaveLength(10);
    expect(r.warnings[0]).toContain('first 10 rows');
  });

  it('refuses empty and oversized files without quoting them', () => {
    expect(() => csvToHtml(bytes('  \n'), limits)).toThrowError(expect.objectContaining({ code: 'UNREADABLE' }));
    expect(() => csvToHtml(bytes('a,b'), { ...limits, maxBytes: 2 })).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
});

describe('rtf', () => {
  const rtf = (body: string) => bytes(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}${body}}`);

  it('keeps text, paragraph and line breaks and skips font and colour tables', () => {
    const { html } = rtfToHtml(rtf('\\f0\\fs24 Hello \\b world\\b0.\\par Second paragraph\\line next line\\par'), limits);
    expect(html).toContain('<p>Hello world.</p>');
    expect(html).toContain('<p>Second paragraph<br>next line</p>');
    expect(html).not.toContain('Arial');
  });

  it('decodes escapes: hex bytes, unicode with fallback, symbols and literals', () => {
    const { html } = rtfToHtml(rtf("caf\\'e9 \\u8364? \\u-10179?\\u-8704? \\emdash \\{braces\\} \\\\ done\\par"), limits);
    expect(html).toContain('café');
    expect(html).toContain('€');
    expect(html).toContain('—');
    expect(html).toContain('{braces}');
    expect(html).toContain('\\');
    expect(html).not.toContain('?');
  });

  it('skips ignorable destinations and headers', () => {
    const { html } = rtfToHtml(rtf('{\\*\\generator Word 1.0;}{\\header Page header}Body text\\par{\\footnote A note}'), limits);
    expect(html).toContain('Body text');
    expect(html).not.toContain('Word 1.0');
    expect(html).not.toContain('Page header');
    expect(html).not.toContain('A note');
  });

  it('refuses files that are not RTF, have no text or nest absurdly deep', () => {
    expect(() => rtfToHtml(bytes('just text'), limits)).toThrowError(expect.objectContaining({ code: 'UNREADABLE' }));
    expect(() => rtfToHtml(rtf(''), limits)).toThrowError(expect.objectContaining({ code: 'UNREADABLE' }));
    expect(() => rtfToHtml(bytes(`{\\rtf1${'{'.repeat(500)}x${'}'.repeat(500)}}`), limits)).toThrowError(/nested too deeply/);
  });

  it('escapes HTML in the text', () => {
    expect(rtfToHtml(rtf('1 < 2 & <b>\\par'), limits).html).toContain('1 &lt; 2 &amp; &lt;b&gt;');
  });
});

describe('convertDocument', () => {
  it('dispatches by kind, rejects oversized input first and reports kinds it cannot convert yet', async () => {
    expect((await convertDocument(bytes('a,b\n1,2'), 'csv')).html).toContain('<table>');
    await expect(convertDocument(bytes('abcdef'), 'csv', { maxBytes: 3 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(convertDocument(bytes('x'), 'pdf')).rejects.toBeInstanceOf(DocumentError);
  });
});
