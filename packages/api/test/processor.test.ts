import { describe, expect, it } from 'vitest';
import { IceCrawlError } from '@icecrawl/core';
import { createBatch, createCrawl, drain, makeJobDeps, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const robotsOk = { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private/\n' } };

const pages = (urls: string[]) => urls.map((u) => (u.startsWith('http') ? u : `${E}${u}`));

describe('crawl processing', () => {
  it('crawls pages reachable by links, scoped to the start path, and completes the job', async () => {
    const site = {
      [`${E}/docs`]: { html: pageHtml('Docs', ['/docs/a', '/docs/b', '/blog/x', 'https://other.org/o', `${E}/logo.png`]) },
      [`${E}/docs/a`]: { html: pageHtml('A', ['/docs/b', '/docs/a/deep']) },
      [`${E}/docs/b`]: { html: pageHtml('B', ['/docs']) },
      [`${E}/docs/a/deep`]: { html: pageHtml('Deep') },
      [`${E}/blog/x`]: { html: pageHtml('Blog') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/docs` });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual(pages(['/docs', '/docs/a', '/docs/a/deep', '/docs/b']).sort());
    const job = await store.getJob(id);
    expect(job).toMatchObject({ status: 'completed', total: 4, completed: 4, failed: 0 });
    expect(job?.completedAt).not.toBeNull();
    const { items } = await store.listJobPages(id, 0, 10_000_000);
    expect(items.map((i) => (i.metadata as { title: string }).title).sort()).toEqual(['A', 'B', 'Deep', 'Docs']);
    expect(queues.cleared).toContain(id);
  });

  it('never scrapes a URL twice and respects the page limit', async () => {
    const site: Record<string, { html: string }> = {
      [`${E}/`]: { html: pageHtml('Home', ['/a', '/b', '/c', '/d', '/a', `${E}/a#frag`, `${E}/a/`]) },
    };
    for (const p of ['a', 'b', 'c', 'd']) site[`${E}/${p}`] = { html: pageHtml(p, ['/', '/a']) };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, limit: 3 });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3);
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 3 });
  });

  it('seeds from the sitemap and honours includePaths/excludePaths', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/blog/p1', '/about']) },
      [`${E}/blog/p1`]: { html: pageHtml('P1') },
      [`${E}/blog/p2`]: { html: pageHtml('P2') },
      [`${E}/about`]: { html: pageHtml('About') },
      [`${E}/drafts/d`]: { html: pageHtml('Draft') },
    };
    const files = {
      ...robotsOk,
      [`${E}/sitemap.xml`]: { body: `<urlset><url><loc>${E}/blog/p2</loc></url><url><loc>${E}/drafts/d</loc></url><url><loc>${E}/about</loc></url></urlset>` },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files });
    const id = await createCrawl(store, { url: `${E}/`, includePaths: ['^/blog'], excludePaths: ['drafts'] });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual(pages(['/', '/blog/p1', '/blog/p2']).sort());
  });

  it('supports sitemap modes only and skip', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/linked']) },
      [`${E}/linked`]: { html: pageHtml('Linked') },
      [`${E}/mapped`]: { html: pageHtml('Mapped', ['/linked']) },
    };
    const files = { ...robotsOk, [`${E}/sitemap.xml`]: { body: `<urlset><url><loc>${E}/mapped</loc></url></urlset>` } };

    const only = makeJobDeps({ site, files });
    const a = await createCrawl(only.store, { url: `${E}/`, sitemap: 'only' });
    await only.queues.addDiscover(a);
    await drain(only.deps, only.queues);
    expect(only.calls).toEqual([`${E}/mapped`]);

    const skip = makeJobDeps({ site, files });
    const b = await createCrawl(skip.store, { url: `${E}/`, sitemap: 'skip' });
    await skip.queues.addDiscover(b);
    await drain(skip.deps, skip.queues);
    expect([...skip.calls].sort()).toEqual([`${E}/`, `${E}/linked`].sort());
  });

  it('falls back to the start URL when sitemap=only finds no sitemap', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'only' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/`]);
  });

  it('follows external links one hop and does not discover from external pages', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['https://other.org/x']) },
      'https://other.org/x': { html: pageHtml('Ext', ['https://other.org/y']) },
      'https://other.org/y': { html: pageHtml('Ext2') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: { ...robotsOk, 'https://other.org/robots.txt': { status: 404, body: '' } } });
    const id = await createCrawl(store, { url: `${E}/`, allowExternalLinks: true, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/`, 'https://other.org/x'].sort());
  });

  it('honours maxDiscoveryDepth', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('0', ['/1']) },
      [`${E}/1`]: { html: pageHtml('1', ['/2']) },
      [`${E}/2`]: { html: pageHtml('2', ['/3']) },
      [`${E}/3`]: { html: pageHtml('3') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', maxDiscoveryDepth: 1 });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/`, `${E}/1`].sort());
  });
});

