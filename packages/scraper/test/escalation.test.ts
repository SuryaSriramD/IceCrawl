import { describe, expect, it } from 'vitest';
import { normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, ProxyPool, type Engine, type EngineContext } from '@icecrawl/engines';
import { HostThrottle, runScrape } from '../src';

const article = `<article><h1>Real page</h1>${'<p>Plenty of real readable words about a real topic. </p>'.repeat(20)}</article>`;
const ok = `<html><head><title>R</title></head><body>${article}</body></html>`;
const walled = '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>';

/** Serves the wall to direct requests and to the listed proxies, the real page to the others. */
function engine(calls: EngineContext[], opts: { wallProxies?: string[]; status?: number } = {}): Engine {
  return {
    name: 'e',
    quality: 5,
    features: featureSet(['skipTlsVerification', 'stealthProxy']),
    maxReasonableTimeMs: 1000,
    scrape: async (ctx) => {
      calls.push(ctx);
      const walledNow = !ctx.proxy || (opts.wallProxies ?? []).includes(ctx.proxy);
      return { finalUrl: ctx.url, statusCode: walledNow ? (opts.status ?? 200) : 200, headers: {}, body: Buffer.from(walledNow ? walled : ok), contentType: 'text/html', truncated: false };
    },
  };
}

const cfg = { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false };
const run = (e: Engine, proxy: string, pool: ProxyPool | null, extra: Record<string, unknown> = {}) =>
  runScrape({ engines: [e], config: { ...cfg, proxies: pool, ...extra } }, normalizeScrapeRequest({ url: 'https://example.com/', proxy }));

describe('proxy tiers', () => {
  it('auto stays direct when the page is fine', async () => {
    const calls: EngineContext[] = [];
    const e: Engine = { ...engine(calls), scrape: async (ctx) => (calls.push(ctx), { finalUrl: ctx.url, statusCode: 200, headers: {}, body: Buffer.from(ok), contentType: 'text/html', truncated: false }) };
    const r = await run(e, 'auto', new ProxyPool({ enhanced: ['http://e1:1'] }));
    expect(r.verdict).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].proxy).toBeUndefined();
  });

  it('auto escalates a captcha wall to the enhanced tier and records the tier in the receipt', async () => {
    const calls: EngineContext[] = [];
    const r = await run(engine(calls), 'auto', new ProxyPool({ enhanced: ['http://e1:1'], stealth: ['http://s1:1'] }));
    expect(r.verdict).toBe('ok');
    expect(calls.map((c) => c.proxy)).toEqual([undefined, 'http://e1:1']);
    expect(calls[1].stealth).toBe(true);
    expect(r.receipt.engineChain.map((a) => [a.verdict, a.proxyTier])).toEqual([['captcha', undefined], ['ok', 'enhanced']]);
    expect(r.warnings.join(' ')).toContain('Escalated to the enhanced proxy tier after a captcha response');
    expect(JSON.stringify(r.receipt)).not.toContain('e1:1');
  });

  it('auto goes on to stealth when enhanced is walled too, and reports blocked honestly when everything is', async () => {
    const calls: EngineContext[] = [];
    const pool = new ProxyPool({ enhanced: ['http://e1:1'], stealth: ['http://s1:1'] });
    const r = await run(engine(calls, { wallProxies: ['http://e1:1'] }), 'auto', pool);
    expect(calls.map((c) => c.proxy)).toEqual([undefined, 'http://e1:1', 'http://s1:1']);
    expect(r.verdict).toBe('ok');

    const all: EngineContext[] = [];
    const blocked = await run(engine(all, { wallProxies: ['http://e1:1', 'http://s1:1'] }), 'auto', pool);
    expect(blocked.verdict).toBe('captcha');
    expect(blocked.accepted).toBe(false);
  });

  it('does not escalate other failures such as an empty page', async () => {
    const calls: EngineContext[] = [];
    const e: Engine = { ...engine(calls), scrape: async (ctx) => (calls.push(ctx), { finalUrl: ctx.url, statusCode: 200, headers: {}, body: Buffer.from('<html><body></body></html>'), contentType: 'text/html', truncated: false }) };
    const r = await run(e, 'auto', new ProxyPool({ enhanced: ['http://e1:1'] }));
    expect(r.verdict).toBe('empty');
    expect(calls).toHaveLength(1);
  });

  it('basic never uses the pool, and an explicit tier needs a configured pool', async () => {
    const calls: EngineContext[] = [];
    await run(engine(calls), 'basic', new ProxyPool({ enhanced: ['http://e1:1'] }));
    expect(calls.every((c) => !c.proxy)).toBe(true);
    await expect(run(engine([]), 'stealth', new ProxyPool({ enhanced: ['http://e1:1'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
    await expect(run(engine([]), 'enhanced', null)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
  });

  it('marks a proxy that failed so the pool rotates away from it', async () => {
    const pool = new ProxyPool({ enhanced: ['http://bad:1', 'http://good:1'] });
    const e: Engine = {
      ...engine([]),
      scrape: async (ctx) => {
        if (ctx.proxy === 'http://bad:1') throw new Error('connection refused');
        return { finalUrl: ctx.url, statusCode: 200, headers: {}, body: Buffer.from(ok), contentType: 'text/html', truncated: false };
      },
    };
    await expect(run(e, 'enhanced', pool)).rejects.toMatchObject({ code: 'TARGET_ERROR' });
    expect((await run(e, 'enhanced', pool)).verdict).toBe('ok');
  });

  it('paces requests to one host through a pool proxy only', async () => {
    const waits: string[] = [];
    const throttle = { wait: async (h: string) => void waits.push(h) } as unknown as HostThrottle;
    const calls: EngineContext[] = [];
    await run(engine(calls), 'auto', new ProxyPool({ enhanced: ['http://e1:1'] }), { throttle });
    expect(waits).toEqual(['example.com']);
  });
});

describe('HostThrottle', () => {
  it('spaces calls for the same host and leaves other hosts alone', async () => {
    let now = 0;
    const slept: number[] = [];
    const t = new HostThrottle(1000, () => now, async (ms) => void slept.push(ms));
    await t.wait('a.com');
    await t.wait('a.com');
    await t.wait('a.com');
    await t.wait('b.com');
    expect(slept).toEqual([1000, 2000]);
    now = 10_000;
    await t.wait('a.com');
    expect(slept).toEqual([1000, 2000]);
    await new HostThrottle(0).wait('a.com');
  });
});
