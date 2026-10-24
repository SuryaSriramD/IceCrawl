import { z } from 'zod';
import { IceCrawlError } from './errors';
import { normalizeScrapeRequest, scrapeRequestSchema } from './scrape';

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
const unknownKeys = (input: unknown, known: Set<string>): string[] =>
  typeof input === 'object' && input !== null ? Object.keys(input).filter((k) => !known.has(k)) : [];

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be an http or https URL');

export const webhookSchema = z.object({
  url: httpUrl,
  headers: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  events: z.array(z.enum(['completed', 'page', 'failed', 'started'])).optional(),
});
export type WebhookConfig = z.infer<typeof webhookSchema>;

const regexList = z
  .array(z.string().max(500))
  .max(100)
  .superRefine((list, ctx) => {
    list.forEach((pattern, i) => {
      try {
        new RegExp(pattern);
      } catch {
        ctx.addIssue({ code: 'custom', path: [i], message: `invalid regular expression: ${pattern}` });
      }
    });
  });

const scrapeOptionsSchema = scrapeRequestSchema.omit({ url: true }).partial().passthrough();

export const crawlRequestSchema = z.object({
  url: httpUrl,
  prompt: z.string().max(10000).optional(),
  includePaths: regexList.optional(),
  excludePaths: regexList.optional(),
  maxDiscoveryDepth: z.number().int().min(0).max(1000).optional(),
  sitemap: z.enum(['skip', 'include', 'only']).default('include'),
  ignoreQueryParameters: z.boolean().default(false),
  regexOnFullURL: z.boolean().default(false),
  limit: z.number().int().min(1).max(1_000_000).default(10_000),
  crawlEntireDomain: z.boolean().default(false),
  allowExternalLinks: z.boolean().default(false),
  allowSubdomains: z.boolean().default(false),
  ignoreRobotsTxt: z.boolean().default(false),
  robotsUserAgent: z.string().min(1).max(200).optional(),
  delay: z.number().min(0).max(3600).optional(),
  maxConcurrency: z.number().int().min(1).max(1000).optional(),
  webhook: webhookSchema.optional(),
  scrapeOptions: scrapeOptionsSchema.optional(),
  zeroDataRetention: z.boolean().default(false),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

const CRAWL_KEYS = new Set(Object.keys(crawlRequestSchema.shape));

export interface NormalizedCrawl {
  request: CrawlRequest;
  scrapeOptions: Record<string, unknown>;
  warnings: string[];
}

export function normalizeCrawlRequest(input: unknown): NormalizedCrawl {
  const parsed = crawlRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', issues(parsed.error));
  const request = parsed.data;
  const scrapeOptions = (request.scrapeOptions ?? {}) as Record<string, unknown>;
  const warnings = [...normalizeScrapeRequest({ ...scrapeOptions, url: request.url }).warnings];
  const extras = unknownKeys(input, CRAWL_KEYS);
  if (extras.length > 0) warnings.push(`Ignored unsupported options: ${extras.join(', ')}.`);
  if (request.prompt) warnings.push('`prompt` is ignored until natural-language crawl options are implemented (phase 5).');
  if (request.zeroDataRetention) warnings.push('`zeroDataRetention` is not supported; results are stored.');
  return { request, scrapeOptions, warnings };
}

const BATCH_OWN_KEYS = ['urls', 'webhook', 'maxConcurrency', 'ignoreInvalidURLs', 'zeroDataRetention'];

export const batchRequestSchema = z
  .object({
    urls: z.array(z.string()).min(1).max(10_000),
    webhook: webhookSchema.optional(),
    maxConcurrency: z.number().int().min(1).max(1000).optional(),
    ignoreInvalidURLs: z.boolean().default(true),
    zeroDataRetention: z.boolean().default(false),
  })
  .passthrough();
export type BatchRequest = z.infer<typeof batchRequestSchema>;

export interface NormalizedBatch {
  request: BatchRequest;
  urls: string[];
  invalidURLs: string[] | undefined;
  scrapeOptions: Record<string, unknown>;
  warnings: string[];
}

export function normalizeBatchRequest(input: unknown): NormalizedBatch {
  const parsed = batchRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', issues(parsed.error));
  const request = parsed.data;

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of request.urls) {
    let ok = false;
    try {
      const u = new URL(raw);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) invalid.push(raw);
    else if (!seen.has(raw)) {
      seen.add(raw);
      valid.push(raw);
    }
  }
  if (invalid.length > 0 && !request.ignoreInvalidURLs) {
    throw new IceCrawlError('VALIDATION', `Invalid URLs: ${invalid.join(', ')}`);
  }
  if (valid.length === 0) throw new IceCrawlError('VALIDATION', 'No valid URLs to scrape');

  const scrapeOptions = Object.fromEntries(Object.entries(request).filter(([k]) => !BATCH_OWN_KEYS.includes(k)));
  const warnings = [...normalizeScrapeRequest({ ...scrapeOptions, url: valid[0] }).warnings];
  if (request.zeroDataRetention) warnings.push('`zeroDataRetention` is not supported; results are stored.');
  return { request, urls: valid, invalidURLs: request.ignoreInvalidURLs ? invalid : undefined, scrapeOptions, warnings };
}

export const mapRequestSchema = z.object({
  url: httpUrl,
  search: z.string().max(500).optional(),
  sitemap: z.enum(['skip', 'include', 'only']).default('include'),
  includeSubdomains: z.boolean().default(true),
  ignoreQueryParameters: z.boolean().default(true),
  ignoreCache: z.boolean().default(false),
  limit: z.number().int().min(1).max(100_000).default(5000),
  timeout: z.number().int().min(1000).max(300_000).optional(),
});
export type MapRequest = z.infer<typeof mapRequestSchema>;
const MAP_KEYS = new Set(Object.keys(mapRequestSchema.shape));

export function normalizeMapRequest(input: unknown): { request: MapRequest; warnings: string[] } {
  const parsed = mapRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', issues(parsed.error));
  const extras = unknownKeys(input, MAP_KEYS);
  return { request: parsed.data, warnings: extras.length > 0 ? [`Ignored unsupported options: ${extras.join(', ')}.`] : [] };
}
