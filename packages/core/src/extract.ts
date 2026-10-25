import { z } from 'zod';
import { IceCrawlError } from './errors';
import { MAX_SCHEMA_CHARS, normalizeScrapeRequest, scrapeOptionsSchema } from './scrape';

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

export const extractRequestSchema = z.object({
  urls: z.array(z.string()).min(1).max(100),
  prompt: z.string().min(1).max(10_000).optional(),
  schema: z.record(z.unknown()).optional(),
  enableWebSearch: z.boolean().default(false),
  ignoreSitemap: z.boolean().default(false),
  includeSubdomains: z.boolean().default(true),
  showSources: z.boolean().default(false),
  scrapeOptions: scrapeOptionsSchema.optional(),
  ignoreInvalidURLs: z.boolean().default(true),
});

export type ExtractRequest = z.infer<typeof extractRequestSchema>;
export type ExtractOptions = Omit<z.input<typeof extractRequestSchema>, 'urls'>;

const KNOWN_KEYS = new Set(Object.keys(extractRequestSchema.shape));

/** A URL ending in `*` stands for "this page and everything below it", for example https://example.com/blog/*. */
export const isUrlPattern = (url: string): boolean => url.endsWith('*');
export const patternPrefix = (url: string): string => url.slice(0, -1);

function validUrl(raw: string): boolean {
  const star = raw.indexOf('*');
  if (star !== -1 && star !== raw.length - 1) return false;
  try {
    const u = new URL(isUrlPattern(raw) ? patternPrefix(raw) : raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface NormalizedExtract {
  request: ExtractRequest;
  /** Valid, de-duplicated URLs and patterns, in request order. */
  urls: string[];
  invalidURLs: string[] | undefined;
  /** Scrape options without `formats`: extract always reads the markdown of each page. */
  scrapeOptions: Record<string, unknown>;
  warnings: string[];
}

export function normalizeExtractRequest(input: unknown): NormalizedExtract {
  const parsed = extractRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', issues(parsed.error));
  const request = parsed.data;
  if (!request.prompt && !request.schema) throw new IceCrawlError('VALIDATION', 'extract needs a prompt, a schema or both');
  if (request.schema && JSON.stringify(request.schema).length > MAX_SCHEMA_CHARS) {
    throw new IceCrawlError('VALIDATION', `schema is larger than ${MAX_SCHEMA_CHARS} characters`);
  }

  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of request.urls) {
    if (!validUrl(raw)) invalid.push(raw);
    else if (!urls.includes(raw)) urls.push(raw);
  }
  if (invalid.length > 0 && !request.ignoreInvalidURLs) throw new IceCrawlError('VALIDATION', `Invalid URLs: ${invalid.join(', ')}`);
  if (urls.length === 0) throw new IceCrawlError('VALIDATION', 'No valid URLs to extract from');

  const { formats, ...scrapeOptions } = (request.scrapeOptions ?? {}) as Record<string, unknown>;
  const warnings = [...normalizeScrapeRequest({ ...scrapeOptions, url: 'https://example.com/', formats: ['markdown'] }).warnings];
  if (Array.isArray(formats) && !(formats.length === 1 && (formats[0] === 'markdown' || (formats[0] as { type?: string })?.type === 'markdown'))) {
    warnings.push('Extract always reads the markdown of each page; scrapeOptions.formats was ignored.');
  }
  const extras = typeof input === 'object' && input !== null ? Object.keys(input).filter((k) => !KNOWN_KEYS.has(k)) : [];
  if (extras.length > 0) warnings.push(`Ignored unsupported options: ${extras.join(', ')}.`);

  return { request, urls, invalidURLs: request.ignoreInvalidURLs ? invalid : undefined, scrapeOptions, warnings };
}
