import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine } from '@icecrawl/engines';
import { BullQueues } from '@icecrawl/queue';
import { sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { makeFetcher } from '../src/jobs/fetcher';
import { startJobWorkers } from '../src/jobs/runner';
import type { JobDeps } from '../src/jobs/processor';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';
import { filler } from './jobs-helpers';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const html = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${filler}</p>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(' ')}</article></body></html>`;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!databaseUrl || !redisUrl)('end to end: crawl, batch, map and webhooks with real Postgres, Redis and BullMQ', () => {
  const sql = createSql(databaseUrl ?? 'postgres://unused');
  let origin: Server;
  let receiver: Server;
  let port: number;
  let hookPort: number;
  let dir: string;
  let queues: BullQueues;
  let stopWorkers: { close(): Promise<void> };
  let app: ReturnType<typeof buildApp>;
  let auth: { authorization: string };
  const secret = 'e2e-webhook-secret';
  const hits: string[] = [];
  const hooks: Array<{ headers: IncomingMessage['headers']; body: string }> = [];

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-crawl-'));

    origin = createServer((req, res) => {
      const url = req.url ?? '/';
      hits.push(url);
      const send = (status: number, type: string, body: string) => res.writeHead(status, { 'content-type': type }).end(body);
      const o = `http://127.0.0.1:${port}`;
      switch (url) {
        case '/robots.txt':
          return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\nSitemap: ${o}/sitemap.xml\n`);
        case '/sitemap.xml':
          return send(200, 'application/xml', `<urlset><url><loc>${o}/sitemap-only</loc></url><url><loc>${o}/a</loc></url></urlset>`);
        case '/':
          return send(200, 'text/html', html('Home', ['/a', '/b', '/blog/post-1', '/private/secret', '/missing', '/logo.png']));
        case '/a':
          return send(200, 'text/html', html('A', ['/b', '/a/deep']));
        case '/a/deep':
          return send(200, 'text/html', html('Deep'));
        case '/b':
          return send(200, 'text/html', html('B'));
        case '/blog/post-1':
          return send(200, 'text/html', html('Post 1'));
        case '/sitemap-only':
          return send(200, 'text/html', html('Sitemap only'));
        case '/private/secret':
          return send(200, 'text/html', html('Secret'));
        case '/slow1':
        case '/slow2':
        case '/slow3':
          return send(200, 'text/html', html(url.slice(1), ['/slow1', '/slow2', '/slow3']));
        default:
          return send(404, 'text/html', '<html><body>missing</body></html>');
      }
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;

    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hooks.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    hookPort = (receiver.address() as AddressInfo).port;

    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(join(dir, 'snaps'));
    queues = new BullQueues({ redisUrl: redisUrl!, prefix: `icecrawl-e2e-${randomUUID().slice(0, 8)}`, maxAttempts: 2 });
    const scraper = { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false };
    const fetcher = makeFetcher({ allowPrivateNetworks: true });
    const jobDeps: JobDeps = { store, snapshots, engines: [fetchEngine], scraper, queues, fetcher, allowIgnoreRobots: false };
    stopWorkers = startJobWorkers(queues, jobDeps, { secret, allowPrivate: true }, { concurrency: 4 });

    const token = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(token), name: 'e2e-crawl' });
    auth = { authorization: `Bearer ${token}` };
    app = buildApp({
      store,
      snapshots,
      engines: [fetchEngine],
      scraper,
      useAuth: true,
      map: { fetcher },
      jobs: { queues, ttlHours: 24, pageBytes: 10_000_000, maxCrawlLimit: 1000, allowPrivateNetworks: true, allowIgnoreRobots: false },
    });
  });

  afterAll(async () => {
    await stopWorkers.close();
    const keys = await queues.connection.keys(`${queues.prefix}:*`);
    if (keys.length > 0) await queues.connection.del(...keys);
    await queues.close();
    origin.closeAllConnections();
    origin.close();
    receiver.closeAllConnections();
    receiver.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  const o = () => `http://127.0.0.1:${port}`;
  const start = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/v2/crawl', headers: auth, payload: payload as never });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; url: string };
  };
  const finished = (id: string, path = 'crawl') =>
    until(async () => {
      const body = (await app.inject({ method: 'GET', url: `/v2/${path}/${id}`, headers: auth })).json();
      return body.status !== 'scraping' ? body : false;
    });

  it('crawls a site: robots, sitemap, dedup, scope, errors, signed webhooks and receipts', async () => {
    hooks.length = 0;
    const { id } = await start({
      url: `${o()}/`,
      webhook: { url: `http://127.0.0.1:${hookPort}/hook`, metadata: { run: 'e2e' }, headers: { 'X-Run': '1' } },
    });
    const body = await finished(id);
    expect(body.status).toBe('completed');

    const urls = body.data.map((d: { metadata: { sourceURL: string } }) => d.metadata.sourceURL).sort();
    expect(urls).toEqual(['/', '/a', '/a/deep', '/b', '/blog/post-1', '/sitemap-only'].map((p) => `${o()}${p}`).sort());
    expect(body.total).toBe(8);
    expect(body.completed).toBe(6);

    const errors = (await app.inject({ method: 'GET', url: `/v2/crawl/${id}/errors`, headers: auth })).json();
    expect(errors.robotsBlocked).toEqual([`${o()}/private/secret`]);
    expect(errors.errors.map((e: { url: string }) => e.url)).toEqual([`${o()}/missing`]);
    expect(hits).not.toContain('/private/secret');
    expect(hits.filter((h) => h === '/a')).toHaveLength(1);
    expect(hits).not.toContain('/logo.png');

    const receiptId = body.data[0].trust.receiptId as string;
    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${receiptId}`, headers: auth })).json();
    expect(receipt.success).toBe(true);

    await until(async () => hooks.length >= 10 || false);
    const events = hooks.map((h) => JSON.parse(h.body));
    expect(events.filter((e) => e.type === 'crawl.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'crawl.page')).toHaveLength(8);
    expect(events.filter((e) => e.type === 'crawl.completed')).toHaveLength(1);
    expect(events.every((e) => e.id === id && e.metadata.run === 'e2e')).toBe(true);
    for (const h of hooks) {
      const expected = `sha256=${createHmac('sha256', secret).update(h.body).digest('hex')}`;
      expect(h.headers['x-icecrawl-signature']).toBe(expected);
      expect(h.headers['x-firecrawl-signature']).toBe(expected);
      expect(h.headers['x-run']).toBe('1');
    }
  });

  it('applies includePaths and the page limit', async () => {
    const included = await finished((await start({ url: `${o()}/`, includePaths: ['^/blog'], sitemap: 'skip' })).id);
    expect(included.data.map((d: { metadata: { sourceURL: string } }) => d.metadata.sourceURL).sort()).toEqual([`${o()}/`, `${o()}/blog/post-1`].sort());

    const limited = await finished((await start({ url: `${o()}/`, limit: 2, sitemap: 'skip' })).id);
    expect(limited.total).toBe(2);
    expect(limited.data).toHaveLength(2);
  });

  it('cancels a slow crawl and stops scraping', async () => {
    const { id } = await start({ url: `${o()}/slow1`, delay: 1, sitemap: 'skip', crawlEntireDomain: true });
    await until(async () => ((await app.inject({ method: 'GET', url: `/v2/crawl/${id}`, headers: auth })).json().completed >= 1) || false);
    const del = await app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: auth });
    expect(del.json()).toEqual({ status: 'cancelled' });
    const before = hits.filter((h) => h.startsWith('/slow')).length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(hits.filter((h) => h.startsWith('/slow')).length).toBeLessThanOrEqual(before + 1);
    expect((await app.inject({ method: 'GET', url: `/v2/crawl/${id}`, headers: auth })).json().status).toBe('cancelled');
  });

  it('runs a batch scrape with an invalid URL and a failing page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v2/batch/scrape',
      headers: auth,
      payload: { urls: [`${o()}/a`, `${o()}/b`, `${o()}/missing`, 'not-a-url'], formats: ['markdown', 'links'] } as never,
    });
    const { id, invalidURLs } = res.json();
    expect(invalidURLs).toEqual(['not-a-url']);
    const body = await finished(id, 'batch/scrape');
    expect(body).toMatchObject({ status: 'completed', total: 3, completed: 2 });
    expect(body.data[0].links).toBeDefined();
    const errors = (await app.inject({ method: 'GET', url: `/v2/batch/scrape/${id}/errors`, headers: auth })).json();
    expect(errors.errors).toHaveLength(1);
  });

  it('maps a site', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/map', headers: auth, payload: { url: `${o()}/` } as never });
    const links = res.json().links.map((l: { url: string }) => l.url);
    expect(links).toContain(`${o()}/sitemap-only`);
    expect(links).toContain(`${o()}/blog/post-1`);
    expect(links).not.toContain(`${o()}/logo.png`);
  });
});
