import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { MemoryRateLimiter } from '../src/ratelimit';
import { makeJobsApp, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const site = { [`${E}/a`]: { html: pageHtml('A') } };
type T = Awaited<ReturnType<typeof makeJobsApp>>;
const scrape = (t: T, headers: Record<string, string> = t.auth) =>
  t.app.inject({ method: 'POST', url: '/v2/scrape', headers, payload: { url: `${E}/a` } });

describe('rate limiting', () => {
  it('is off unless a limiter is configured', async () => {
    const t = await makeJobsApp({ site });
    for (let i = 0; i < 5; i++) expect((await scrape(t)).statusCode).toBe(200);
    expect((await scrape(t)).headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('answers 429 RATE_LIMITED with Retry-After once the limit is used up, and says how much is left before', async () => {
    const t = await makeJobsApp({ site, rateLimiter: new MemoryRateLimiter(2, 60_000) });
    const first = await scrape(t);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect((await scrape(t)).headers['x-ratelimit-remaining']).toBe('0');
    const refused = await scrape(t);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('counts per API key, and does not count reads', async () => {
    const t = await makeJobsApp({ site, rateLimiter: new MemoryRateLimiter(1, 60_000) });
    await t.store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'other' });
    expect((await scrape(t)).statusCode).toBe(200);
    expect((await scrape(t)).statusCode).toBe(429);
    expect((await scrape(t, { authorization: 'Bearer ic-other' })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/v2/crawl/active', headers: t.auth })).statusCode).toBe(200);
    }
  });

  it('does not let unauthenticated requests use up a key\'s allowance', async () => {
    const t = await makeJobsApp({ site, rateLimiter: new MemoryRateLimiter(1, 60_000) });
    expect((await t.app.inject({ method: 'POST', url: '/v2/scrape', payload: { url: `${E}/a` } })).statusCode).toBe(401);
    expect((await scrape(t)).statusCode).toBe(200);
  });
});
