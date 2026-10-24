import { describe, expect, it } from 'vitest';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, type Engine, type EngineResult } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { runScrape, type ScraperConfig } from '../src';

const article = `<article><h1>Hello world</h1>${'<p>Some real content about things that matter. </p>'.repeat(30)}</article>`;
const okHtml = `<html><head><title>T</title></head><body>${article}</body></html>`;

function reply(html: string, over: Partial<EngineResult> = {}): EngineResult {
  return {
    finalUrl: 'https://example.com/final',
    statusCode: 200,
    headers: {},
    body: Buffer.from(html),
    contentType: 'text/html; charset=utf-8',
    truncated: false,
    ...over,
  };
}

function engine(name: string, quality: number, outcome: EngineResult | Error, calls: string[] = []): Engine {
  return {
    name,
    quality,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async () => {
      calls.push(name);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const config: ScraperConfig = { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false };
const run = (engines: Engine[], input: Record<string, unknown> = {}, cfg = config) =>
  runScrape({ engines, config: cfg }, normalizeScrapeRequest({ url: 'https://example.com/start', ...input }));

describe('runScrape', () => {
  it('accepts a good page and records a receipt whose hashes match', async () => {
    const r = await run([engine('a', 10, reply(okHtml))]);
    expect(r.verdict).toBe('ok');
    expect(r.accepted).toBe(true);
    expect(r.engine).toBe('a');
    expect(r.markdown).toContain('Hello world');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.receipt.id).toBe(r.id);
    expect(r.receipt.htmlSha256).toBe(sha256Hex(Buffer.from(okHtml)));
    expect(r.receipt.outputSha256).toBe(sha256Hex(r.markdown));
    expect(r.snapshot.sha256).toBe(r.receipt.htmlSha256);
    expect(r.receipt.engineChain).toHaveLength(1);
    expect(r.finalUrl).toBe('https://example.com/final');
  });

  it('rejects a captcha page (not accepted) and keeps its receipt', async () => {
    const html = '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>';
    const r = await run([engine('a', 10, reply(html))]);
    expect(r.verdict).toBe('captcha');
    expect(r.accepted).toBe(false);
    expect(r.receipt.engineChain[0].verdict).toBe('captcha');
  });

  it('waterfalls to the next engine when the first is blocked', async () => {
    const calls: string[] = [];
    const r = await run([
      engine('first', 20, reply('<html>denied</html>', { statusCode: 403 }), calls),
      engine('second', 5, reply(okHtml), calls),
    ]);
    expect(calls).toEqual(['first', 'second']);
    expect(r.engine).toBe('second');
    expect(r.accepted).toBe(true);
    expect(r.receipt.engineChain.map((a) => a.verdict)).toEqual(['blocked', 'ok']);
  });

  it('continues after a thrown engine error and records it', async () => {
    const r = await run([
      engine('first', 20, new IceCrawlError('TIMEOUT', 'slow')),
      engine('second', 5, reply(okHtml)),
    ]);
    expect(r.receipt.engineChain[0]).toMatchObject({ engine: 'first', verdict: 'error', reasons: ['TIMEOUT'] });
    expect(r.engine).toBe('second');
  });

  it('throws the last error when every engine fails without a response', async () => {
    await expect(run([engine('a', 10, new IceCrawlError('DNS', 'nx'))])).rejects.toMatchObject({ code: 'DNS' });
  });

  it('rethrows fatal errors immediately without trying other engines', async () => {
    const calls: string[] = [];
    await expect(
      run([engine('a', 20, new IceCrawlError('SSRF_BLOCKED', 'no'), calls), engine('b', 5, reply(okHtml), calls)]),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(calls).toEqual(['a']);
  });

  it('throws NO_ENGINE when no engine supports a required feature', async () => {
    await expect(run([engine('a', 10, reply(okHtml))], { actions: [{ type: 'click', selector: '#x' }] })).rejects.toMatchObject({
      code: 'NO_ENGINE',
    });
  });

  it('warns when the chosen engine ignores a soft option', async () => {
    const r = await run([engine('a', 10, reply(okHtml))], { waitFor: 500 });
    expect(r.warnings.join(' ')).toContain('waitFor');
  });

  it('treats uncertain as success unless strict', async () => {
    const html = `<html><body><p>This page has some text.</p><!--${'x'.repeat(60000)}--></body></html>`;
    const lenient = await run([engine('a', 10, reply(html))]);
    expect(lenient.verdict).toBe('uncertain');
    expect(lenient.accepted).toBe(true);
    const strict = await run([engine('a', 10, reply(html))], {}, { ...config, strict: true });
    expect(strict.accepted).toBe(false);
  });

  it('wraps JSON bodies as a fenced markdown block', async () => {
    const r = await run([engine('a', 10, reply('{"hello":"world","n":[1,2,3]}', { contentType: 'application/json' }))]);
    expect(r.markdown).toContain('```json');
    expect(r.accepted).toBe(true);
  });

  it('marks binary content types as error', async () => {
    const r = await run([engine('a', 10, reply('PK..', { contentType: 'application/zip' }))]);
    expect(r.verdict).toBe('error');
    expect(r.reasons[0]).toContain('unsupported_content_type');
  });

  it('marks a truncated body as truncated', async () => {
    const r = await run([engine('a', 10, reply(okHtml, { truncated: true }))]);
    expect(r.verdict).toBe('truncated');
    expect(r.accepted).toBe(false);
  });
});
import type { EngineContext } from '@icecrawl/engines';

describe('runScrape with browser features', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

  function browserEngine(seen: EngineContext[], over: Partial<EngineResult> = {}): Engine {
    return {
      name: 'browser',
      quality: 20,
      features: featureSet(['skipTlsVerification', 'waitFor', 'actions', 'screenshot', 'screenshot@fullScreen', 'mobile']),
      maxReasonableTimeMs: 1000,
      scrape: async (ctx) => {
        seen.push(ctx);
        return {
          ...reply(okHtml),
          screenshot: PNG,
          actions: {
            screenshots: [PNG],
            scrapes: [{ url: 'https://example.com/final', html: '<p>x</p>' }],
            javascriptReturns: [{ type: 'number', value: 42 }],
            pdfs: [],
          },
          ...over,
        };
      },
    };
  }

  it('passes waitFor, mobile, actions and screenshot options to the engine', async () => {
    const seen: EngineContext[] = [];
    await run([browserEngine(seen)], {
      waitFor: 250,
      mobile: true,
      actions: [{ type: 'click', selector: '#go' }],
      formats: ['markdown', { type: 'screenshot', fullPage: true }],
    });
    expect(seen[0]).toMatchObject({
      waitFor: 250,
      mobile: true,
      actions: [{ type: 'click', selector: '#go', all: false }],
      screenshot: { fullPage: true },
    });
  });

  it('passes safe defaults when no browser features are requested', async () => {
    const seen: EngineContext[] = [];
    await run([browserEngine(seen)]);
    expect(seen[0]).toMatchObject({ waitFor: 0, mobile: false, actions: [], screenshot: null });
  });

  it('returns the screenshot and action outputs and hashes the screenshot into the receipt', async () => {
    const r = await run([browserEngine([])], { formats: ['markdown', 'screenshot'] });
    expect(r.screenshot).toEqual(PNG);
    expect(r.actions?.javascriptReturns).toEqual([{ type: 'number', value: 42 }]);
    expect(r.receipt.screenshotSha256).toBe(sha256Hex(PNG));
    expect(r.receipt.contentType).toContain('text/html');
  });

  it('records the conversion options in the receipt so the conversion can be replayed', async () => {
    const r = await run([browserEngine([])], { includeTags: ['article'], excludeTags: ['nav'], removeBase64Images: false });
    expect(r.receipt.options).toEqual({
      onlyMainContent: true,
      skipTlsVerification: true,
      includeTags: ['article'],
      excludeTags: ['nav'],
      removeBase64Images: false,
    });
  });

  it('warns when screenshot quality is requested', async () => {
    const r = await run([browserEngine([])], { formats: [{ type: 'screenshot', quality: 50 }] });
    expect(r.warnings.join(' ')).toContain('quality');
  });

  it('treats ACTION_FAILED as fatal (no waterfall)', async () => {
    const calls: string[] = [];
    const failing = { ...browserEngine([]), scrape: async () => { calls.push('browser'); throw new IceCrawlError('ACTION_FAILED', 'click failed'); } };
    await expect(run([failing, engine('fallback', 5, reply(okHtml), calls)], { actions: [{ type: 'click', selector: '#x' }] })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
    });
    expect(calls).toEqual(['browser']);
  });

  it('reports an unsupported screenshot as a warning when the engine cannot take one', async () => {
    const r = await run([engine('a', 10, reply(okHtml))], { formats: ['markdown', 'screenshot'] });
    expect(r.screenshot).toBeNull();
    expect(r.warnings.join(' ')).toContain('screenshot');
  });
});
