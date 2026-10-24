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
    const n = normalizeScrapeRequest({ url: 'https://example.com', formats: ['markdown', 'json'] });
    expect(n.formats).toEqual(['markdown']);
    expect(n.warnings.join(' ')).toContain('json');
  });

  it('rejects a request whose formats are all unsupported', () => {
    expect(() => normalizeScrapeRequest({ url: 'https://example.com', formats: ['json'] })).toThrowError(
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
  it('accepts the screenshot format as a string with defaults', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', formats: ['markdown', 'screenshot'] });
    expect(n.formats).toEqual(['markdown', 'screenshot']);
    expect(n.screenshot).toEqual({ fullPage: false, quality: undefined, viewport: undefined });
  });

  it('parses screenshot format options and warns that quality is ignored', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      formats: [{ type: 'screenshot', fullPage: true, quality: 80, viewport: { width: 800, height: 600 } }],
    });
    expect(n.screenshot).toEqual({ fullPage: true, quality: 80, viewport: { width: 800, height: 600 } });
    expect(n.warnings.join(' ')).toContain('quality');
  });

  it('returns null screenshot options when no screenshot was requested', () => {
    expect(normalizeScrapeRequest({ url: 'https://example.com' }).screenshot).toBeNull();
  });

  it('rejects bad screenshot options', () => {
    for (const bad of [{ type: 'screenshot', quality: 0 }, { type: 'screenshot', viewport: { width: 10, height: 600 } }]) {
      expect(() => normalizeScrapeRequest({ url: 'https://example.com', formats: [bad] })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' }),
      );
    }
  });

  it('parses every action type and applies defaults', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      actions: [
        { type: 'wait', milliseconds: 100 },
        { type: 'wait', selector: '#a' },
        { type: 'click', selector: '#b' },
        { type: 'write', text: 'hi' },
        { type: 'press', key: 'Enter' },
        { type: 'scroll' },
        { type: 'screenshot' },
        { type: 'scrape' },
        { type: 'executeJavascript', script: '1+1' },
        { type: 'pdf' },
      ],
    });
    const a = n.request.actions!;
    expect(a).toHaveLength(10);
    expect(a[2]).toEqual({ type: 'click', selector: '#b', all: false });
    expect(a[5]).toEqual({ type: 'scroll', direction: 'down' });
    expect(a[6]).toEqual({ type: 'screenshot', fullPage: false });
    expect(a[9]).toEqual({ type: 'pdf', format: 'Letter', landscape: false, scale: 1 });
  });

  it('rejects malformed actions', () => {
    const bad: unknown[] = [
      { type: 'wait' },
      { type: 'wait', milliseconds: 5, selector: '#a' },
      { type: 'click' },
      { type: 'teleport' },
    ];
    for (const action of bad) {
      expect(() => normalizeScrapeRequest({ url: 'https://example.com', actions: [action] })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' }),
      );
    }
    const many = Array.from({ length: 51 }, () => ({ type: 'scrape' }));
    expect(() => normalizeScrapeRequest({ url: 'https://example.com', actions: many })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});
