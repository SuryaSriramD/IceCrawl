import { describe, expect, it } from 'vitest';
import { normalizeScrapeRequest } from '@icecrawl/core';
import { buildFeatureFlags } from '../src/flags';

const flags = (input: Record<string, unknown>) =>
  [...buildFeatureFlags(normalizeScrapeRequest({ url: 'https://example.com/page', ...input }).request)].sort();

describe('buildFeatureFlags', () => {
  it('defaults to skipTlsVerification only', () => {
    expect(flags({})).toEqual(['skipTlsVerification']);
  });

  it('adds flags from options', () => {
    expect(flags({ waitFor: 500, mobile: true, actions: [{ type: 'wait', milliseconds: 100 }], proxy: 'enhanced', blockAds: false })).toEqual(
      ['actions', 'disableAdblock', 'mobile', 'skipTlsVerification', 'stealthProxy', 'waitFor'].sort(),
    );
  });

  it('does not add skipTlsVerification when disabled', () => {
    expect(flags({ skipTlsVerification: false })).toEqual([]);
  });

  it('detects pdf and document URLs by path extension', () => {
    expect(flags({ url: 'https://example.com/a.PDF' })).toContain('pdf');
    expect(flags({ url: 'https://example.com/a.docx?x=1' })).toContain('document');
    expect(flags({ url: 'https://example.com/a.html' })).not.toContain('pdf');
  });

  it('detects screenshot formats', () => {
    expect(flags({ formats: ['markdown', { type: 'screenshot' }] })).toContain('screenshot');
    expect(flags({ formats: ['markdown', { type: 'screenshot', fullPage: true }] })).toContain('screenshot@fullScreen');
  });
});
