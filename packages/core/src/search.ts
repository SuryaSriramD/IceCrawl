import { z } from 'zod';
import { IceCrawlError } from './errors';
import { normalizeScrapeRequest, scrapeOptionsSchema } from './scrape';

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

// Validated label by label: a single backtracking regex on a hostile 1 MB string would be a ReDoS.
const hostname = z
  .string()
  .max(253)
  .refine(
    (h) => h.length > 0 && h.split('.').every((l) => /^[a-z0-9-]{1,63}$/i.test(l) && !l.startsWith('-') && !l.endsWith('-')),
    'must be a hostname without protocol or path',
  )
  .transform((h) => h.toLowerCase());

const entry = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).default(10),
  sources: z.array(entry).max(10).default(['web']),
  categories: z.array(entry).max(10).default([]),
  tbs: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  country: z.string().max(10).optional(),
  safe: z.boolean().optional(),
  timeout: z.number().int().min(1000).max(300_000).default(60_000),
  includeDomains: z.array(hostname).max(100).optional(),
  excludeDomains: z.array(hostname).max(100).optional(),
  ignoreInvalidURLs: z.boolean().default(false),
  scrapeOptions: scrapeOptionsSchema.optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchOptions = Omit<z.input<typeof searchRequestSchema>, 'query'>;

export type SearchSource = 'web' | 'images' | 'news';
export type SearchCategory = 'developer' | 'research' | 'pdf';

const SOURCES: readonly string[] = ['web', 'images', 'news'];
const CATEGORIES: readonly string[] = ['developer', 'research', 'pdf'];
const KNOWN_KEYS = new Set(Object.keys(searchRequestSchema.shape));

const typeOf = (e: string | { type: string }) => (typeof e === 'string' ? e : e.type);

export interface NormalizedSearch {
  request: SearchRequest;
  sources: SearchSource[];
  categories: SearchCategory[];
  tbs?: string;
  /** Present only when the caller asked for result content (scrapeOptions.formats is non-empty). */
  scrapeOptions: Record<string, unknown> | null;
  warnings: string[];
}

export function normalizeSearchRequest(input: unknown): NormalizedSearch {
  const parsed = searchRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', issues(parsed.error));
  const request = parsed.data;
  if (request.includeDomains && request.excludeDomains) {
    throw new IceCrawlError('VALIDATION', 'includeDomains cannot be used together with excludeDomains');
  }
  const warnings: string[] = [];

  const sources: SearchSource[] = [];
  const skippedSources: string[] = [];
  for (const e of request.sources) {
    const t = typeOf(e);
    if (SOURCES.includes(t)) {
      if (!sources.includes(t as SearchSource)) sources.push(t as SearchSource);
    } else skippedSources.push(t);
  }
  if (skippedSources.length > 0) warnings.push(`Unsupported search sources ignored: ${skippedSources.join(', ')}.`);
  if (sources.length === 0) sources.push('web');

  const categories: SearchCategory[] = [];
  const skippedCategories: string[] = [];
  for (const e of request.categories) {
    const t = typeOf(e);
    if (CATEGORIES.includes(t)) {
      if (!categories.includes(t as SearchCategory)) categories.push(t as SearchCategory);
    } else skippedCategories.push(t);
  }
  if (skippedCategories.length > 0) warnings.push(`Unsupported search categories ignored: ${skippedCategories.join(', ')}.`);

  const webEntry = request.sources.find((e) => typeof e !== 'string' && e.type === 'web');
  const sourceTbs = webEntry && typeof webEntry !== 'string' && typeof webEntry.tbs === 'string' ? webEntry.tbs : undefined;
  const tbs = request.tbs ?? sourceTbs;

  let scrapeOptions: Record<string, unknown> | null = null;
  const formats = request.scrapeOptions?.formats;
  if (request.scrapeOptions && Array.isArray(formats) && formats.length > 0) {
    scrapeOptions = request.scrapeOptions as Record<string, unknown>;
    warnings.push(...normalizeScrapeRequest({ ...scrapeOptions, url: 'https://example.com/' }).warnings);
  }

  const extras =
    typeof input === 'object' && input !== null ? Object.keys(input).filter((k) => !KNOWN_KEYS.has(k)) : [];
  if (extras.length > 0) warnings.push(`Ignored unsupported options: ${extras.join(', ')}.`);

  return { request, sources, categories, ...(tbs ? { tbs } : {}), scrapeOptions, warnings };
}
