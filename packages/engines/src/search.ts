import { IceCrawlError, type SearchCategory, type SearchSource } from '@icecrawl/core';

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export interface ImageHit {
  title: string;
  imageUrl: string;
  url: string;
  imageWidth?: number;
  imageHeight?: number;
}

export interface NewsHit {
  title: string;
  snippet: string;
  url: string;
  date?: string;
}

export interface SearchQuery {
  query: string;
  limit: number;
  sources: SearchSource[];
  categories: SearchCategory[];
  tbs?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeoutMs: number;
}

export interface SearchResults {
  web: SearchHit[];
  images: ImageHit[];
  news: NewsHit[];
  warnings: string[];
}

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery): Promise<SearchResults>;
}

export interface SearxngOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Upper bound on result pages requested per source (default 5). */
  maxPages?: number;
}

type TimeRange = 'day' | 'week' | 'month' | 'year';

const RANGES: Record<string, TimeRange> = { 'qdr:d': 'day', 'qdr:w': 'week', 'qdr:m': 'month', 'qdr:y': 'year' };

/** Reads Firecrawl's `tbs` value; SearXNG only has day/week/month/year. */
export function parseTbs(tbs: string | undefined): { timeRange?: TimeRange; warnings: string[] } {
  if (!tbs) return { warnings: [] };
  const warnings: string[] = [];
  let timeRange: TimeRange | undefined;
  for (const part of tbs.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (part === 'qdr:h') {
      timeRange = 'day';
      warnings.push('qdr:h (past hour) was widened to the past day: SearXNG has no hourly filter.');
    } else if (RANGES[part]) {
      timeRange = RANGES[part];
    } else {
      warnings.push(`Time filter "${part}" is not supported by SearXNG and was ignored.`);
    }
  }
  return { ...(timeRange ? { timeRange } : {}), warnings };
}

export function hostMatches(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

interface SearxResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  img_src?: unknown;
  resolution?: unknown;
  publishedDate?: unknown;
}

interface SearxResponse {
  results?: SearxResult[];
  unresponsive_engines?: Array<[string, string]>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isHttp = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v);

const toWeb = (r: SearxResult): SearchHit | null =>
  isHttp(r.url) ? { url: r.url, title: str(r.title), description: str(r.content) } : null;

const toImage = (r: SearxResult): ImageHit | null => {
  if (!isHttp(r.img_src)) return null;
  const dims = /^(\d+)\s*[x×]\s*(\d+)$/.exec(str(r.resolution));
  return {
    title: str(r.title),
    imageUrl: r.img_src,
    url: isHttp(r.url) ? r.url : r.img_src,
    ...(dims ? { imageWidth: Number(dims[1]), imageHeight: Number(dims[2]) } : {}),
  };
};

const toNews = (r: SearxResult): NewsHit | null =>
  isHttp(r.url) ? { title: str(r.title), snippet: str(r.content), url: r.url, ...(str(r.publishedDate) ? { date: str(r.publishedDate) } : {}) } : null;

export function createSearxngProvider(o: SearxngOptions): SearchProvider {
  const base = o.baseUrl.replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const maxPages = o.maxPages ?? 5;

  async function fetchPage(params: URLSearchParams, timeoutMs: number): Promise<SearxResponse> {
    let res: Response;
    try {
      res = await doFetch(`${base}/search?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new IceCrawlError(
        timedOut ? 'TIMEOUT' : 'TARGET_ERROR',
        timedOut
          ? `The search provider did not answer within ${timeoutMs} ms`
          : `Could not reach the search provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 403) {
      throw new IceCrawlError(
        'TARGET_ERROR',
        'The search provider answered 403. Enable the json format in SearXNG (search.formats in settings.yml) and allow this client (server.limiter).',
      );
    }
    if (!res.ok) throw new IceCrawlError('TARGET_ERROR', `The search provider answered HTTP ${res.status}`);
    try {
      return (await res.json()) as SearxResponse;
    } catch {
      throw new IceCrawlError('TARGET_ERROR', 'The search provider did not return JSON. Is the json format enabled in SearXNG?');
    }
  }

  async function collect<T extends { url: string }>(
    q: SearchQuery,
    p: { query: string; categories: string[]; timeRange?: TimeRange },
    convert: (r: SearxResult) => T | null,
    keyOf: (t: T) => string,
  ): Promise<{ items: T[]; notes: string[] }> {
    const seen = new Set<string>();
    const items: T[] = [];
    const notes: string[] = [];
    for (let pageno = 1; pageno <= maxPages && items.length < q.limit; pageno++) {
      const params = new URLSearchParams({ q: p.query, format: 'json', categories: p.categories.join(','), pageno: String(pageno) });
      if (p.timeRange) params.set('time_range', p.timeRange);
      if (q.safe) params.set('safesearch', '2');
      const body = await fetchPage(params, q.timeoutMs);
      for (const [engine, reason] of body.unresponsive_engines ?? []) notes.push(`${engine} (${reason})`);
      const results = body.results ?? [];
      if (results.length === 0) break;
      for (const r of results) {
        const item = convert(r);
        if (!item || seen.has(keyOf(item))) continue;
        if (q.includeDomains?.length && !hostMatches(item.url, q.includeDomains)) continue;
        if (q.excludeDomains?.length && hostMatches(item.url, q.excludeDomains)) continue;
        seen.add(keyOf(item));
        items.push(item);
        if (items.length >= q.limit) break;
      }
    }
    return { items, notes };
  }

  const none = <T>(): Promise<{ items: T[]; notes: string[] }> => Promise.resolve({ items: [], notes: [] });

  return {
    name: 'searxng',
    async search(q) {
      const warnings: string[] = [];
      const range = parseTbs(q.tbs);
      warnings.push(...range.warnings);
      if (q.country || q.location) warnings.push('country and location are not supported by the SearXNG adapter and were ignored.');
      const pdf = q.categories.includes('pdf');
      if (pdf) warnings.push('The pdf category adds "filetype:pdf" to the query; search engines that ignore it return other results too.');
      const general = ['general', ...(q.categories.includes('developer') ? ['it'] : []), ...(q.categories.includes('research') ? ['science'] : [])];
      const timeRange = range.timeRange;

      const [web, images, news] = await Promise.all([
        q.sources.includes('web')
          ? collect(q, { query: pdf ? `${q.query} filetype:pdf` : q.query, categories: general, timeRange }, toWeb, (h) => h.url)
          : none<SearchHit>(),
        q.sources.includes('images')
          ? collect(q, { query: q.query, categories: ['images'], timeRange }, toImage, (h) => h.imageUrl)
          : none<ImageHit>(),
        q.sources.includes('news')
          ? collect(q, { query: q.query, categories: ['news'], timeRange }, toNews, (h) => h.url)
          : none<NewsHit>(),
      ]);

      const notes = [...new Set([...web.notes, ...images.notes, ...news.notes])];
      const short =
        (q.sources.includes('web') && web.items.length < q.limit) ||
        (q.sources.includes('images') && images.items.length < q.limit) ||
        (q.sources.includes('news') && news.items.length < q.limit);
      if (notes.length > 0 && short) {
        warnings.push(`Some search engines did not answer (${notes.slice(0, 5).join('; ')}); results may be incomplete.`);
      }
      return { web: web.items, images: images.items, news: news.items, warnings };
    },
  };
}
