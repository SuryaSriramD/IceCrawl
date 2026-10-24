import { describe, expect, it } from 'vitest';
import { IceCrawlError, normalizeScrapeRequest } from '../src';

describe('normalizeScrapeRequest', () => {
  it('applies v2 defaults', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com' });
    expect(n.request.onlyMainContent).toBe(true);
    expect(n.request.waitFor).toBe(0);
    expect(n.request.timeout).toBe(60000);
    expect(n.request.skipTlsVerification).toBe(true);
    expect(n.request.proxy).toBe('auto');
    expect(n.formats).toEqual(['markdown']);
    expect(n.warnings).toEqual([]);
  });

  it('accepts string and object formats and de-duplicates', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      formats: ['markdown', { type: 'links' }, 'markdown'],
    });
    expect(n.formats).toEqual(['markdown', 'links']);
  });

  it('warns about unsupported formats but keeps supported ones', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', formats: ['markdown', 'screenshot'] });
    expect(n.formats).toEqual(['markdown']);
    expect(n.warnings.join(' ')).toContain('screenshot');
  });

  it('rejects a request whose formats are all unsupported', () => {
    expect(() => normalizeScrapeRequest({ url: 'https://example.com', formats: ['screenshot'] })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }),
    );
  });

  it('warns about unknown options', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', someFutureOption: 1 });
    expect(n.warnings.join(' ')).toContain('someFutureOption');
  });

  it('rejects invalid input with VALIDATION', () => {
    expect(() => normalizeScrapeRequest({ url: 'not a url' })).toThrowError(IceCrawlError);
    expect(() => normalizeScrapeRequest({ url: 'https://x.com', timeout: 5 })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeScrapeRequest(null)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
