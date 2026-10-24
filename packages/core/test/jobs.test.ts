import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, normalizeBatchRequest, normalizeCrawlRequest, normalizeMapRequest } from '../src';

describe('normalizeCrawlRequest', () => {
  it('applies Firecrawl v2 defaults', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com' });
    expect(n.request).toMatchObject({
      sitemap: 'include',
      ignoreQueryParameters: false,
      regexOnFullURL: false,
      limit: 10000,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: false,
      ignoreRobotsTxt: false,
      zeroDataRetention: false,
    });
    expect(n.request.maxDiscoveryDepth).toBeUndefined();
    expect(n.scrapeOptions).toEqual({});
    expect(n.warnings).toEqual([]);
  });

  it('keeps scrapeOptions and validates them like /scrape', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { formats: ['markdown', 'html'], onlyMainContent: false } });
    expect(n.scrapeOptions).toEqual({ formats: ['markdown', 'html'], onlyMainContent: false });
    expect(() => normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { timeout: 5 } })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { formats: ['json'] } })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }),
    );
  });

  it('rejects invalid input', () => {
    const bad: unknown[] = [
      null,
      { url: 'nope' },
      { url: 'https://example.com', limit: 0 },
      { url: 'https://example.com', includePaths: ['('] },
      { url: 'https://example.com', sitemap: 'maybe' },
      { url: 'https://example.com', maxConcurrency: 0 },
      { url: 'https://example.com', webhook: { url: 'ftp://example.com/hook' } },
      { url: 'https://example.com', webhook: { url: 'https://example.com/hook', events: ['exploded'] } },
    ];
    for (const input of bad) {
      expect(() => normalizeCrawlRequest(input)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });

  it('warns about prompt, zeroDataRetention and unknown options', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com', prompt: 'only blog posts', zeroDataRetention: true, futureThing: 1 });
    const w = n.warnings.join(' ');
    expect(w).toContain('prompt');
    expect(w).toContain('zeroDataRetention');
    expect(w).toContain('futureThing');
  });

  it('accepts a full webhook definition', () => {
    const n = normalizeCrawlRequest({
      url: 'https://example.com',
      webhook: { url: 'https://hooks.example.com/x', headers: { 'X-A': 'b' }, metadata: { run: 1 }, events: ['page', 'completed'] },
    });
    expect(n.request.webhook).toEqual({ url: 'https://hooks.example.com/x', headers: { 'X-A': 'b' }, metadata: { run: 1 }, events: ['page', 'completed'] });
  });
});

describe('normalizeBatchRequest', () => {
  it('splits scrape options from batch options and removes duplicates', () => {
    const n = normalizeBatchRequest({
      urls: ['https://a.example/', 'https://b.example/', 'https://a.example/'],
      formats: ['markdown', 'links'],
      onlyMainContent: false,
      maxConcurrency: 2,
    });
    expect(n.urls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(n.scrapeOptions).toEqual({ formats: ['markdown', 'links'], onlyMainContent: false });
    expect(n.request.maxConcurrency).toBe(2);
    expect(n.invalidURLs).toEqual([]);
  });

  it('ignores invalid URLs by default and reports them', () => {
    const n = normalizeBatchRequest({ urls: ['https://ok.example/', 'not a url', 'ftp://x.example/'] });
    expect(n.urls).toEqual(['https://ok.example/']);
    expect(n.invalidURLs).toEqual(['not a url', 'ftp://x.example/']);
  });

  it('fails on invalid URLs when ignoreInvalidURLs is false, and when nothing valid remains', () => {
    expect(() => normalizeBatchRequest({ urls: ['https://ok.example/', 'bad'], ignoreInvalidURLs: false })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeBatchRequest({ urls: ['bad'] })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeBatchRequest({ urls: [] })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeBatchRequest({})).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('validates scrape options', () => {
    expect(() => normalizeBatchRequest({ urls: ['https://ok.example/'], timeout: 1 })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});

describe('normalizeMapRequest', () => {
  it('applies defaults', () => {
    const { request, warnings } = normalizeMapRequest({ url: 'https://example.com' });
    expect(request).toMatchObject({ sitemap: 'include', includeSubdomains: true, ignoreQueryParameters: true, ignoreCache: false, limit: 5000 });
    expect(warnings).toEqual([]);
  });

  it('enforces limits and warns about unknown options', () => {
    expect(() => normalizeMapRequest({ url: 'https://example.com', limit: 100001 })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeMapRequest({ url: 'nope' })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(normalizeMapRequest({ url: 'https://example.com', location: { country: 'DE' } }).warnings.join(' ')).toContain('location');
  });
});

describe('error codes', () => {
  it('has a 409 CONFLICT', () => expect(ERROR_STATUS.CONFLICT).toBe(409));
});
