import { describe, expect, it } from 'vitest';
import { buildScope, decideLink } from '../src';

const scope = (base: string, o: Parameters<typeof buildScope>[1] = {}) => buildScope(base, o);
const follows = (link: string, depth: number, s: ReturnType<typeof scope>) => {
  const d = decideLink(link, depth, s);
  return d.follow ? (d.external ? 'external' : 'yes') : d.reason;
};

describe('decideLink', () => {
  it('follows same-host children of the start path and refuses siblings and parents by default', () => {
    const s = scope('https://example.com/docs/guide');
    expect(follows('https://example.com/docs/guide', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/guide/intro', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/other', 1, s)).toBe('out-of-scope');
    expect(follows('https://example.com/', 1, s)).toBe('out-of-scope');
    expect(follows('https://example.com/docs/guidebook', 1, s)).toBe('out-of-scope');
  });

  it('follows everything on the host when starting at the root or with crawlEntireDomain', () => {
    expect(follows('https://example.com/anything/here', 1, scope('https://example.com/'))).toBe('yes');
    expect(follows('https://example.com/other', 1, scope('https://example.com/docs', { crawlEntireDomain: true }))).toBe('yes');
  });

  it('treats www and the bare domain as the same host', () => {
    expect(follows('https://www.example.com/a', 1, scope('https://example.com/'))).toBe('yes');
  });

  it('handles subdomains and external hosts per the flags', () => {
    const base = 'https://example.com/';
    expect(follows('https://blog.example.com/a', 1, scope(base))).toBe('subdomain');
    expect(follows('https://blog.example.com/a', 1, scope(base, { allowSubdomains: true }))).toBe('yes');
    expect(follows('https://other.org/a', 1, scope(base))).toBe('external');
    expect(follows('https://other.org/a', 1, scope(base, { allowExternalLinks: true }))).toBe('external');
    expect(follows('https://blog.example.com/a', 1, scope(base, { allowExternalLinks: true }))).toBe('external');
  });

  it('skips non-http schemes and static assets', () => {
    const s = scope('https://example.com/');
    expect(follows('mailto:a@b.c', 1, s)).toBe('scheme');
    expect(follows('javascript:void(0)', 1, s)).toBe('scheme');
    expect(follows('https://example.com/logo.png', 1, s)).toBe('asset');
    expect(follows('https://example.com/a.html', 1, s)).toBe('yes');
  });

  it('enforces maxDiscoveryDepth', () => {
    const s = scope('https://example.com/', { maxDiscoveryDepth: 2 });
    expect(follows('https://example.com/a', 2, s)).toBe('yes');
    expect(follows('https://example.com/a', 3, s)).toBe('depth');
  });

  it('applies excludePaths and includePaths to the pathname', () => {
    const s = scope('https://example.com/', { excludePaths: ['^/private'], includePaths: ['^/blog', '^/docs'] });
    expect(follows('https://example.com/blog/post', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/x', 1, s)).toBe('yes');
    expect(follows('https://example.com/about', 1, s)).toBe('not-included');
    expect(follows('https://example.com/private/blog', 1, scope('https://example.com/', { excludePaths: ['^/private'] }))).toBe('excluded');
  });

  it('matches patterns unanchored, like Firecrawl (blog/.* matches /blog/x)', () => {
    const s = scope('https://example.com/', { excludePaths: ['blog/.*'] });
    expect(follows('https://example.com/blog/x', 1, s)).toBe('excluded');
    expect(follows('https://example.com/news', 1, s)).toBe('yes');
  });

  it('can match patterns against the full URL including the query', () => {
    const s = scope('https://example.com/', { excludePaths: ['\\?draft=1'], regexOnFullURL: true });
    expect(follows('https://example.com/a?draft=1', 1, s)).toBe('excluded');
    expect(follows('https://example.com/a?draft=0', 1, s)).toBe('yes');
    const byPath = scope('https://example.com/', { excludePaths: ['\\?draft=1'] });
    expect(follows('https://example.com/a?draft=1', 1, byPath)).toBe('yes');
  });

  it('does not apply the child-path rule to subdomain or external hosts', () => {
    const s = scope('https://example.com/docs', { allowSubdomains: true, allowExternalLinks: true });
    expect(follows('https://blog.example.com/anything', 1, s)).toBe('yes');
    expect(follows('https://other.org/anything', 1, s)).toBe('external');
  });
});
