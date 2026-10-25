import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  IceCrawlError,
  normalizeScrapeRequest,
  normalizeSearchRequest,
  type SearchNewsResult,
  type SearchResponse,
  type SearchResultTrust,
  type SearchWebResult,
} from '@icecrawl/core';
import { assertUrlAllowed, type SearchProvider } from '@icecrawl/engines';
import { scanForInjection, summarizeScan } from '@icecrawl/trust';
import { mapPool } from '../pool';
import { LLM_HELP, scrapeAndPersist, type ScrapeServiceDeps } from '../scrape-service';

export interface SearchRouteDeps extends ScrapeServiceDeps {
  search?: SearchProvider | null;
  searchMaxScrape?: number;
}

const SCRAPE_CONCURRENCY = 4;
const DOCUMENT_FIELDS = ['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'json', 'summary', 'actions', 'warning'] as const;

async function scrapeResult(
  deps: SearchRouteDeps,
  options: Record<string, unknown>,
  hit: SearchWebResult,
  apiKeyId: string | null,
): Promise<SearchWebResult> {
  try {
    const normalized = normalizeScrapeRequest({ ...options, url: hit.url });
    const { payload } = await scrapeAndPersist(deps, normalized, { apiKeyId });
    if (payload.success === true) {
      const data = payload.data as Record<string, unknown> & { metadata: SearchWebResult['metadata']; trust: SearchResultTrust };
      const content = Object.fromEntries(DOCUMENT_FIELDS.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]));
      return { ...hit, ...content, metadata: data.metadata, trust: { ...hit.trust, ...data.trust } };
    }
    return {
      ...hit,
      metadata: { sourceURL: hit.url, error: String(payload.error ?? 'Scrape failed') },
      trust: { ...hit.trust, ...(payload.trust as SearchResultTrust | undefined) },
    };
  } catch (err) {
    const message = err instanceof IceCrawlError ? `${err.code}: ${err.message}` : 'Scrape failed';
    return { ...hit, metadata: { sourceURL: hit.url, error: message } };
  }
}

export function registerSearchRoute(v2: FastifyInstance, deps: SearchRouteDeps): void {
  v2.post('/search', async (req) => {
    if (!deps.search) {
      throw new IceCrawlError(
        'SEARCH_NOT_CONFIGURED',
        'Search is not configured on this server. Set ICECRAWL_SEARXNG_URL to a SearXNG instance with the json format enabled.',
      );
    }
    const n = normalizeSearchRequest(req.body);
    const warnings = [...n.warnings];
    if (n.scrapeOptions) {
      const probe = normalizeScrapeRequest({ ...n.scrapeOptions, url: 'https://example.com/' });
      if ((probe.json || probe.formats.includes('summary')) && !deps.extraction?.llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);
    }

    const found = await deps.search.search({
      query: n.request.query,
      limit: n.request.limit,
      sources: n.sources,
      categories: n.categories,
      tbs: n.tbs,
      country: n.request.country,
      location: n.request.location,
      safe: n.request.safe,
      includeDomains: n.request.includeDomains,
      excludeDomains: n.request.excludeDomains,
      timeoutMs: n.request.timeout,
    });
    warnings.push(...found.warnings);

    const allowed = (url: string) => {
      try {
        assertUrlAllowed(url, deps.scraper.allowPrivateNetworks);
        return true;
      } catch {
        return false;
      }
    };
    let web: SearchWebResult[] = found.web.map((h) => ({ title: h.title, description: h.description, url: h.url }));
    let news: SearchNewsResult[] = found.news.map((h) => ({ title: h.title, snippet: h.snippet, url: h.url, ...(h.date ? { date: h.date } : {}) }));
    const images = found.images;
    if (n.request.ignoreInvalidURLs) {
      web = web.filter((r) => allowed(r.url));
      news = news.filter((r) => allowed(r.url));
    }

    // Titles and descriptions are written by third parties: scan them like page content.
    const mode = deps.scraper.injection ?? 'flag';
    let withheld = 0;
    const screen = <T extends { trust?: SearchResultTrust }>(items: T[], text: (item: T) => string): T[] => {
      if (mode === 'off') return items;
      return items.filter((item) => {
        const report = scanForInjection({ markdown: text(item) });
        if (!report.flagged) return true;
        if (mode === 'quarantine' && report.highest === 'high') {
          withheld++;
          return false;
        }
        (item as { trust?: SearchResultTrust }).trust = { ...item.trust, snippetInjection: summarizeScan(report) };
        return true;
      });
    };
    web = screen(web, (r) => `${r.title}\n${r.description}`);
    news = screen(news, (r) => `${r.title}\n${r.snippet}`);
    if (withheld > 0) warnings.push(`${withheld} result(s) were withheld because their title or description looked like a prompt-injection attempt.`);

    if (n.scrapeOptions) {
      const options = n.scrapeOptions;
      const cap = deps.searchMaxScrape ?? 20;
      const targets = web.slice(0, cap);
      if (web.length > targets.length) warnings.push(`Only the first ${targets.length} results were scraped (ICECRAWL_SEARCH_MAX_SCRAPE).`);
      const scraped = await mapPool(targets, SCRAPE_CONCURRENCY, (hit) => scrapeResult(deps, options, hit, req.apiKeyId));
      web = [...scraped, ...web.slice(targets.length)];
    }

    const data: SearchResponse['data'] = {};
    if (n.sources.includes('web')) data.web = web;
    if (n.sources.includes('images')) data.images = images;
    if (n.sources.includes('news')) data.news = news;
    const response: SearchResponse = {
      success: true,
      id: randomUUID(),
      creditsUsed: web.length + images.length + news.length,
      data,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    };
    return response;
  });
}
