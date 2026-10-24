import { IceCrawlError, normalizeScrapeRequest, type MapRequest } from '@icecrawl/core';
import {
  defaultSitemapSeeds,
  discoverSitemapUrls,
  hostRelation,
  isAssetPath,
  loadRobots,
  normalizeUrl,
  type Fetcher,
} from '@icecrawl/crawler';
import type { Engine } from '@icecrawl/engines';
import { runScrape, type ScraperConfig } from '@icecrawl/scraper';

export interface MapDeps {
  engines: readonly Engine[];
  scraper: ScraperConfig;
  fetcher: Fetcher;
}

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
}

export function rankBySearch(urls: string[], search: string): string[] {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return urls;
  return urls
    .map((url, index) => ({ url, index, score: tokens.filter((t) => url.toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.url);
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(fallback)),
    );
  });

export async function mapSite(deps: MapDeps, r: MapRequest): Promise<MapLink[]> {
  const start = new URL(r.url);
  const timeout = r.timeout ?? 30_000;
  const found = new Map<string, MapLink>();

  const accept = (raw: string): string | null => {
    const norm = normalizeUrl(raw, { ignoreQueryParameters: r.ignoreQueryParameters });
    if (!norm) return null;
    const u = new URL(norm);
    const rel = hostRelation(u.hostname, start.hostname);
    if (rel === 'external' || (rel === 'subdomain' && !r.includeSubdomains)) return null;
    if (isAssetPath(u.pathname)) return null;
    return norm;
  };
  const add = (raw: string, extra: Partial<MapLink> = {}) => {
    const norm = accept(raw);
    if (norm && !found.has(norm)) found.set(norm, { url: norm, ...extra });
  };

  let scrapeError: unknown = null;
  if (r.sitemap !== 'only') {
    try {
      const normalized = normalizeScrapeRequest({ url: r.url, formats: ['links'], timeout: Math.min(timeout, 300_000), onlyMainContent: false });
      const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
      if (!run.accepted) throw new IceCrawlError('TARGET_ERROR', `Could not read the start page (${run.verdict})`);
      add(r.url, { ...(run.title ? { title: run.title } : {}), ...(run.description ? { description: run.description } : {}) });
      for (const link of run.links) add(link);
    } catch (err) {
      scrapeError = err;
    }
  }

  if (r.sitemap !== 'skip') {
    const urls = await withTimeout(
      (async () => {
        const robots = await loadRobots(start.origin, deps.fetcher, 'IceCrawl');
        return discoverSitemapUrls(defaultSitemapSeeds(r.url, robots.sitemaps), deps.fetcher);
      })(),
      timeout,
      [] as string[],
    );
    for (const u of urls) add(u);
  }

  if (found.size === 0) {
    throw scrapeError instanceof IceCrawlError
      ? scrapeError
      : new IceCrawlError('TARGET_ERROR', 'No links could be discovered for this URL.');
  }

  let ordered = [...found.values()];
  if (r.search) {
    const keep = new Set(rankBySearch(ordered.map((l) => l.url), r.search));
    const rank = rankBySearch(ordered.map((l) => l.url), r.search);
    ordered = rank.map((u) => found.get(u)!).filter((l) => keep.has(l.url));
  }
  return ordered.slice(0, r.limit);
}
