import { crawlRequestSchema, IceCrawlError, normalizeScrapeRequest, type CrawlRequest } from '@icecrawl/core';
import {
  ALLOW_ALL,
  buildScope,
  decideLink,
  defaultSitemapSeeds,
  discoverSitemapUrls,
  loadRobots,
  normalizeUrl,
  type Fetcher,
  type RobotsRules,
} from '@icecrawl/crawler';
import type { Engine, SearchProvider } from '@icecrawl/engines';
import type { JobContext, JobQueues, PageJobData, ScrapeJobData } from '@icecrawl/queue';
import type { ScraperConfig } from '@icecrawl/scraper';
import type { PrivateSigningKey } from '@icecrawl/trust';
import { scrapeAndPersist, type ExtractionDeps } from '../scrape-service';
import type { JobRecord, SnapshotStore, Store } from '../store/types';
import { sendWebhook } from './webhooks';

export interface JobDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  signer?: PrivateSigningKey;
  queues: JobQueues;
  fetcher: Fetcher;
  allowIgnoreRobots: boolean;
  robotsTtlMs?: number;
  maxCrawlDelaySeconds?: number;
  // shortcut: robots rules are cached per worker process; upgrade by caching in Redis so workers share them.
  robotsCache?: Map<string, { rules: RobotsRules; at: number }>;
  extraction?: ExtractionDeps;
  search?: SearchProvider | null;
  extractMaxPages?: number;
}

const DEFAULT_UA = 'IceCrawl';
const RETRYABLE = new Set(['TIMEOUT', 'TARGET_ERROR']);

interface StoredBatch {
  urls: string[];
  maxConcurrency?: number;
  scrapeOptions?: Record<string, unknown>;
}

export async function processScrapeJob(
  deps: JobDeps,
  data: ScrapeJobData,
  ctx: JobContext,
): Promise<{ delayMs?: number }> {
  const job = await deps.store.getJob(data.jobId);
  if (!job || job.status !== 'scraping') return {};
  return data.kind === 'discover' ? discover(deps, job) : page(deps, job, data, ctx);
}

const scopeOf = (crawl: CrawlRequest) =>
  buildScope(crawl.url, {
    includePaths: crawl.includePaths,
    excludePaths: crawl.excludePaths,
    regexOnFullURL: crawl.regexOnFullURL,
    crawlEntireDomain: crawl.crawlEntireDomain,
    allowExternalLinks: crawl.allowExternalLinks,
    allowSubdomains: crawl.allowSubdomains,
    maxDiscoveryDepth: crawl.maxDiscoveryDepth,
  });

const ignoresRobots = (deps: JobDeps, crawl: CrawlRequest) => crawl.ignoreRobotsTxt && deps.allowIgnoreRobots;

async function robotsFor(deps: JobDeps, origin: string, userAgent: string): Promise<RobotsRules> {
  const cache = (deps.robotsCache ??= new Map());
  const key = `${origin}|${userAgent}`;
  const hit = cache.get(key);
  const ttl = deps.robotsTtlMs ?? 10 * 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.rules;
  const rules = await loadRobots(origin, deps.fetcher, userAgent);
  cache.set(key, { rules, at: Date.now() });
  return rules;
}

async function finishJob(deps: JobDeps, jobId: string, failureMessage?: string): Promise<void> {
  const fresh = await deps.store.getJob(jobId);
  if (!fresh || fresh.status !== 'scraping') return;
  const status = fresh.completed > 0 ? 'completed' : 'failed';
  const won = await deps.store.finalizeJob(jobId, status);
  if (!won) return;
  await sendWebhook(deps.queues, won, status === 'failed' ? 'failed' : 'completed', [], {
    success: status === 'completed',
    error: status === 'failed' ? failureMessage ?? 'No page could be scraped' : undefined,
  });
  await deps.queues.clearJob(jobId);
}

async function completePage(
  deps: JobDeps,
  job: JobRecord,
  outcome: 'completed' | 'failed',
  info: { page?: unknown; error?: string },
): Promise<void> {
  await sendWebhook(deps.queues, job, 'page', info.page === undefined ? [] : [info.page], {
    success: outcome === 'completed',
    error: info.error,
  });
  const counters = await deps.store.recordPageResult(job.id, outcome);
  if (counters.status === 'scraping' && counters.completed + counters.failed >= counters.total) {
    await finishJob(deps, job.id, info.error);
  }
}

