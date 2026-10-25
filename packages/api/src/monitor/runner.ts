import { createHash, randomUUID } from 'node:crypto';
import { createPatch } from 'diff';
import { IceCrawlError, normalizeMapRequest, normalizeScrapeRequest } from '@icecrawl/core';
import type { MonitorStore, CheckSummary, MonitorRecord, MonitorTarget, PageStatus } from './types';
import type { JobDeps } from '../jobs/processor';
import { mapSite } from '../jobs/map';
import { mapPool } from '../pool';
import { scrapeAndPersist } from '../scrape-service';

const SCRAPE_CONCURRENCY = 3;
const TBS = { '5m': 'qdr:h', '15m': 'qdr:h', '1h': 'qdr:h', '6h': 'qdr:d', '24h': 'qdr:d', '7d': 'qdr:w' } as const;

export interface MonitorRunDeps extends JobDeps {
  monitors: MonitorStore;
  /** Upper bound of pages one check reads. */
  monitorMaxPages?: number;
}

interface Resolved {
  url: string;
  targetId: string;
  scrapeOptions: Record<string, unknown>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hostMatches = (url: string, domains: string[]) => {
  const host = new URL(url).hostname;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
};

async function resolveTarget(deps: MonitorRunDeps, t: MonitorTarget): Promise<Resolved[]> {
  if (t.type === 'scrape') return t.urls.map((url) => ({ url, targetId: t.id, scrapeOptions: t.scrapeOptions ?? {} }));
  if (t.type === 'crawl') {
    const { request } = normalizeMapRequest({ url: t.url, sitemap: 'include', limit: 20, ...(t.crawlOptions ?? {}) });
    const links = await mapSite({ engines: deps.engines, scraper: deps.scraper, fetcher: deps.fetcher }, request);
    return links.map((l) => ({ url: l.url, targetId: t.id, scrapeOptions: t.scrapeOptions ?? {} }));
  }
  if (!deps.search) throw new IceCrawlError('SEARCH_NOT_CONFIGURED', 'Search is not configured on this server, so search targets cannot run.');
  const out = new Map<string, Resolved>();
  for (const query of t.queries) {
    const found = await deps.search.search({ query, limit: t.maxResults, sources: ['web'], categories: [], tbs: TBS[t.searchWindow], timeoutMs: 30_000 });
    for (const hit of found.web) {
      if (t.includeDomains?.length && !hostMatches(hit.url, t.includeDomains)) continue;
      if (t.excludeDomains?.length && hostMatches(hit.url, t.excludeDomains)) continue;
      if (out.size < t.maxResults) out.set(hit.url, { url: hit.url, targetId: t.id, scrapeOptions: {} });
    }
  }
  return [...out.values()];
}

async function queueWebhook(deps: MonitorRunDeps, m: MonitorRecord, checkId: string, type: 'monitor.page' | 'monitor.check.completed', data: unknown[]) {
  const hook = m.webhook;
  if (!hook || !(hook.events ?? ['monitor.page', 'monitor.check.completed']).includes(type)) return;
  const webhookId = randomUUID();
  await deps.queues.addWebhook({
    jobId: checkId,
    webhookId,
    url: hook.url,
    headers: hook.headers ?? {},
    body: JSON.stringify({ success: true, type, id: checkId, webhookId, data, metadata: hook.metadata ?? {} }),
  });
}

/** Runs one queued check: reads every watched page, compares it with the last good copy and records what changed. */
export async function processMonitorCheck(deps: MonitorRunDeps, checkId: string): Promise<void> {
  const store = deps.monitors;
  const check = await store.findCheck(checkId);
  if (!check || check.status !== 'queued') return;
  const monitor = await store.getMonitor(check.monitorId);
  if (!monitor) {
    await store.updateCheck(check.id, { status: 'failed', error: 'The monitor no longer exists.', finishedAt: new Date().toISOString() });
    return;
  }
  const started = new Date();
  await store.updateCheck(check.id, { status: 'running', startedAt: started.toISOString() });
  await store.updateMonitor(monitor.id, { currentCheckId: check.id, lastRunAt: started.toISOString() });

  const summary: CheckSummary = { totalPages: 0, same: 0, changed: 0, new: 0, removed: 0, error: 0 };
  const targetResults: Array<Record<string, unknown>> = [];
  let fatal: string | null = null;
  try {
    const baselines = new Map((await store.listBaselines(monitor.id)).map((b) => [b.url, b]));
    const maxPages = deps.monitorMaxPages ?? 50;
    const resolved = new Map<string, Resolved>();
    const failedTargets = new Set<string>();
    for (const t of monitor.targets) {
      try {
        const list = await resolveTarget(deps, t);
        for (const r of list) if (!resolved.has(r.url) && resolved.size < maxPages) resolved.set(r.url, r);
        targetResults.push({ targetId: t.id, type: t.type, status: 'ok', pages: list.length });
      } catch (err) {
        failedTargets.add(t.id);
        targetResults.push({ targetId: t.id, type: t.type, status: 'error', error: err instanceof IceCrawlError ? err.message : 'The target could not be resolved.' });
      }
    }

    const record = async (r: Omit<Parameters<MonitorStore['addPage']>[0], 'id' | 'checkId'>) => {
      summary.totalPages++;
      summary[r.status]++;
      const page = { id: randomUUID(), checkId: check.id, ...r };
      await store.addPage(page);
      if (r.status !== 'same') await queueWebhook(deps, monitor, check.id, 'monitor.page', [{ monitorId: monitor.id, checkId: check.id, url: r.url, status: r.status, currentScrapeId: r.currentScrapeId, previousScrapeId: r.previousScrapeId, diff: r.diff }]);
    };

    await mapPool([...resolved.values()], SCRAPE_CONCURRENCY, async (r) => {
      const before = baselines.get(r.url);
      const base = { targetId: r.targetId, url: r.url, previousScrapeId: before?.scrapeId ?? null, metadata: null as Record<string, unknown> | null };
      try {
        const normalized = normalizeScrapeRequest({ ...r.scrapeOptions, formats: ['markdown'], url: r.url });
        const { payload } = await scrapeAndPersist(deps, normalized, { apiKeyId: monitor.apiKeyId });
        if (payload.success !== true) {
          // a blocked, captcha or quarantined page is an error, never a change: the last good copy stays the baseline
          const trust = payload.trust as { receiptId?: string } | undefined;
          await record({ ...base, status: 'error', currentScrapeId: trust?.receiptId ?? null, statusCode: null, error: `${String(payload.code ?? 'TARGET_ERROR')}: ${String(payload.error ?? 'The page could not be read.')}`, diff: null });
          return;
        }
        const data = payload.data as { markdown: string; metadata: { statusCode?: number }; trust: { receiptId: string } };
        const hash = sha(data.markdown);
        const scrapeId = data.trust.receiptId;
        const common = { ...base, currentScrapeId: scrapeId, statusCode: data.metadata.statusCode ?? null, error: null };
        if (!before) {
          await record({ ...common, status: 'new', diff: null });
        } else if (before.contentHash === hash) {
          await record({ ...common, status: 'same', diff: null });
        } else {
          await record({ ...common, status: 'changed', diff: { text: createPatch(r.url, before.markdown, data.markdown, 'previous', 'current', { context: 3 }) } });
        }
        if (!before || before.contentHash !== hash) {
          await store.upsertBaseline({ monitorId: monitor.id, url: r.url, targetId: r.targetId, contentHash: hash, markdown: data.markdown, scrapeId });
        }
      } catch (err) {
        await record({ ...base, status: 'error', currentScrapeId: null, statusCode: null, error: err instanceof IceCrawlError ? `${err.code}: ${err.message}` : 'The page could not be read.', diff: null });
      }
    });

    const gone = [...baselines.values()].filter((b) => !resolved.has(b.url) && !failedTargets.has(b.targetId) && !monitor.targets.some((t) => t.id === b.targetId && t.type === 'search'));
    for (const b of gone) {
      await record({ targetId: b.targetId, url: b.url, status: 'removed' satisfies PageStatus, previousScrapeId: b.scrapeId, currentScrapeId: null, statusCode: null, error: null, metadata: null, diff: null });
    }
    // search results come and go by nature: forget the ones that dropped out (a result that returns later is new again)
    const dropped = [...baselines.values()].filter((b) => !resolved.has(b.url) && !failedTargets.has(b.targetId) && monitor.targets.some((t) => t.id === b.targetId && t.type === 'search'));
    await store.deleteBaselines(monitor.id, [...gone, ...dropped].map((b) => b.url));
  } catch (err) {
    fatal = err instanceof IceCrawlError ? err.message : 'The check failed unexpectedly.';
    if (!(err instanceof IceCrawlError)) console.error('[icecrawl] monitor check failed:', err);
  }

  const targetErrors = targetResults.some((t) => t.status === 'error');
  const nothingRead = summary.totalPages === summary.error && (summary.totalPages > 0 || targetErrors);
  const status = fatal || nothingRead ? 'failed' : summary.error > 0 || targetErrors ? 'partial' : 'completed';
  const finishedAt = new Date().toISOString();
  await store.updateCheck(check.id, { status, finishedAt, summary, targetResults, error: fatal });
  await store.updateMonitor(monitor.id, { currentCheckId: null, lastCheckSummary: summary });
  await queueWebhook(deps, monitor, check.id, 'monitor.check.completed', [{ monitorId: monitor.id, checkId: check.id, status, summary }]);
}
