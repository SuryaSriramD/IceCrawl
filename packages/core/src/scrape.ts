import { z } from 'zod';
import { IceCrawlError } from './errors';

export const SUPPORTED_FORMATS = ['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'json', 'summary'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

const formatInput = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);

const viewportSchema = z.object({
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
});

const screenshotFormatSchema = z.object({
  type: z.literal('screenshot'),
  fullPage: z.boolean().default(false),
  quality: z.number().int().min(1).max(100).optional(),
  viewport: viewportSchema.optional(),
});

export interface ScreenshotOptions {
  fullPage: boolean;
  quality?: number;
  viewport?: { width: number; height: number };
}

export const MAX_SCHEMA_CHARS = 50_000;

const jsonFormatSchema = z.object({
  type: z.literal('json'),
  schema: z.record(z.unknown()).optional(),
  prompt: z.string().min(1).max(10_000).optional(),
});

export interface JsonFormatOptions {
  schema?: Record<string, unknown>;
  prompt?: string;
}

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('wait'),
    milliseconds: z.number().int().min(1).max(60000).optional(),
    selector: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('click'), selector: z.string().min(1), all: z.boolean().default(false) }),
  z.object({ type: z.literal('write'), text: z.string() }),
  z.object({ type: z.literal('press'), key: z.string().min(1) }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']).default('down'),
    selector: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('screenshot'),
    fullPage: z.boolean().default(false),
    quality: z.number().int().min(1).max(100).optional(),
    viewport: viewportSchema.optional(),
  }),
  z.object({ type: z.literal('scrape') }),
  z.object({ type: z.literal('executeJavascript'), script: z.string().min(1).max(100_000) }),
  z.object({
    type: z.literal('pdf'),
    format: z.enum(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Ledger']).default('Letter'),
    landscape: z.boolean().default(false),
    scale: z.number().min(0.1).max(2).default(1),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

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
  actions: z.array(actionSchema).max(50).optional(),
  maxAge: z.number().int().optional(),
  storeInCache: z.boolean().optional(),
});

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
export type ScrapeOptions = Omit<z.input<typeof scrapeRequestSchema>, 'url'>;

/** Scrape options as accepted nested in other requests (crawl, search, extract): every field optional. */
export const scrapeOptionsSchema = scrapeRequestSchema.omit({ url: true }).partial().passthrough();

export interface NormalizedScrape {
  request: ScrapeRequest;
  formats: SupportedFormat[];
  screenshot: ScreenshotOptions | null;
  json: JsonFormatOptions | null;
  warnings: string[];
}

const KNOWN_KEYS = new Set(Object.keys(scrapeRequestSchema.shape));

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

export function normalizeScrapeRequest(input: unknown): NormalizedScrape {
  const parsed = scrapeRequestSchema.safeParse(input);
  if (!parsed.success) throw new IceCrawlError('VALIDATION', describeIssues(parsed.error));
  const request = parsed.data;
  const warnings: string[] = [];

  (request.actions ?? []).forEach((a, i) => {
    if (a.type === 'wait' && (a.milliseconds === undefined) === (a.selector === undefined)) {
      throw new IceCrawlError('VALIDATION', `actions.${i}: wait needs exactly one of milliseconds or selector`);
    }
  });

  const extras =
    typeof input === 'object' && input !== null ? Object.keys(input).filter((k) => !KNOWN_KEYS.has(k)) : [];
  if (extras.length > 0) warnings.push(`Ignored unsupported options: ${extras.join(', ')}.`);

  const formats: SupportedFormat[] = [];
  const unsupported: string[] = [];
  let screenshot: ScreenshotOptions | null = null;
  let json: JsonFormatOptions | null = null;
  for (const f of request.formats) {
    const type = typeof f === 'string' ? f : f.type;
    if (type === 'screenshot') {
      const s = screenshotFormatSchema.safeParse(typeof f === 'string' ? { type: 'screenshot' } : f);
      if (!s.success) throw new IceCrawlError('VALIDATION', `formats.screenshot: ${describeIssues(s.error)}`);
      screenshot = { fullPage: s.data.fullPage, quality: s.data.quality, viewport: s.data.viewport };
    }
    if (type === 'json') {
      const j = jsonFormatSchema.safeParse(typeof f === 'string' ? { type: 'json' } : f);
      if (!j.success) throw new IceCrawlError('VALIDATION', `formats.json: ${describeIssues(j.error)}`);
      if (j.data.schema && JSON.stringify(j.data.schema).length > MAX_SCHEMA_CHARS) {
        throw new IceCrawlError('VALIDATION', `formats.json: the schema is larger than ${MAX_SCHEMA_CHARS} characters`);
      }
      json = { ...(j.data.schema ? { schema: j.data.schema } : {}), ...(j.data.prompt ? { prompt: j.data.prompt } : {}) };
    }
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
  if (screenshot?.quality !== undefined) warnings.push('Screenshot quality is ignored: screenshots are PNG.');

  return { request, formats, screenshot, json, warnings };
}