async function discover(deps: JobDeps, job: JobRecord): Promise<{ delayMs?: number }> {
  if (job.type !== 'crawl') return {};
  const crawl = crawlRequestSchema.parse(job.request);
  try {
    await sendWebhook(deps.queues, job, 'started', []);
    const start = new URL(crawl.url);
    const ua = crawl.robotsUserAgent ?? DEFAULT_UA;
    const robots = ignoresRobots(deps, crawl) ? ALLOW_ALL : await robotsFor(deps, start.origin, ua);
    const scope = scopeOf(crawl);
    const normOpts = { ignoreQueryParameters: crawl.ignoreQueryParameters };
    const startUrl = normalizeUrl(crawl.url, normOpts) ?? crawl.url;

    const seeds = new Map<string, boolean>();
    if (crawl.sitemap !== 'skip') {
      const found = await discoverSitemapUrls(defaultSitemapSeeds(crawl.url, robots.sitemaps), deps.fetcher);
      for (const raw of found) {
        const norm = normalizeUrl(raw, normOpts);
        if (!norm) continue;
        const d = decideLink(norm, 0, scope);
        if (d.follow) seeds.set(norm, d.external);
      }
    }
    const ordered: Array<[string, boolean]> =
      crawl.sitemap === 'only' && seeds.size > 0 ? [...seeds] : [[startUrl, false], ...seeds];

    const fresh = await deps.queues.markSeen(job.id, ordered.map(([u]) => u));
    const external = new Map(ordered);
    const granted = await deps.store.reserveUrls(job.id, fresh.length);
    if (granted === 0) {
      await finishJob(deps, job.id, 'Nothing to crawl');
      return {};
    }
    await deps.queues.addPages(
      fresh.slice(0, granted).map((url): Omit<PageJobData, 'kind'> => ({ jobId: job.id, url, depth: 0, external: external.get(url) ?? false })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.addJobError(job.id, {
      url: crawl.url,
      error: message,
      code: err instanceof IceCrawlError ? err.code : null,
      kind: 'error',
    });
    await finishJob(deps, job.id, message);
  }
  return {};
}

async function page(
  deps: JobDeps,
  job: JobRecord,
  data: PageJobData,
  ctx: JobContext,
): Promise<{ delayMs?: number }> {
  const crawl = job.type === 'crawl' ? crawlRequestSchema.parse(job.request) : null;
  const stored = job.request as { scrapeOptions?: Record<string, unknown>; maxConcurrency?: number };
  const scrapeOptions = stored.scrapeOptions ?? {};

  let robots: RobotsRules = ALLOW_ALL;
  if (crawl && !ignoresRobots(deps, crawl)) {
    robots = await robotsFor(deps, new URL(data.url).origin, crawl.robotsUserAgent ?? DEFAULT_UA);
    if (!robots.allowed(data.url)) {
      await deps.store.addJobError(job.id, { url: data.url, error: 'Blocked by robots.txt', code: 'ROBOTS_DISALLOWED', kind: 'robots' });
      await completePage(deps, job, 'failed', { error: 'Blocked by robots.txt' });
      return {};
    }
  }

  const delaySeconds = crawl ? crawl.delay ?? Math.min(robots.crawlDelaySeconds ?? 0, deps.maxCrawlDelaySeconds ?? 30) : 0;
  const delayMs = Math.round(delaySeconds * 1000);
  const slot = await deps.queues.acquireSlot(job.id, {
    maxConcurrency: delayMs > 0 ? 1 : crawl ? crawl.maxConcurrency : stored.maxConcurrency,
    delayMs,
  });
  if (!slot.ok) return { delayMs: slot.retryInMs };

  try {
    const normalized = normalizeScrapeRequest({ ...scrapeOptions, url: data.url });
    let result: Awaited<ReturnType<typeof scrapeAndPersist>>;
    try {
      result = await scrapeAndPersist(deps, normalized, { apiKeyId: job.apiKeyId, jobId: job.id });
    } catch (err) {
      const e = err instanceof IceCrawlError ? err : new IceCrawlError('TARGET_ERROR', err instanceof Error ? err.message : String(err));
      if (RETRYABLE.has(e.code) && ctx.attemptsMade + 1 < ctx.maxAttempts) throw e;
      await deps.store.addJobError(job.id, { url: data.url, error: e.message, code: e.code, kind: 'error' });
      await completePage(deps, job, 'failed', { error: `${e.code}: ${e.message}` });
      return {};
    }

    const { payload, run } = result;
    if (payload.success !== true) {
      const message = String(payload.error ?? 'Scrape failed');
      await deps.store.addJobError(job.id, { url: data.url, error: message, code: String(payload.code ?? ''), kind: 'error' });
      await completePage(deps, job, 'failed', { error: message });
      return {};
    }

    if (crawl && !data.external && crawl.sitemap !== 'only') await discoverLinks(deps, job, crawl, data, run.links);
    await completePage(deps, job, 'completed', { page: payload.data });
    return {};
  } finally {
    await slot.release();
  }
}

async function discoverLinks(deps: JobDeps, job: JobRecord, crawl: CrawlRequest, data: PageJobData, links: string[]): Promise<void> {
  const scope = scopeOf(crawl);
  const candidates = new Map<string, boolean>();
  for (const raw of links) {
    const norm = normalizeUrl(raw, { ignoreQueryParameters: crawl.ignoreQueryParameters });
    if (!norm) continue;
    const d = decideLink(norm, data.depth + 1, scope);
    if (d.follow) candidates.set(norm, d.external);
  }
  if (candidates.size === 0) return;
  const fresh = await deps.queues.markSeen(job.id, [...candidates.keys()]);
  if (fresh.length === 0) return;
  const granted = await deps.store.reserveUrls(job.id, fresh.length);
  if (granted === 0) return;
  await deps.queues.addPages(
    fresh.slice(0, granted).map((url) => ({ jobId: job.id, url, depth: data.depth + 1, external: candidates.get(url) ?? false })),
  );
}
