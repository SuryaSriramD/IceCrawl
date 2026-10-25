import { sha256Hex, type PrivateSigningKey } from '@icecrawl/trust';
import type { ScraperConfig } from '@icecrawl/scraper';
import { buildApp } from '../src/app';
import { randomUUID } from 'node:crypto';
import { featureSet, type Engine, type SearchProvider } from '@icecrawl/engines';
import type { RateLimiter } from '../src/ratelimit';
import type { ExtractionDeps } from '../src/scrape-service';
import type { Fetcher } from '@icecrawl/crawler';
import { MemoryQueues, type JobContext } from '@icecrawl/queue';
import { processScrapeJob, type JobDeps } from '../src/jobs/processor';
import { MemorySnapshotStore, MemoryStore } from '../src/store/memory';
import type { NewJob } from '../src/store/types';

export const filler = 'Real readable sentence about a real topic that is long enough to be trusted. '.repeat(8);

export const pageHtml = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${filler}</p>${links
    .map((l, i) => `<a href="${l}">link ${i}</a>`)
    .join(' ')}</article></body></html>`;

export type Site = Record<string, { status?: number; html: string; contentType?: string } | Error>;

/** An engine that serves a fixed set of pages and records which URLs it was asked for. */
export function siteEngine(site: Site, calls: string[] = []): Engine {
  return {
    name: 'site',
    quality: 10,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async (ctx) => {
      calls.push(ctx.url);
      const p = site[ctx.url];
      if (p instanceof Error) throw p;
      if (!p) return { finalUrl: ctx.url, statusCode: 404, headers: {}, body: Buffer.from('<html><body>missing</body></html>'), contentType: 'text/html', truncated: false };
      return {
        finalUrl: ctx.url,
        statusCode: p.status ?? 200,
        headers: {},
        body: Buffer.from(p.html),
        contentType: p.contentType ?? 'text/html; charset=utf-8',
        truncated: false,
      };
    },
  };
}

export function fakeFetcher(files: Record<string, { status?: number; body: string | Uint8Array } | Error>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const f = files[url];
    if (f instanceof Error) throw f;
    if (!f) return { status: 404, body: new Uint8Array() };
    return { status: f.status ?? 200, body: typeof f.body === 'string' ? Buffer.from(f.body) : f.body };
  };
}

export function makeJobDeps(over: Partial<JobDeps> & { site?: Site; files?: Parameters<typeof fakeFetcher>[0] } = {}) {
  const queues = (over.queues as MemoryQueues | undefined) ?? new MemoryQueues();
  const store = over.store ?? new MemoryStore();
  const calls: string[] = [];
  const deps: JobDeps = {
    store,
    snapshots: new MemorySnapshotStore(),
    engines: [siteEngine(over.site ?? {}, calls)],
    scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false },
    queues,
    fetcher: fakeFetcher(over.files ?? {}),
    allowIgnoreRobots: false,
    ...over,
  };
  return { deps, store: store as MemoryStore, queues, calls };
}

export async function createCrawl(
  store: MemoryStore,
  request: Record<string, unknown>,
  over: Partial<NewJob> = {},
): Promise<string> {
  const id = randomUUID();
  await store.createJob({
    id,
    type: 'crawl',
    apiKeyId: null,
    request: { limit: 100, sitemap: 'include', ...request },
    webhook: null,
    limit: Number(request.limit ?? 100),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...over,
  });
  return id;
}

export async function createBatch(store: MemoryStore, urls: string[], over: Partial<NewJob> & { scrapeOptions?: Record<string, unknown>; maxConcurrency?: number } = {}) {
  const id = randomUUID();
  const { scrapeOptions, maxConcurrency, ...rest } = over;
  await store.createJob({
    id,
    type: 'batch',
    apiKeyId: null,
    request: { urls, scrapeOptions: scrapeOptions ?? {}, maxConcurrency },
    webhook: null,
    limit: urls.length,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...rest,
  });
  await store.reserveUrls(id, urls.length);
  return id;
}

/** Process queued jobs until the queue is empty, emulating BullMQ delays and retries. */
export async function drain(deps: JobDeps, queues: MemoryQueues, o: { maxAttempts?: number; maxSteps?: number } = {}): Promise<void> {
  const maxAttempts = o.maxAttempts ?? 1;
  const attempts = new Map<unknown, number>();
  for (let step = 0; step < (o.maxSteps ?? 2000); step++) {
    const next = queues.takeNext();
    if (!next) return;
    const made = attempts.get(next) ?? 0;
    const ctx: JobContext = { attemptsMade: made, maxAttempts };
    try {
      const r = await processScrapeJob(deps, next, ctx);
      if (r.delayMs) queues.jobs.push(next);
    } catch {
      attempts.set(next, made + 1);
      if (made + 1 < maxAttempts) queues.jobs.push(next);
    }
  }
  throw new Error('drain did not converge');
}

export async function makeJobsApp(
  over: { site?: Site; files?: Parameters<typeof fakeFetcher>[0]; useAuth?: boolean; jobs?: Partial<import('../src/routes/jobs').JobsDeps>; allowIgnoreRobots?: boolean; signer?: PrivateSigningKey; scraper?: Partial<ScraperConfig>; extraction?: ExtractionDeps; search?: SearchProvider | null; searchMaxScrape?: number; extractMaxPages?: number; rateLimiter?: RateLimiter | null; team?: { workerConcurrency?: number } } = {},
) {
  const { deps, store, queues, calls } = makeJobDeps({ site: over.site, files: over.files, allowIgnoreRobots: over.allowIgnoreRobots ?? false,
    extraction: over.extraction,
    search: over.search,
    extractMaxPages: over.extractMaxPages,
    ...(over.scraper ? { scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false, ...over.scraper } } : {}),
  });
  const keyId = randomUUID();
  await store.createApiKey({ id: keyId, hash: sha256Hex('ic-jobs'), name: 'jobs' });
  const app = buildApp({
    store,
    snapshots: deps.snapshots,
    engines: deps.engines,
    scraper: { ...deps.scraper, ...over.scraper },
    signer: over.signer,
    extraction: over.extraction,
    search: over.search,
    searchMaxScrape: over.searchMaxScrape,
    rateLimiter: over.rateLimiter,
    team: over.team,
    useAuth: over.useAuth ?? true,
    map: { fetcher: deps.fetcher },
    jobs: {
      queues,
      ttlHours: 24,
      pageBytes: 10_000_000,
      maxCrawlLimit: 1000,
      allowPrivateNetworks: false,
      allowIgnoreRobots: over.allowIgnoreRobots ?? false,
      ...over.jobs,
    },
  });
  return { app, store, queues, deps, calls, keyId, auth: { authorization: 'Bearer ic-jobs' } };
}