describe('robots.txt', () => {
  it('records robots-blocked URLs instead of scraping them', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/private/secret', '/ok']) },
      [`${E}/ok`]: { html: pageHtml('Ok') },
      [`${E}/private/secret`]: { html: pageHtml('Secret') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).not.toContain(`${E}/private/secret`);
    const errors = await store.listJobErrors(id);
    expect(errors).toEqual([expect.objectContaining({ url: `${E}/private/secret`, kind: 'robots', code: 'ROBOTS_DISALLOWED' })]);
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 2, failed: 1 });
  });

  it('fails the job when the start URL itself is disallowed', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/private/x`]: { html: pageHtml('X') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/private/x`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([]);
    expect(await store.getJob(id)).toMatchObject({ status: 'failed', completed: 0, failed: 1 });
  });

  it('ignores robots only when the request asks and the operator allows it', async () => {
    const site = { [`${E}/private/x`]: { html: pageHtml('X') } };
    const denied = makeJobDeps({ site, files: robotsOk, allowIgnoreRobots: false });
    const a = await createCrawl(denied.store, { url: `${E}/private/x`, sitemap: 'skip', ignoreRobotsTxt: true });
    await denied.queues.addDiscover(a);
    await drain(denied.deps, denied.queues);
    expect(denied.calls).toEqual([]);

    const allowed = makeJobDeps({ site, files: robotsOk, allowIgnoreRobots: true });
    const b = await createCrawl(allowed.store, { url: `${E}/private/x`, sitemap: 'skip', ignoreRobotsTxt: true });
    await allowed.queues.addDiscover(b);
    await drain(allowed.deps, allowed.queues);
    expect(allowed.calls).toEqual([`${E}/private/x`]);
  });

  it('treats an unreachable robots.txt as disallow-all (RFC 9309)', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: { [`${E}/robots.txt`]: { status: 503, body: '' } } });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([]);
    expect((await store.getJob(id))?.status).toBe('failed');
  });

  it('caches robots.txt per origin across pages', async () => {
    const fetched: string[] = [];
    const { fakeFetcher } = await import('./jobs-helpers');
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) },
      [`${E}/a`]: { html: pageHtml('A') },
      [`${E}/b`]: { html: pageHtml('B') },
    };
    const { deps, store, queues } = makeJobDeps({ site, fetcher: fakeFetcher(robotsOk, fetched) });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(fetched.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('failures, retries, delays and cancellation', () => {
  it('records failed verdicts as errors and still completes when some pages succeed', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/blocked', '/gone']) },
      [`${E}/blocked`]: { status: 403, html: '<html>Forbidden</html>' },
    };
    const { deps, store, queues } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const errors = await store.listJobErrors(id);
    expect(errors.map((e) => [e.url, e.code]).sort()).toEqual([[`${E}/blocked`, 'BLOCKED'], [`${E}/gone`, 'TARGET_ERROR']].sort());
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 1, failed: 2 });
  });

  it('marks the job failed when no page succeeded', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: { status: 403, html: 'no' } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(await store.getJob(id)).toMatchObject({ status: 'failed', completed: 0, failed: 1 });
  });

  it('retries transient errors until the last attempt and then records the failure', async () => {
    let n = 0;
    const flaky = { [`${E}/`]: new IceCrawlError('TIMEOUT', 'slow') };
    const { deps, store, queues } = makeJobDeps({ site: flaky, files: robotsOk });
    const real = deps.engines[0];
    (deps as { engines: unknown }).engines = [{ ...real, scrape: async (c: Parameters<typeof real.scrape>[0]) => { n++; return real.scrape(c); } }];
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues, { maxAttempts: 3 });
    expect(n).toBe(3);
    expect(await store.listJobErrors(id)).toEqual([expect.objectContaining({ code: 'TIMEOUT', kind: 'error' })]);
    expect((await store.getJob(id))?.status).toBe('failed');
  });

  it('does not retry permanent errors', async () => {
    let n = 0;
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: new IceCrawlError('SSRF_BLOCKED', 'private') }, files: robotsOk });
    const real = deps.engines[0];
    (deps as { engines: unknown }).engines = [{ ...real, scrape: async (c: Parameters<typeof real.scrape>[0]) => { n++; return real.scrape(c); } }];
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues, { maxAttempts: 3 });
    expect(n).toBe(1);
    expect((await store.listJobErrors(id))[0]).toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('asks to be delayed when the crawl slot is busy, doing no work meanwhile', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', maxConcurrency: 1 });
    await queues.addDiscover(id);
    queues.takeNext(); // discover processed manually below
    const { processScrapeJob } = await import('../src/jobs/processor');
    await processScrapeJob(deps, { kind: 'discover', jobId: id }, { attemptsMade: 0, maxAttempts: 1 });
    const page = queues.takeNext()!;
    queues.busy.push(321);
    expect(await processScrapeJob(deps, page, { attemptsMade: 0, maxAttempts: 1 })).toEqual({ delayMs: 321 });
    expect(calls).toEqual([]);
    expect(await processScrapeJob(deps, page, { attemptsMade: 0, maxAttempts: 1 })).toEqual({});
    expect(calls).toEqual([`${E}/`]);
  });

  it('applies the crawl delay and the robots Crawl-delay as slot spacing', async () => {
    const seen: Array<{ maxConcurrency?: number; delayMs?: number }> = [];
    const { deps, store, queues } = makeJobDeps({
      site: { [`${E}/`]: { html: pageHtml('Home') }, [`${E}/b`]: { html: pageHtml('B') } },
      files: { [`${E}/robots.txt`]: { body: 'User-agent: *\nCrawl-delay: 2\n' } },
    });
    queues.acquireSlot = async (_id, o) => (seen.push(o ?? {}), { ok: true, release: async () => {} });
    const viaRobots = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(viaRobots);
    await drain(deps, queues);
    expect(seen[0]).toEqual({ maxConcurrency: 1, delayMs: 2000 });

    seen.length = 0;
    const explicit = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', delay: 0.5, maxConcurrency: 5 });
    await queues.addDiscover(explicit);
    await drain(deps, queues);
    expect(seen[0]).toEqual({ maxConcurrency: 1, delayMs: 500 });
  });

  it('skips queued work of a cancelled job and does not finish it again', async () => {
    const { deps, store, queues, calls } = makeJobDeps({
      site: { [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) }, [`${E}/a`]: { html: pageHtml('A') }, [`${E}/b`]: { html: pageHtml('B') } },
      files: robotsOk,
    });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    const { processScrapeJob } = await import('../src/jobs/processor');
    await processScrapeJob(deps, queues.takeNext()!, { attemptsMade: 0, maxAttempts: 1 }); // discover
    await processScrapeJob(deps, queues.takeNext()!, { attemptsMade: 0, maxAttempts: 1 }); // start page (enqueues /a, /b)
    expect(await store.cancelJob(id)).toBe(true);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/`]);
    expect((await store.getJob(id))?.status).toBe('cancelled');
  });

  it('ignores jobs that do not exist', async () => {
    const { deps } = makeJobDeps();
    const { processScrapeJob } = await import('../src/jobs/processor');
    expect(await processScrapeJob(deps, { kind: 'page', jobId: 'nope', url: `${E}/`, depth: 0, external: false }, { attemptsMade: 0, maxAttempts: 1 })).toEqual({});
  });
});

describe('batch processing', () => {
  it('scrapes every URL, counts failures, and completes', async () => {
    const site = { [`${E}/a`]: { html: pageHtml('A') }, [`${E}/b`]: { html: pageHtml('B') } };
    const { deps, store, queues, calls } = makeJobDeps({ site });
    const id = await createBatch(store, [`${E}/a`, `${E}/b`, `${E}/missing`]);
    await queues.addPages([`${E}/a`, `${E}/b`, `${E}/missing`].map((url) => ({ jobId: id, url, depth: 0, external: false })));
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/a`, `${E}/b`, `${E}/missing`].sort());
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 2, failed: 1 });
    expect((await store.listJobErrors(id))[0]).toMatchObject({ url: `${E}/missing`, kind: 'error' });
  });

  it('does not check robots.txt or follow links for batch jobs, and uses the stored scrape options', async () => {
    const site = { [`${E}/private/a`]: { html: pageHtml('A', ['/more']) }, [`${E}/more`]: { html: pageHtml('More') } };
    const fetched: string[] = [];
    const { fakeFetcher } = await import('./jobs-helpers');
    const { deps, store, queues, calls } = makeJobDeps({ site, fetcher: fakeFetcher(robotsOk, fetched) });
    const id = await createBatch(store, [`${E}/private/a`], { scrapeOptions: { formats: ['markdown', 'links'] } });
    await queues.addPages([{ jobId: id, url: `${E}/private/a`, depth: 0, external: false }]);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/private/a`]);
    expect(fetched).toEqual([]);
    const { items } = await store.listJobPages(id, 0, 1_000_000);
    expect(items[0].links).toEqual([`${E}/more`]);
  });
});

describe('webhooks from the processor', () => {
  it('emits started, one page event per page, and completed, in order', async () => {
    const site = { [`${E}/`]: { html: pageHtml('Home', ['/a']) }, [`${E}/a`]: { html: pageHtml('A') } };
    const { deps, store, queues } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' }, { webhook: { url: 'https://hooks.example.com/x', metadata: { m: 1 } } });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const events = queues.webhooks.map((w) => JSON.parse(w.body));
    expect(events.map((e) => e.type)).toEqual(['crawl.started', 'crawl.page', 'crawl.page', 'crawl.completed']);
    expect(events[1].data[0]).toMatchObject({ markdown: expect.stringContaining('Real readable sentence'), metadata: { title: 'Home', url: `${E}/`, scrapeId: expect.any(String) } });
    expect(events[3]).toMatchObject({ success: true, data: [], metadata: { m: 1 }, id });
    expect(new Set(events.map((e) => e.webhookId)).size).toBe(4);
  });

  it('emits crawl.failed when nothing succeeded, and page events carry the error for failed pages', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: { status: 403, html: 'no' } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' }, { webhook: { url: 'https://hooks.example.com/x' } });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const events = queues.webhooks.map((w) => JSON.parse(w.body));
    expect(events.map((e) => e.type)).toEqual(['crawl.started', 'crawl.page', 'crawl.failed']);
    expect(events[1]).toMatchObject({ success: false, data: [] });
    expect(typeof events[1].error).toBe('string');
    expect(events[2]).toMatchObject({ success: false });
  });

  it('emits batch_scrape events', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/a`]: { html: pageHtml('A') } } });
    const id = await createBatch(store, [`${E}/a`], { webhook: { url: 'https://hooks.example.com/x' } });
    await queues.addPages([{ jobId: id, url: `${E}/a`, depth: 0, external: false }]);
    await drain(deps, queues);
    expect(queues.webhooks.map((w) => JSON.parse(w.body).type)).toEqual(['batch_scrape.page', 'batch_scrape.completed']);
  });
});
