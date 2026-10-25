import { describe, expect, it } from 'vitest';
import { normalizeSearchRequest } from '../src';

describe('normalizeSearchRequest', () => {
  it('applies Firecrawl defaults', () => {
    const n = normalizeSearchRequest({ query: 'icecrawl' });
    expect(n.request.limit).toBe(10);
    expect(n.request.timeout).toBe(60_000);
    expect(n.sources).toEqual(['web']);
    expect(n.categories).toEqual([]);
    expect(n.scrapeOptions).toBeNull();
    expect(n.warnings).toEqual([]);
  });

  it('accepts sources and categories as strings or objects', () => {
    const n = normalizeSearchRequest({
      query: 'q',
      sources: ['web', { type: 'news' }, 'images'],
      categories: [{ type: 'developer' }, 'pdf'],
    });
    expect(n.sources).toEqual(['web', 'news', 'images']);
    expect(n.categories).toEqual(['developer', 'pdf']);
  });

  it('reports sources and categories IceCrawl does not offer instead of dropping them silently', () => {
    const n = normalizeSearchRequest({ query: 'q', sources: ['web', 'alexandria'], categories: ['gov', 'research'] });
    expect(n.sources).toEqual(['web']);
    expect(n.categories).toEqual(['research']);
    const w = n.warnings.join(' ');
    expect(w).toContain('alexandria');
    expect(w).toContain('gov');
  });

  it('falls back to web when no offered source remains', () => {
    const n = normalizeSearchRequest({ query: 'q', sources: ['alexandria'] });
    expect(n.sources).toEqual(['web']);
    expect(n.warnings.join(' ')).toContain('alexandria');
  });

  it('takes tbs from a web source object when the top-level one is missing', () => {
    expect(normalizeSearchRequest({ query: 'q', sources: [{ type: 'web', tbs: 'qdr:w' }] }).tbs).toBe('qdr:w');
    expect(normalizeSearchRequest({ query: 'q', tbs: 'qdr:d', sources: [{ type: 'web', tbs: 'qdr:w' }] }).tbs).toBe('qdr:d');
  });

  it('lowercases hostnames and rejects URLs or paths in domain lists', () => {
    expect(normalizeSearchRequest({ query: 'q', includeDomains: ['Docs.Example.com'] }).request.includeDomains).toEqual([
      'docs.example.com',
    ]);
    for (const bad of ['https://example.com', 'example.com/path', '-bad.com', '']) {
      expect(() => normalizeSearchRequest({ query: 'q', includeDomains: [bad] })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' }),
      );
    }
  });

  it('refuses includeDomains together with excludeDomains', () => {
    expect(() => normalizeSearchRequest({ query: 'q', includeDomains: ['a.com'], excludeDomains: ['b.com'] })).toThrowError(
      /includeDomains/,
    );
  });

  it('validates query and limit', () => {
    for (const body of [{}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'q', limit: 0 }, { query: 'q', limit: 101 }]) {
      expect(() => normalizeSearchRequest(body)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });

  it('scrapes results only when scrapeOptions asks for formats, and validates them', () => {
    expect(normalizeSearchRequest({ query: 'q', scrapeOptions: {} }).scrapeOptions).toBeNull();
    const n = normalizeSearchRequest({ query: 'q', scrapeOptions: { formats: ['markdown'], onlyMainContent: false } });
    expect(n.scrapeOptions).toEqual({ formats: ['markdown'], onlyMainContent: false });
    expect(() => normalizeSearchRequest({ query: 'q', scrapeOptions: { formats: ['branding'] } })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }),
    );
  });

  it('reports unknown options', () => {
    const n = normalizeSearchRequest({ query: 'q', threatProtection: {}, highlights: true });
    expect(n.warnings.join(' ')).toContain('threatProtection');
  });
});
