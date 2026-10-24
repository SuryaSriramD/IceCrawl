import { describe, expect, it } from 'vitest';
import { hostRelation, isAssetPath, normalizeUrl } from '../src';

const keep = { ignoreQueryParameters: false };
const drop = { ignoreQueryParameters: true };

describe('normalizeUrl', () => {
  it('lowercases the host, drops the fragment, default port and credentials', () => {
    expect(normalizeUrl('HTTPS://User:pw@Example.COM:443/a#frag', keep)).toBe('https://example.com/a');
  });

  it('removes trailing slashes except on the root', () => {
    expect(normalizeUrl('https://example.com/a/', keep)).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a//', keep)).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com', keep)).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/', keep)).toBe('https://example.com/');
  });

  it('sorts query parameters, or drops them when asked', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1', keep)).toBe('https://example.com/a?a=1&b=2');
    expect(normalizeUrl('https://example.com/a?b=2&a=1', drop)).toBe('https://example.com/a');
  });

  it('rejects non-http schemes and garbage', () => {
    for (const bad of ['mailto:a@b.c', 'javascript:void(0)', 'ftp://x.example/', 'not a url', '']) {
      expect(normalizeUrl(bad, keep)).toBeNull();
    }
  });

  it('treats equivalent URLs as the same string', () => {
    const a = normalizeUrl('https://Example.com/x/?b=1&a=2#top', keep);
    const b = normalizeUrl('https://example.com:443/x?a=2&b=1', keep);
    expect(a).toBe(b);
  });
});

describe('hostRelation', () => {
  it.each([
    ['example.com', 'example.com', 'same'],
    ['www.example.com', 'example.com', 'same'],
    ['example.com', 'www.example.com', 'same'],
    ['blog.example.com', 'example.com', 'subdomain'],
    ['example.com', 'blog.example.com', 'subdomain'],
    ['a.example.com', 'b.example.com', 'subdomain'],
    ['example.org', 'example.com', 'external'],
    ['evilexample.com', 'example.com', 'external'],
    ['alice.github.io', 'bob.github.io', 'external'],
    ['example.co.uk', 'shop.example.co.uk', 'subdomain'],
    ['10.0.0.1', '10.0.0.2', 'external'],
    ['localhost', 'localhost', 'same'],
  ] as const)('%s vs %s is %s', (a, b, expected) => expect(hostRelation(a, b)).toBe(expected));
});

describe('isAssetPath', () => {
  it.each(['/a.png', '/a.JPG', '/x/app.js', '/s.css', '/f.woff2', '/v.mp4', '/z.zip', '/favicon.ico'])('%s is an asset', (p) =>
    expect(isAssetPath(p)).toBe(true),
  );
  it.each(['/', '/a', '/a.html', '/docs/png-guide', '/a.pdf', '/file.txt'])('%s is not an asset', (p) => expect(isAssetPath(p)).toBe(false));
});
