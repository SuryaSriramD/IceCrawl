import { describe, expect, it } from 'vitest';
import { CONVERTER, convertHtml } from '../src/convert';

const article = `<article><h1>The Big Story</h1>${'<p>This paragraph contains real reporting about an important subject. </p>'.repeat(12)}</article>`;
const page = `<!doctype html><html lang="en"><head>
<title>Example Title</title><meta name="description" content="An example page.">
<script>var secret = 1;</script><style>.x{}</style></head>
<body><nav><a href="/about">About us navigation</a></nav>${article}
<footer><a href="https://other.example/x">Elsewhere</a> <a href="/about">About again</a> <a href="javascript:void(0)">js</a> <a href="mailto:a@b.c">mail</a></footer></body></html>`;

const opts = { url: 'https://example.com/post/1', onlyMainContent: true, removeBase64Images: true };

describe('convertHtml', () => {
  it('extracts metadata', () => {
    const c = convertHtml(page, opts);
    expect(c.title).toBe('Example Title');
    expect(c.description).toBe('An example page.');
    expect(c.language).toBe('en');
  });

  it('keeps main content and drops navigation, scripts and styles when onlyMainContent', () => {
    const c = convertHtml(page, opts);
    expect(c.markdown).toContain('# The Big Story');
    expect(c.markdown).toContain('important subject');
    expect(c.markdown).not.toContain('navigation');
    expect(c.markdown).not.toContain('secret');
  });

  it('keeps navigation when onlyMainContent is false but still drops scripts', () => {
    const c = convertHtml(page, { ...opts, onlyMainContent: false });
    expect(c.markdown).toContain('About us navigation');
    expect(c.markdown).not.toContain('secret');
  });

  it('collects absolute, de-duplicated http(s) links from the whole page', () => {
    const c = convertHtml(page, opts);
    expect(c.links).toEqual(['https://example.com/about', 'https://other.example/x']);
  });

  it('applies excludeTags', () => {
    const c = convertHtml(page, { ...opts, onlyMainContent: false, excludeTags: ['nav'] });
    expect(c.markdown).not.toContain('About us navigation');
  });

  it('applies includeTags exclusively', () => {
    const c = convertHtml(page, { ...opts, includeTags: ['h1'] });
    expect(c.markdown.trim()).toBe('# The Big Story');
  });

  it('falls back to the whole body for short pages', () => {
    const c = convertHtml('<html><body><nav>Menu</nav><p>Tiny page text.</p></body></html>', opts);
    expect(c.markdown).toContain('Tiny page text.');
  });

  it('strips base64 images when asked', () => {
    const html = `<html><body><p>${'text '.repeat(60)}</p><img src="data:image/png;base64,AAAA" alt="x"></body></html>`;
    expect(convertHtml(html, { ...opts, onlyMainContent: false }).markdown).not.toContain('data:image');
  });

  it('does not throw on empty or garbage input', () => {
    expect(() => convertHtml('', opts)).not.toThrow();
    expect(() => convertHtml('<<<not html>>>', opts)).not.toThrow();
  });
  it('keeps the page heading even when it duplicates the title (example.com shape)', () => {
    const html = '<!doctype html><html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href="https://iana.org/domains/example">More information...</a></p></div></body></html>';
    const c = convertHtml(html, opts);
    expect(c.markdown).toContain('# Example Domain');
    expect(c.markdown).toContain('illustrative examples');
  });
});

describe('convertHtml: the page heading under onlyMainContent', () => {
  const body = '<p>This paragraph contains real reporting about an important subject. </p>'.repeat(12);
  const withTitle = (title: string, inner: string) => `<!doctype html><html><head><title>${title}</title></head><body>${inner}</body></html>`;
  const o = { url: 'https://example.com/x', onlyMainContent: true, removeBase64Images: true };

  it('keeps the page h1 as an h1 instead of letting Readability turn it into an h2', () => {
    const c = convertHtml(withTitle('Example Title', `<nav><a href="/">Home</a></nav><article><h1>The Big Story</h1>${body}</article>`), o);
    expect(c.markdown.startsWith('# The Big Story\n')).toBe(true);
  });

  it('puts back an h1 that repeats the page title', () => {
    for (const title of ['The Big Story', 'The Big Story | Daily News']) {
      const c = convertHtml(withTitle(title, `<nav><a href="/">Home</a></nav><article><h1>The Big Story</h1>${body}</article>`), o);
      expect(c.markdown.startsWith('# The Big Story\n'), title).toBe(true);
    }
  });

  it('does not turn a site-name heading outside the content into the page heading', () => {
    const c = convertHtml(withTitle('A story - Daily News', `<header><h1>Daily News</h1></header><article><h2>A story</h2>${body}</article>`), o);
    expect(c.markdown).not.toContain('# Daily News');
  });

  it('leaves everything else alone without onlyMainContent', () => {
    const html = withTitle('The Big Story', `<article><h1>The Big Story</h1>${body}</article>`);
    expect(convertHtml(html, { ...o, onlyMainContent: false }).markdown.startsWith('# The Big Story\n')).toBe(true);
  });

  it('escapes the heading it restores', () => {
    const c = convertHtml(withTitle('Fish & Chips <b>', `<article><h1>Fish &amp; Chips &lt;b&gt;</h1>${body}</article>`), o);
    expect(c.markdown.startsWith('# Fish & Chips <b>')).toBe(true);
    expect(c.cleanHtml).not.toContain('<b>');
  });

  it('is version 3 of the converter, so receipts made before this change report their replay as skipped', () => {
    expect(CONVERTER).toEqual({ name: 'icecrawl-convert', version: '3' });
  });
});
