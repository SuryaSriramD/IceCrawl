import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { UNLIMITED } from '../src/routes/team';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';
import { extractionDeps, fakeLlm } from './llm-helpers';

const E = 'https://example.com';
const site = { [`${E}/`]: { html: pageHtml('Home', ['/a']) }, [`${E}/a`]: { html: pageHtml('A') } };
const files = { [`${E}/robots.txt`]: { status: 404, body: '' } };
type T = Awaited<ReturnType<typeof makeJobsApp>>;

const setup = () =>
  makeJobsApp({ site, files, team: { workerConcurrency: 8 }, extraction: extractionDeps(fakeLlm(JSON.stringify({ fact: 'Real readable sentence about a real topic' }))) });
const get = async (t: T, url: string, headers: Record<string, string> = t.auth) => {
  const res = await t.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() };
};
const scrape = (t: T, path = '/a') => t.app.inject({ method: 'POST', url: '/v2/scrape', headers: t.auth, payload: { url: `${E}${path}` } });

describe('/v2/team', () => {
  it('needs the API key', async () => {
    const t = await setup();
    for (const url of ['credit-usage', 'token-usage', 'queue-status', 'activity', 'credit-usage/historical', 'token-usage/historical']) {
      expect((await t.app.inject({ method: 'GET', url: `/v2/team/${url}` })).statusCode, url).toBe(401);
    }
  });

  it('reports metered credits with an unlimited balance and the current month as the period', async () => {
    const t = await setup();
    await scrape(t);
    await scrape(t, '/');
    const { status, body } = await get(t, '/v2/team/credit-usage');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ remainingCredits: UNLIMITED, planCredits: UNLIMITED, usedCredits: 2 });
    const start = Date.parse(body.data.billingPeriodStart);
    const end = Date.parse(body.data.billingPeriodEnd);
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(end).toBeGreaterThan(Date.now());
    expect(new Date(start).getUTCDate()).toBe(1);
  });

  it('keeps usage per API key', async () => {
    const t = await setup();
    await scrape(t);
    await t.store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'other' });
    const other = await get(t, '/v2/team/credit-usage', { authorization: 'Bearer ic-other' });
    expect(other.body.data.usedCredits).toBe(0);
  });

  it('reports the tokens that extract jobs used', async () => {
    const t = await setup();
    const started = await t.app.inject({ method: 'POST', url: '/v2/extract', headers: t.auth, payload: { urls: [`${E}/a`], prompt: 'Find a fact' } });
    expect(started.statusCode).toBe(200);
    await drain(t.deps, t.queues);
    const { body } = await get(t, '/v2/team/token-usage');
    expect(body.data).toMatchObject({ remainingTokens: UNLIMITED, planTokens: UNLIMITED, usedTokens: 110 });
  });

  it('lists twelve months of history, oldest first, with this month last', async () => {
    const t = await setup();
    await scrape(t);
    const credits = (await get(t, '/v2/team/credit-usage/historical')).body;
    expect(credits.periods).toHaveLength(12);
    expect(credits.periods[11]).toMatchObject({ totalCredits: 1, apiKey: null });
    expect(credits.periods[0].totalCredits).toBe(0);
    expect(Date.parse(credits.periods[0].startDate)).toBeLessThan(Date.parse(credits.periods[11].startDate));
    const withKey = (await get(t, '/v2/team/token-usage/historical?byApiKey=true')).body;
    expect(withKey.periods).toHaveLength(12);
    expect(withKey.periods[11]).toMatchObject({ totalTokens: 0 });
    expect(withKey.periods[11].apiKey).toBeTypeOf('string');
  });

  it('reports the queue: running jobs, concurrency and the latest success', async () => {
    const t = await setup();
    expect((await get(t, '/v2/team/queue-status')).body).toMatchObject({
      success: true,
      jobsInQueue: 0,
      activeJobsInQueue: 0,
      waitingJobsInQueue: 0,
      maxConcurrency: 8,
      mostRecentSuccess: null,
    });
    await t.app.inject({ method: 'POST', url: '/v2/crawl', headers: t.auth, payload: { url: `${E}/`, sitemap: 'skip' } });
    await scrape(t);
    const q = (await get(t, '/v2/team/queue-status')).body;
    expect(q.jobsInQueue).toBe(1);
    expect(q.activeJobsInQueue).toBe(1);
    expect(Date.now() - Date.parse(q.mostRecentSuccess)).toBeLessThan(60_000);
  });

  it('lists activity newest first, with a cursor and an endpoint filter', async () => {
    const t = await setup();
    await scrape(t, '/a');
    await new Promise((r) => setTimeout(r, 5));
    await scrape(t, '/');
    await t.app.inject({ method: 'POST', url: '/v2/crawl', headers: t.auth, payload: { url: `${E}/`, sitemap: 'skip', limit: 1 } });
    await drain(t.deps, t.queues);

    const all = (await get(t, '/v2/team/activity?limit=10')).body;
    expect(all.has_more).toBe(false);
    expect(all.cursor).toBeNull();
    expect(all.data.map((r: { endpoint: string }) => r.endpoint).sort()).toEqual(['crawl', 'scrape', 'scrape']);
    expect(all.data[0]).toMatchObject({ api_version: 'v2' });
    expect(typeof all.data[0].target).toBe('string');

    const first = (await get(t, '/v2/team/activity?limit=1')).body;
    expect(first.data).toHaveLength(1);
    expect(first.has_more).toBe(true);
    const next = (await get(t, `/v2/team/activity?limit=10&cursor=${encodeURIComponent(first.cursor)}`)).body;
    expect(next.data).toHaveLength(2);
    expect(next.data.map((r: { id: string }) => r.id)).not.toContain(first.data[0].id);

    const crawl = (await get(t, '/v2/team/activity?endpoint=crawl')).body;
    expect(crawl.data).toHaveLength(1);
    expect(crawl.data[0].endpoint).toBe('crawl');
  });

  it('rejects a cursor that is not a timestamp', async () => {
    const t = await setup();
    const { status, body } = await get(t, '/v2/team/activity?cursor=nonsense');
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION');
  });
});
