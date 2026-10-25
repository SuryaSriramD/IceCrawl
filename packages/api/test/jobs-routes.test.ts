import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const robots = { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private/\n' } };
const site = {
  [`${E}/`]: { html: pageHtml('Home', ['/a', '/b', '/private/x', '/missing']) },
  [`${E}/a`]: { html: pageHtml('A') },
  [`${E}/b`]: { html: pageHtml('B') },
  [`${E}/private/x`]: { html: pageHtml('Private') },
};

const post = (t: Awaited<ReturnType<typeof makeJobsApp>>, url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: t.auth, payload: payload as never });
const get = (t: Awaited<ReturnType<typeof makeJobsApp>>, url: string, headers = t.auth) => t.app.inject({ method: 'GET', url, headers });

describe('POST /v2/crawl', () => {
  it('creates a job, returns its status URL, and queues the discovery', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const res = await post(t, '/v2/crawl', { url: `${E}/`, limit: 5 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toBe(`http://localhost:80/v2/crawl/${body.id}`);
    expect(body.warning).toBeUndefined();
    expect(t.queues.jobs).toEqual([{ kind: 'discover', jobId: body.id }]);
    expect(await t.store.getJob(body.id)).toMatchObject({ type: 'crawl', status: 'scraping', limit: 5, apiKeyId: t.keyId });
  });

  it('uses the configured public URL and returns warnings for ignored options', async () => {
    const t = await makeJobsApp({ jobs: { publicUrl: 'https://api.example.org' } });
    const body = (await post(t, '/v2/crawl', { url: `${E}/`, prompt: 'blog only' })).json();
    expect(body.url).toBe(`https://api.example.org/v2/crawl/${body.id}`);
    expect(body.warning).toContain('prompt');
  });

  it('caps the limit at the operator maximum', async () => {
    const t = await makeJobsApp({ jobs: { maxCrawlLimit: 7 } });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, limit: 100000 })).json();
    expect((await t.store.getJob(id))?.limit).toBe(7);
  });

  it('validates input and security-sensitive options', async () => {
    const t = await makeJobsApp();
    expect((await post(t, '/v2/crawl', { url: 'nope' })).json()).toMatchObject({ code: 'VALIDATION' });
    const robotsRes = await post(t, '/v2/crawl', { url: `${E}/`, ignoreRobotsTxt: true });
    expect(robotsRes.statusCode).toBe(400);
    expect(robotsRes.json().error).toContain('ignoreRobotsTxt');
    expect((await post(t, '/v2/crawl', { url: 'http://127.0.0.1:8080/' })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
    expect((await post(t, '/v2/crawl', { url: `${E}/`, webhook: { url: 'http://169.254.169.254/x' } })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('allows ignoreRobotsTxt when the operator enabled it', async () => {
    const t = await makeJobsApp({ allowIgnoreRobots: true });
    expect((await post(t, '/v2/crawl', { url: `${E}/`, ignoreRobotsTxt: true })).statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const t = await makeJobsApp();
    const res = await t.app.inject({ method: 'POST', url: '/v2/crawl', payload: { url: `${E}/` } });
    expect(res.statusCode).toBe(401);
  });

  it('answers 501 when the job queue is not configured', async () => {
    const t = await makeJobsApp();
    const { buildApp } = await import('../src/app');
    const bare = buildApp({ store: t.store, snapshots: t.deps.snapshots, engines: t.deps.engines, scraper: t.deps.scraper, useAuth: false });
    const res = await bare.inject({ method: 'POST', url: '/v2/crawl', payload: { url: `${E}/` } });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('queue');
  });
});

describe('GET /v2/crawl/:id', () => {
  it('reports progress and returns the crawled pages as v2 documents', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    const early = (await get(t, `/v2/crawl/${id}`)).json();
    expect(early).toMatchObject({ success: true, status: 'scraping', total: 0, completed: 0, data: [], next: null });

    await drain(t.deps, t.queues);
    const res = await get(t, `/v2/crawl/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'completed', total: 5, completed: 3, creditsUsed: 3, next: null });
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect(Date.parse(body.completedAt)).not.toBeNaN();
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(typeof body.duration).toBe('number');
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({ markdown: expect.any(String), metadata: { sourceURL: `${E}/`, statusCode: 200 }, trust: { verdict: 'ok' } });
  });

  it('paginates with skip and next when a page would exceed the byte budget', async () => {
    const t = await makeJobsApp({ site, files: robots, jobs: { pageBytes: 1 } });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    await drain(t.deps, t.queues);
    const first = (await get(t, `/v2/crawl/${id}`)).json();
    expect(first.data).toHaveLength(1);
    expect(first.next).toBe(`http://localhost:80/v2/crawl/${id}?skip=1`);
    const second = (await get(t, `/v2/crawl/${id}?skip=1`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].metadata.sourceURL).not.toBe(first.data[0].metadata.sourceURL);
    expect(second.next).toBe(`http://localhost:80/v2/crawl/${id}?skip=2`);
    const last = (await get(t, `/v2/crawl/${id}?skip=2`)).json();
    expect(last.data).toHaveLength(1);
    expect(last.next).toBeNull();
    expect((await get(t, `/v2/crawl/${id}?skip=-5`)).json().data).toHaveLength(1);
  });

  it('hides jobs from other keys, other job types, bad ids and expired jobs', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/` })).json();
    await t.store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'o' });
    expect((await get(t, `/v2/crawl/${id}`, { authorization: 'Bearer ic-other' })).statusCode).toBe(404);
    expect((await get(t, `/v2/batch/scrape/${id}`)).statusCode).toBe(404);
    expect((await get(t, '/v2/crawl/not-a-uuid')).statusCode).toBe(404);
    expect((await get(t, `/v2/crawl/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('treats an expired job as not found', async () => {
    const t = await makeJobsApp();
    const id = randomUUID();
    await t.store.createJob({ id, type: 'crawl', apiKeyId: t.keyId, request: { url: E }, webhook: null, limit: 1, expiresAt: new Date(Date.now() - 1000) });
    expect((await get(t, `/v2/crawl/${id}`)).statusCode).toBe(404);
  });
});

describe('DELETE /v2/crawl/:id', () => {
  it('cancels a running crawl, is refused for finished ones, and stops further work', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    const res = await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: t.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'cancelled' });
    await drain(t.deps, t.queues);
    expect(t.calls).toEqual([]);
    expect((await get(t, `/v2/crawl/${id}`)).json()).toMatchObject({ status: 'cancelled' });

    const again = await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: t.auth });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONFLICT' });
    expect((await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${randomUUID()}`, headers: t.auth })).statusCode).toBe(404);
  });
});

describe('GET /v2/crawl/:id/errors and /v2/crawl/active', () => {
  it('lists failed pages and robots-blocked URLs', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    await drain(t.deps, t.queues);
    const body = (await get(t, `/v2/crawl/${id}/errors`)).json();
    expect(body.robotsBlocked).toEqual([`${E}/private/x`]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ url: `${E}/missing`, error: expect.any(String) });
    expect(body.errors[0].id).toBeTruthy();
    expect(Date.parse(body.errors[0].timestamp)).not.toBeNaN();
  });

  it('lists the caller\'s active crawls', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, limit: 3 })).json();
    const active = (await get(t, '/v2/crawl/active')).json();
    expect(active).toMatchObject({ success: true });
    expect(active.crawls).toEqual([{ id, teamId: t.keyId, url: `${E}/`, status: 'scraping', options: { scrapeOptions: {} } }]);
    await drain(t.deps, t.queues);
    expect((await get(t, '/v2/crawl/active')).json().crawls).toEqual([]);
  });

  it('answers 501 for crawl params-preview (not implemented)', async () => {
    const t = await makeJobsApp();
    const res = await post(t, '/v2/crawl/params-preview', { url: `${E}/`, prompt: 'blog' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('not implemented');
  });
});

describe('batch scrape routes', () => {
  it('creates a batch, reports invalid URLs, and serves its status, errors and cancellation', async () => {
    const t = await makeJobsApp({ site });
    const res = await post(t, '/v2/batch/scrape', { urls: [`${E}/a`, `${E}/b`, `${E}/missing`, 'not a url'], formats: ['markdown'] });
    expect(res.statusCode).toBe(200);
    const { id, url, invalidURLs } = res.json();
    expect(url).toBe(`http://localhost:80/v2/batch/scrape/${id}`);
    expect(invalidURLs).toEqual(['not a url']);
    expect(t.queues.jobs).toHaveLength(3);
    expect(await t.store.getJob(id)).toMatchObject({ type: 'batch', total: 3, limit: 3 });

    await drain(t.deps, t.queues);
    const status = (await get(t, `/v2/batch/scrape/${id}`)).json();
    expect(status).toMatchObject({ status: 'completed', total: 3, completed: 2, creditsUsed: 2, next: null });
    expect(status.data.map((d: { markdown: string }) => d.markdown.includes('Real readable'))).toEqual([true, true]);
    const errors = (await get(t, `/v2/batch/scrape/${id}/errors`)).json();
    expect(errors.errors).toHaveLength(1);
    expect(errors.robotsBlocked).toEqual([]);

    expect((await t.app.inject({ method: 'DELETE', url: `/v2/batch/scrape/${id}`, headers: t.auth })).statusCode).toBe(409);
    expect((await get(t, `/v2/crawl/${id}`)).statusCode).toBe(404);
  });

  it('omits invalidURLs when ignoreInvalidURLs is false and rejects bad URLs then', async () => {
    const t = await makeJobsApp({ site });
    expect((await post(t, '/v2/batch/scrape', { urls: [`${E}/a`], ignoreInvalidURLs: false })).json().invalidURLs).toBeUndefined();
    expect((await post(t, '/v2/batch/scrape', { urls: [`${E}/a`, 'bad'], ignoreInvalidURLs: false })).statusCode).toBe(400);
    expect((await post(t, '/v2/batch/scrape', { urls: [] })).statusCode).toBe(400);
  });

  it('refuses private URLs in the batch and queues a started webhook', async () => {
    const t = await makeJobsApp({ site });
    expect((await post(t, '/v2/batch/scrape', { urls: ['http://127.0.0.1/x'] })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
    await post(t, '/v2/batch/scrape', { urls: [`${E}/a`], webhook: { url: 'https://hooks.example.com/x' } });
    expect(JSON.parse(t.queues.webhooks[0].body).type).toBe('batch_scrape.started');
  });
});
