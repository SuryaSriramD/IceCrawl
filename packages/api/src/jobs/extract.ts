import {
  IceCrawlError,
  isUrlPattern,
  normalizeMapRequest,
  normalizeScrapeRequest,
  patternPrefix,
  type ExtractSourceInfo,
  type Verdict,
} from '@icecrawl/core';
import { attributeSources, enforceGrounding, extractStructured } from '@icecrawl/extract';
import { mapPool } from '../pool';
import { LLM_HELP, scrapeAndPersist } from '../scrape-service';
import type { JobRecord } from '../store/types';
import { mapSite } from './map';
import type { JobDeps } from './processor';

const SCRAPE_CONCURRENCY = 3;
const SEARCH_RESULTS = 3;
const DISCOVERY_FACTOR = 5;

export interface StoredExtract {
  urls: string[];
  prompt?: string;
  schema?: Record<string, unknown>;
  enableWebSearch: boolean;
  ignoreSitemap: boolean;
  includeSubdomains: boolean;
  showSources: boolean;
  scrapeOptions: Record<string, unknown>;
}

interface Page extends ExtractSourceInfo {
  markdown: string;
}
interface Skipped {
  url: string;
  error: string;
  code: string;
}

async function expandPattern(deps: JobDeps, pattern: string, req: StoredExtract, maxPages: number): Promise<string[]> {
  const start = new URL(patternPrefix(pattern));
  const { request } = normalizeMapRequest({
    url: start.href,
    sitemap: req.ignoreSitemap ? 'skip' : 'include',
    includeSubdomains: req.includeSubdomains,
    limit: Math.max(100, maxPages * DISCOVERY_FACTOR),
  });
  const links = await mapSite({ engines: deps.engines, scraper: deps.scraper, fetcher: deps.fetcher }, request);
  return links.map((l) => l.url).filter((u) => new URL(u).pathname.startsWith(start.pathname));
}

async function collectUrls(deps: JobDeps, req: StoredExtract, maxPages: number, warnings: string[]): Promise<string[]> {
  const urls: string[] = [];
  let skipped = 0;
  const add = (u: string) => {
    if (urls.includes(u)) return;
    if (urls.length < maxPages) urls.push(u);
    else skipped++;
  };
  for (const entry of req.urls) {
    if (!isUrlPattern(entry)) {
      add(entry);
      continue;
    }
    try {
      (await expandPattern(deps, entry, req, maxPages)).forEach(add);
    } catch (err) {
      warnings.push(`Could not expand ${entry}: ${err instanceof IceCrawlError ? err.message : 'discovery failed'}.`);
    }
  }
  if (req.enableWebSearch) {
    if (!deps.search) warnings.push('enableWebSearch was ignored: search is not configured on this server.');
    else if (!req.prompt) warnings.push('enableWebSearch was ignored: it needs a prompt to search for.');
    else {
      try {
        const found = await deps.search.search({ query: req.prompt.slice(0, 500), limit: SEARCH_RESULTS, sources: ['web'], categories: [], timeoutMs: 30_000 });
        found.web.forEach((h) => add(h.url));
      } catch (err) {
        warnings.push(`Web search failed: ${err instanceof IceCrawlError ? err.message : 'unknown error'}.`);
      }
    }
  }
  if (skipped > 0) warnings.push(`Only the first ${maxPages} pages were read (ICECRAWL_EXTRACT_MAX_PAGES); ${skipped} more were skipped.`);
  return urls;
}

async function readPage(deps: JobDeps, req: StoredExtract, url: string, job: JobRecord): Promise<{ page: Page } | { skipped: Skipped }> {
  try {
    const normalized = normalizeScrapeRequest({ ...req.scrapeOptions, formats: ['markdown'], url });
    const { payload } = await scrapeAndPersist(deps, normalized, { apiKeyId: job.apiKeyId, jobId: job.id });
    if (payload.success === true) {
      const data = payload.data as {
        markdown: string;
        metadata: { url: string };
        trust: { receiptId: string; verdict: Verdict; injection?: { flagged: boolean } };
      };
      return {
        page: {
          url: data.metadata.url,
          markdown: data.markdown,
          receiptId: data.trust.receiptId,
          verdict: data.trust.verdict,
          injectionFlagged: data.trust.injection?.flagged === true,
        },
      };
    }
    return { skipped: { url, error: String(payload.error ?? 'Scrape failed'), code: String(payload.code ?? 'TARGET_ERROR') } };
  } catch (err) {
    const e = err instanceof IceCrawlError ? err : new IceCrawlError('TARGET_ERROR', 'The page could not be read.');
    return { skipped: { url, error: e.message, code: e.code } };
  }
}

async function run(deps: JobDeps, job: JobRecord): Promise<{ stored: Record<string, unknown>; tokensUsed: number }> {
  const llm = deps.extraction?.llm;
  if (!deps.extraction || !llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);
  const req = job.request as unknown as StoredExtract;
  const warnings: string[] = [];

  const urls = await collectUrls(deps, req, deps.extractMaxPages ?? 20, warnings);
  const outcomes = await mapPool(urls, SCRAPE_CONCURRENCY, (url) => readPage(deps, req, url, job));
  const pages: Page[] = [];
  const skipped: Skipped[] = [];
  for (const o of outcomes) {
    if ('page' in o) pages.push(o.page);
    else skipped.push(o.skipped);
  }
  for (const s of skipped) await deps.store.addJobError(job.id, { url: s.url, error: s.error, code: s.code, kind: 'error' });
  if (pages.length === 0) {
    const why = skipped.slice(0, 3).map((s) => `${s.url} (${s.code})`).join(', ');
    throw new IceCrawlError('EXTRACTION_FAILED', `None of the pages could be read${why ? `: ${why}` : ''}.`);
  }

  const r = await extractStructured(
    { llm, maxInputChars: deps.extraction.maxInputChars, maxOutputTokens: deps.extraction.maxOutputTokens },
    { sources: pages.map((p) => ({ url: p.url, markdown: p.markdown })), prompt: req.prompt, schema: req.schema },
  );
  enforceGrounding(r.report, deps.scraper.strict);
  return {
    tokensUsed: r.tokensUsed,
    stored: {
      data: r.data,
      trust: {
        extraction: r.report,
        sources: pages.map(({ url, receiptId, verdict, injectionFlagged }) => ({ url, receiptId, verdict, injectionFlagged })),
      },
      ...(req.showSources ? { sources: attributeSources(r.report.grounding.fields, pages.map((p) => p.url)) } : {}),
      ...(skipped.length > 0 ? { skipped: skipped.map((s) => ({ url: s.url, error: s.error })) } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    },
  };
}

export async function processExtractJob(deps: JobDeps, job: JobRecord): Promise<void> {
  try {
    const { stored, tokensUsed } = await run(deps, job);
    await deps.store.saveJobResult(job.id, stored, tokensUsed);
    await deps.store.finalizeJob(job.id, 'completed');
  } catch (err) {
    if (!(err instanceof IceCrawlError)) console.error('[icecrawl] extract job failed:', err);
    const e = err instanceof IceCrawlError ? err : new IceCrawlError('INTERNAL', 'The extraction failed unexpectedly.');
    await deps.store.saveJobResult(job.id, { error: e.message, code: e.code }, null);
    await deps.store.finalizeJob(job.id, 'failed');
  }
}
