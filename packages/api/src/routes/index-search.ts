import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IceCrawlError, type ScanSummary } from '@icecrawl/core';
import { scanForInjection, summarizeScan } from '@icecrawl/trust';
import type { DataProvider } from '../index-search/providers';
import type { Store } from '../store/types';

export interface IndexRouteDeps {
  store: Store;
  providers?: readonly DataProvider[];
  injection?: 'off' | 'flag' | 'quarantine';
}

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  sources: z.array(z.string()).min(1).max(20).optional(),
  urlPrefix: z.string().url().optional(),
  timeout: z.number().int().min(1000).max(60_000).default(15_000),
});

export interface IndexResult {
  /** `scrapes` or the name of a provider. */
  source: string;
  title: string | null;
  url: string;
  snippet: string;
  score?: number;
  /** For `scrapes` results: the scrape and receipt id (the page can be verified). */
  receiptId?: string;
  createdAt?: string;
  trust?: { snippetInjection?: ScanSummary };
}

export function registerIndexRoutes(v2: FastifyInstance, deps: IndexRouteDeps): void {
  const providers = deps.providers ?? [];

  v2.get('/index/providers', async () => ({
    success: true,
    data: {
      providers: [
        { name: 'scrapes', description: 'Pages this API key has scraped successfully (full-text search; the latest copy of each URL).' },
        ...providers.map((p) => ({ name: p.name, description: p.description })),
      ],
    },
  }));

  v2.post('/index/search', async (req) => {
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new IceCrawlError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const b = parsed.data;
    const available = ['scrapes', ...providers.map((p) => p.name)];
    const wanted = b.sources ?? available;
    const unknown = wanted.filter((s) => !available.includes(s));
    if (unknown.length > 0) throw new IceCrawlError('VALIDATION', `Unknown source(s): ${unknown.join(', ')}. Available: ${available.join(', ')}.`);

    const warnings: string[] = [];
    const results: IndexResult[] = [];
    const jobs: Array<Promise<void>> = [];
    if (wanted.includes('scrapes')) {
      jobs.push(
        deps.store.searchScrapes(req.apiKeyId, b.query, b.limit, b.urlPrefix).then((hits) => {
          for (const h of hits) results.push({ source: 'scrapes', title: h.title, url: h.url, snippet: h.snippet, score: h.score, receiptId: h.scrapeId, createdAt: h.createdAt });
        }),
      );
    }
    // providers run side by side; one failing only costs its own results
    const providerResults = new Map<string, IndexResult[]>();
    for (const p of providers.filter((x) => wanted.includes(x.name))) {
      jobs.push(
        p.search({ query: b.query, limit: b.limit, timeoutMs: b.timeout }).then(
          (hits) => void providerResults.set(p.name, hits.map((h) => ({ source: p.name, title: h.title || null, url: h.url, snippet: h.snippet }))),
          (err) => void warnings.push(`Source "${p.name}" failed${err instanceof IceCrawlError ? ` (${err.code}: ${err.message})` : ''}.`),
        ),
      );
    }
    await Promise.all(jobs);
    for (const p of providers) results.push(...(providerResults.get(p.name) ?? []));

    // stored page text and provider text are written by third parties: scan the snippets like search results
    const mode = deps.injection ?? 'flag';
    let withheld = 0;
    const screened =
      mode === 'off'
        ? results
        : results.filter((r) => {
            const report = scanForInjection({ markdown: `${r.title ?? ''}\n${r.snippet}` });
            if (!report.flagged) return true;
            if (mode === 'quarantine' && report.highest === 'high') {
              withheld++;
              return false;
            }
            r.trust = { snippetInjection: summarizeScan(report) };
            return true;
          });
    if (withheld > 0) warnings.push(`${withheld} result(s) were withheld because their text looked like a prompt-injection attempt.`);
    return { success: true, id: randomUUID(), data: { results: screened }, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
  });
}
