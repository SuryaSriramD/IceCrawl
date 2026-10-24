import { describe, expect, it } from 'vitest';
import { convertHtml } from '../src/convert';

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
});
