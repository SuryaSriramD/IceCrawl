import { describe, expect, it } from 'vitest';
import { isUrlPattern, normalizeExtractRequest, patternPrefix } from '../src';

const schema = { type: 'object', properties: { name: { type: 'string' } } };

describe('normalizeExtractRequest', () => {
  it('needs a prompt, a schema or both', () => {
    expect(() => normalizeExtractRequest({ urls: ['https://a.com/x'] })).toThrowError(/prompt, a schema/);
    expect(normalizeExtractRequest({ urls: ['https://a.com/x'], prompt: 'p' }).request.prompt).toBe('p');
    expect(normalizeExtractRequest({ urls: ['https://a.com/x'], schema }).request.schema).toEqual(schema);
  });

  it('applies Firecrawl defaults', () => {
    const n = normalizeExtractRequest({ urls: ['https://a.com/x'], prompt: 'p' });
    expect(n.request).toMatchObject({ enableWebSearch: false, ignoreSitemap: false, includeSubdomains: true, showSources: false, ignoreInvalidURLs: true });
    expect(n.warnings).toEqual([]);
  });

  it('splits valid and invalid URLs, de-duplicates, and keeps patterns', () => {
    const n = normalizeExtractRequest({
      urls: ['https://a.com/x', 'https://a.com/x', 'nope', 'ftp://a.com/f', 'https://a.com/blog/*'],
      prompt: 'p',
    });
    expect(n.urls).toEqual(['https://a.com/x', 'https://a.com/blog/*']);
    expect(n.invalidURLs).toEqual(['nope', 'ftp://a.com/f']);
  });

  it('only allows a trailing * as a pattern', () => {
    const n = normalizeExtractRequest({ urls: ['https://a.com/ok', 'https://*.a.com/x', 'https://a.com/*/x'], prompt: 'p' });
    expect(n.urls).toEqual(['https://a.com/ok']);
    expect(n.invalidURLs).toEqual(['https://*.a.com/x', 'https://a.com/*/x']);
    expect(isUrlPattern('https://a.com/blog/*')).toBe(true);
    expect(isUrlPattern('https://a.com/blog')).toBe(false);
    expect(patternPrefix('https://a.com/blog/*')).toBe('https://a.com/blog/');
  });

  it('rejects invalid URLs when ignoreInvalidURLs is false, and requests without any valid URL', () => {
    expect(() => normalizeExtractRequest({ urls: ['https://a.com/x', 'nope'], prompt: 'p', ignoreInvalidURLs: false })).toThrowError(/nope/);
    expect(() => normalizeExtractRequest({ urls: ['nope'], prompt: 'p' })).toThrowError(/No valid URLs/);
    expect(normalizeExtractRequest({ urls: ['https://a.com/x', 'nope'], prompt: 'p' }).invalidURLs).toEqual(['nope']);
  });

  it('limits the number of URLs and the schema size', () => {
    const many = Array.from({ length: 101 }, (_, i) => `https://a.com/${i}`);
    expect(() => normalizeExtractRequest({ urls: many, prompt: 'p' })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    const huge = { type: 'object', description: 'x'.repeat(60_000) };
    expect(() => normalizeExtractRequest({ urls: ['https://a.com/x'], schema: huge })).toThrowError(/50000/);
  });

  it('always reads markdown and says so when scrapeOptions.formats differs', () => {
    const n = normalizeExtractRequest({
      urls: ['https://a.com/x'],
      prompt: 'p',
      scrapeOptions: { formats: ['html'], onlyMainContent: false, waitFor: 500 },
    });
    expect(n.scrapeOptions).toEqual({ onlyMainContent: false, waitFor: 500 });
    expect(n.warnings.join(' ')).toContain('markdown');
  });

  it('reports unknown options', () => {
    const n = normalizeExtractRequest({ urls: ['https://a.com/x'], prompt: 'p', agent: { model: 'x' } });
    expect(n.warnings.join(' ')).toContain('agent');
  });
});
