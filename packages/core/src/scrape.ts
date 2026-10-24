import { z } from 'zod';
import { IceCrawlError } from './errors';

export const SUPPORTED_FORMATS = ['markdown', 'html', 'rawHtml', 'links'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

const formatInput = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);

export const scrapeRequestSchema = z.object({
  url: z.string().url(),
  formats: z.array(formatInput).default(['markdown']),
  onlyMainContent: z.boolean().default(true),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  waitFor: z.number().int().min(0).max(60000).default(0),
  timeout: z.number().int().min(1000).max(300000).default(60000),
  headers: z.record(z.string()).optional(),
  mobile: z.boolean().default(false),
  skipTlsVerification: z.boolean().default(true),
  proxy: z.enum(['basic', 'enhanced', 'stealth', 'auto']).default('auto'),
  blockAds: z.boolean().default(true),
  removeBase64Images: z.boolean().default(true),
  actions: z.array(z.record(z.unknown())).optional(),
  maxAge: z.number().int().optional(),
  storeInCache: z.boolean().optional(),
});

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;

export interface NormalizedScrape {
  request: ScrapeRequest;
  formats: SupportedFormat[];
  warnings: string[];
}

const KNOWN_KEYS = new Set(Object.keys(scrapeRequestSchema.shape));

export function normalizeScrapeRequest(input: unknown): NormalizedScrape {
  const parsed = scrapeRequestSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new IceCrawlError('VALIDATION', message);
  }
  const request = parsed.data;
  const warnings: string[] = [];

  const extras =
    typeof input === 'object' && input !== null ? Object.keys(input).filter((k) => !KNOWN_KEYS.has(k)) : [];
  if (extras.length > 0) warnings.push(`Ignored unsupported options: ${extras.join(', ')}.`);

  const formats: SupportedFormat[] = [];
  const unsupported: string[] = [];
  for (const f of request.formats) {
    const type = typeof f === 'string' ? f : f.type;
    if ((SUPPORTED_FORMATS as readonly string[]).includes(type)) {
      if (!formats.includes(type as SupportedFormat)) formats.push(type as SupportedFormat);
    } else if (!unsupported.includes(type)) {
      unsupported.push(type);
    }
  }
  if (formats.length === 0) {
    throw new IceCrawlError(
      'UNSUPPORTED_OPTION',
      `None of the requested formats are supported yet: ${unsupported.join(', ')}. Supported: ${SUPPORTED_FORMATS.join(', ')}.`,
    );
  }
  if (unsupported.length > 0) warnings.push(`Unsupported formats not returned yet: ${unsupported.join(', ')}.`);

  return { request, formats, warnings };
}
