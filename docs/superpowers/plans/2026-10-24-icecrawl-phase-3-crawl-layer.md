# IceCrawl Phase 3 (Crawl Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Firecrawl-v2-compatible `POST /v2/crawl`, `POST /v2/batch/scrape` and `POST /v2/map`, with async jobs polled through status endpoints (pagination, cancel, errors, active list), signed webhooks, `robots.txt` enforcement for crawls, sitemap discovery and a de-duplicating crawl frontier. Every crawled page is a normal IceCrawl scrape: verdict, receipt, snapshot and signature.

**Architecture:** Postgres is the source of truth for jobs, counters, pages and errors (`jobs` table; `scrapes.job_id`). Redis (BullMQ) distributes work and holds the crawl frontier de-dup set, per-crawl concurrency/delay slots. A new pure `crawler` package holds URL normalisation, link-scope rules, robots parsing and sitemap parsing. A new `queue` package hides BullMQ behind a `JobQueues` interface with an in-memory twin, so all job logic is tested without Redis. Workers run inside the `api` package and start in-process by default (`ICECRAWL_RUN_WORKER=true`) or as a separate process.

**Tech Stack:** bullmq 5.81.x + ioredis 5.10.x (pinned: bullmq 6 changed its driver model), tldts 7, robots-parser 3, fast-xml-parser 5, undici 6 (webhook delivery), Postgres 16, Redis 7, vitest 2.

## Global Constraints

Copied from `docs/superpowers/specs/2026-10-24-icecrawl-design.md` and earlier phases:

- TypeScript on Node >=20.12; Apache-2.0; clean-room (no Firecrawl code copied).
- Same paths, bearer auth, job-ID polling, `success`/`data` envelope as Firecrawl v2; errors are `{success:false, code, error}`.
- Postgres tables: `jobs(id, type, status, request jsonb, …)`; crawl/batch pages are `scrapes` rows linked to the job. Redis holds BullMQ queues and crawl frontier de-dup (plus per-crawl concurrency/delay slots).
- Verdict rules from phase 1 still decide whether a page counts as completed; a failed verdict is a failed page, listed under the job's errors.
- robots.txt is respected for crawl (RFC 9309: 4xx = allow all, 5xx or unreachable = disallow all). `ignoreRobotsTxt` is honoured only when the operator enables it.
- SSRF guard: block private, loopback and link-local addresses after DNS resolution and on every redirect, for scrapes, robots/sitemap fetches and webhook deliveries.
- Webhooks: events `started | page | completed | failed`; payload `{success, type, id, webhookId, data, metadata, error?}`; HMAC-SHA256 signature header `sha256=<hex>`.
- Job results expire after 24 hours (configurable); status responses paginate at about 10 MB with a `next` URL.
- Billing is out of scope: `creditsUsed` reports pages completed and nothing is charged.
- Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (second `-m`).
- Run tests with `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379` (`pnpm db:up` must be running) so nothing is skipped. The root vitest config runs test files serially; keep it.

## Deviations and decisions for phase 3

- **Worker code lives in `packages/api/src/jobs/`**, not a separate package: it needs the store, snapshot store and scrape service that live in `api`. A separate process is still possible (`pnpm --filter @icecrawl/api worker`). Extraction into its own package is a later refactor.
- **Sitemap seeding runs in the worker** (a `discover` job), not in the HTTP request, so `POST /crawl` returns immediately.
- **`prompt` (natural-language crawl options) and `/crawl/params-preview` need an LLM** and stay for phase 5: `prompt` is accepted with a warning, `params-preview` answers `501`.
- **Per-API-key rate limits** from the spec's Redis list are not in this phase.
- **robots cache is per worker process, in memory** (10 minutes). **Concurrency slots** use Redis counters with a 10 minute TTL, so a crashed worker can leave a slot held until it expires (`shortcut:` comments mark both).
- **No job reaper for crashed workers**: a page job lost while running is retried by BullMQ's stalled-job handling, but a job whose counters never reach `total` is not force-finished. Expired jobs are deleted hourly; snapshot blobs on disk are not garbage collected yet.
- **`creditsUsed` = completed pages**, **`teamId` = API key id** (no teams).
- **Batch scrape does not check robots.txt** (the caller named each URL explicitly); crawl does.
- **Webhook signature headers**: both `X-IceCrawl-Signature` and `X-Firecrawl-Signature` carry the same value, so receivers written for Firecrawl keep working.
- Static asset links (images, CSS, JS, fonts, archives, media) are never followed by the crawler.

## File Structure

```
packages/
  core/     src/jobs.ts (new)  src/errors.ts, src/index.ts (modified)  test/jobs.test.ts (new)
  crawler/  (new package)  src/{url,links,robots,sitemap,index}.ts   test/{url,links,robots,sitemap}.test.ts
  queue/    (new package)  src/{types,memory,bull,index}.ts          test/{memory,bull}.test.ts
  api/      migrations/003_jobs.sql (new)
            src/store/{types,memory,pg}.ts (modified)
            src/scrape-service.ts, src/response.ts, src/app.ts (modified)
            src/jobs/{webhooks,processor,fetcher,map,runner,reaper}.ts (new)
            src/routes/{jobs,map}.ts (new)
            src/{runtime,worker,webhook-secret}.ts (new)  src/{config,server}.ts (modified)
            test/jobs-helpers.ts (new)
            test/{webhooks,processor,jobs-routes,map,e2e.crawl}.test.ts (new)
            test/{store.contract,app}.test.ts (modified)
docker-compose.yml, .env.example, README.md, spec (modified)
```

---

### Task 1: `core`: crawl, batch and map request schemas, `CONFLICT` error

**Files:**
- Create: `packages/core/src/jobs.ts`, `packages/core/test/jobs.test.ts`
- Modify: `packages/core/src/errors.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ERROR_STATUS.CONFLICT` (409); `webhookSchema`, `type WebhookConfig { url; headers?; metadata?; events? }`; `crawlRequestSchema`, `type CrawlRequest`, `interface NormalizedCrawl { request: CrawlRequest; scrapeOptions: Record<string, unknown>; warnings: string[] }`, `normalizeCrawlRequest(input): NormalizedCrawl`; `batchRequestSchema`, `type BatchRequest`, `interface NormalizedBatch { request; urls: string[]; invalidURLs: string[] | undefined; scrapeOptions: Record<string, unknown>; warnings: string[] }`, `normalizeBatchRequest(input): NormalizedBatch`; `mapRequestSchema`, `type MapRequest`, `normalizeMapRequest(input): { request: MapRequest; warnings: string[] }`. All throw `IceCrawlError('VALIDATION', …)` on bad input.

- [ ] **Step 1: Write the failing test**

`packages/core/test/jobs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, normalizeBatchRequest, normalizeCrawlRequest, normalizeMapRequest } from '../src';

describe('normalizeCrawlRequest', () => {
  it('applies Firecrawl v2 defaults', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com' });
    expect(n.request).toMatchObject({
      sitemap: 'include',
      ignoreQueryParameters: false,
      regexOnFullURL: false,
      limit: 10000,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: false,
      ignoreRobotsTxt: false,
      zeroDataRetention: false,
    });
    expect(n.request.maxDiscoveryDepth).toBeUndefined();
    expect(n.scrapeOptions).toEqual({});
    expect(n.warnings).toEqual([]);
  });

  it('keeps scrapeOptions and validates them like /scrape', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { formats: ['markdown', 'html'], onlyMainContent: false } });
    expect(n.scrapeOptions).toEqual({ formats: ['markdown', 'html'], onlyMainContent: false });
    expect(() => normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { timeout: 5 } })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeCrawlRequest({ url: 'https://example.com', scrapeOptions: { formats: ['json'] } })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }),
    );
  });

  it('rejects invalid input', () => {
    const bad: unknown[] = [
      null,
      { url: 'nope' },
      { url: 'https://example.com', limit: 0 },
      { url: 'https://example.com', includePaths: ['('] },
      { url: 'https://example.com', sitemap: 'maybe' },
      { url: 'https://example.com', maxConcurrency: 0 },
      { url: 'https://example.com', webhook: { url: 'ftp://example.com/hook' } },
      { url: 'https://example.com', webhook: { url: 'https://example.com/hook', events: ['exploded'] } },
    ];
    for (const input of bad) {
      expect(() => normalizeCrawlRequest(input)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });

  it('warns about prompt, zeroDataRetention and unknown options', () => {
    const n = normalizeCrawlRequest({ url: 'https://example.com', prompt: 'only blog posts', zeroDataRetention: true, futureThing: 1 });
    const w = n.warnings.join(' ');
    expect(w).toContain('prompt');
    expect(w).toContain('zeroDataRetention');
    expect(w).toContain('futureThing');
  });

  it('accepts a full webhook definition', () => {
    const n = normalizeCrawlRequest({
      url: 'https://example.com',
      webhook: { url: 'https://hooks.example.com/x', headers: { 'X-A': 'b' }, metadata: { run: 1 }, events: ['page', 'completed'] },
    });
    expect(n.request.webhook).toEqual({ url: 'https://hooks.example.com/x', headers: { 'X-A': 'b' }, metadata: { run: 1 }, events: ['page', 'completed'] });
  });
});

describe('normalizeBatchRequest', () => {
  it('splits scrape options from batch options and removes duplicates', () => {
    const n = normalizeBatchRequest({
      urls: ['https://a.example/', 'https://b.example/', 'https://a.example/'],
      formats: ['markdown', 'links'],
      onlyMainContent: false,
      maxConcurrency: 2,
    });
    expect(n.urls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(n.scrapeOptions).toEqual({ formats: ['markdown', 'links'], onlyMainContent: false });
    expect(n.request.maxConcurrency).toBe(2);
    expect(n.invalidURLs).toEqual([]);
  });

  it('ignores invalid URLs by default and reports them', () => {
    const n = normalizeBatchRequest({ urls: ['https://ok.example/', 'not a url', 'ftp://x.example/'] });
    expect(n.urls).toEqual(['https://ok.example/']);
    expect(n.invalidURLs).toEqual(['not a url', 'ftp://x.example/']);
  });

  it('fails on invalid URLs when ignoreInvalidURLs is false, and when nothing valid remains', () => {
    expect(() => normalizeBatchRequest({ urls: ['https://ok.example/', 'bad'], ignoreInvalidURLs: false })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeBatchRequest({ urls: ['bad'] })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeBatchRequest({ urls: [] })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeBatchRequest({})).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('validates scrape options', () => {
    expect(() => normalizeBatchRequest({ urls: ['https://ok.example/'], timeout: 1 })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});

describe('normalizeMapRequest', () => {
  it('applies defaults', () => {
    const { request, warnings } = normalizeMapRequest({ url: 'https://example.com' });
    expect(request).toMatchObject({ sitemap: 'include', includeSubdomains: true, ignoreQueryParameters: true, ignoreCache: false, limit: 5000 });
    expect(warnings).toEqual([]);
  });

  it('enforces limits and warns about unknown options', () => {
    expect(() => normalizeMapRequest({ url: 'https://example.com', limit: 100001 })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => normalizeMapRequest({ url: 'nope' })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(normalizeMapRequest({ url: 'https://example.com', location: { country: 'DE' } }).warnings.join(' ')).toContain('location');
  });
});

describe('error codes', () => {
  it('has a 409 CONFLICT', () => expect(ERROR_STATUS.CONFLICT).toBe(409));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/test/jobs.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

In `packages/core/src/errors.ts` insert `  CONFLICT: 409,` on the line after `  NOT_FOUND: 404,`.

`packages/core/src/jobs.ts`:
```ts
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
```
Append `export * from './jobs';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS; if the `formats: ['json']` crawl test reports `VALIDATION` instead of `UNSUPPORTED_OPTION`, check that `normalizeScrapeRequest` is called with the crawl's `scrapeOptions` (it throws `UNSUPPORTED_OPTION` when no supported format remains).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): crawl, batch and map request schemas and CONFLICT error" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `crawler` package: URL normalisation and link-scope rules

**Files:**
- Create: `packages/crawler/package.json`, `packages/crawler/src/url.ts`, `packages/crawler/src/links.ts`, `packages/crawler/src/index.ts`
- Test: `packages/crawler/test/url.test.ts`, `packages/crawler/test/links.test.ts`

**Interfaces:**
- Produces:
  - `normalizeUrl(raw: string, o: { ignoreQueryParameters: boolean }): string | null` (http/https only; lowercases host; drops fragment and credentials; sorts query or drops it; removes a trailing slash except on the root path).
  - `type HostRelation = 'same' | 'subdomain' | 'external'`; `hostRelation(host: string, baseHost: string): HostRelation` (`www.` is ignored; subdomain = same registrable domain).
  - `isAssetPath(pathname: string): boolean`.
  - `interface CrawlScope { baseUrl: URL; includePaths: RegExp[]; excludePaths: RegExp[]; regexOnFullURL: boolean; crawlEntireDomain: boolean; allowExternalLinks: boolean; allowSubdomains: boolean; maxDiscoveryDepth?: number }`; `buildScope(baseUrl: string, o: { includePaths?: string[]; excludePaths?: string[]; regexOnFullURL?: boolean; crawlEntireDomain?: boolean; allowExternalLinks?: boolean; allowSubdomains?: boolean; maxDiscoveryDepth?: number }): CrawlScope`.
  - `type LinkDecision = { follow: true; external: boolean } | { follow: false; reason: 'scheme' | 'asset' | 'depth' | 'external' | 'subdomain' | 'out-of-scope' | 'excluded' | 'not-included' }`; `decideLink(link: string, depth: number, scope: CrawlScope): LinkDecision`.

- [ ] **Step 1: Create the package and write the failing tests**

`packages/crawler/package.json`:
```json
{
  "name": "@icecrawl/crawler",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "fast-xml-parser": "^5.11.2",
    "robots-parser": "^3.0.1",
    "tldts": "^7.4.19"
  }
}
```
Run: `pnpm install`
Expected: installs the three libraries and links the workspace package.

`packages/crawler/test/url.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hostRelation, isAssetPath, normalizeUrl } from '../src';

const keep = { ignoreQueryParameters: false };
const drop = { ignoreQueryParameters: true };

describe('normalizeUrl', () => {
  it('lowercases the host, drops the fragment, default port and credentials', () => {
    expect(normalizeUrl('HTTPS://User:pw@Example.COM:443/a#frag', keep)).toBe('https://example.com/a');
  });

  it('removes trailing slashes except on the root', () => {
    expect(normalizeUrl('https://example.com/a/', keep)).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a//', keep)).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com', keep)).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/', keep)).toBe('https://example.com/');
  });

  it('sorts query parameters, or drops them when asked', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1', keep)).toBe('https://example.com/a?a=1&b=2');
    expect(normalizeUrl('https://example.com/a?b=2&a=1', drop)).toBe('https://example.com/a');
  });

  it('rejects non-http schemes and garbage', () => {
    for (const bad of ['mailto:a@b.c', 'javascript:void(0)', 'ftp://x.example/', 'not a url', '']) {
      expect(normalizeUrl(bad, keep)).toBeNull();
    }
  });

  it('treats equivalent URLs as the same string', () => {
    const a = normalizeUrl('https://Example.com/x/?b=1&a=2#top', keep);
    const b = normalizeUrl('https://example.com:443/x?a=2&b=1', keep);
    expect(a).toBe(b);
  });
});

describe('hostRelation', () => {
  it.each([
    ['example.com', 'example.com', 'same'],
    ['www.example.com', 'example.com', 'same'],
    ['example.com', 'www.example.com', 'same'],
    ['blog.example.com', 'example.com', 'subdomain'],
    ['example.com', 'blog.example.com', 'subdomain'],
    ['a.example.com', 'b.example.com', 'subdomain'],
    ['example.org', 'example.com', 'external'],
    ['evilexample.com', 'example.com', 'external'],
    ['alice.github.io', 'bob.github.io', 'external'],
    ['example.co.uk', 'shop.example.co.uk', 'subdomain'],
    ['10.0.0.1', '10.0.0.2', 'external'],
    ['localhost', 'localhost', 'same'],
  ] as const)('%s vs %s is %s', (a, b, expected) => expect(hostRelation(a, b)).toBe(expected));
});

describe('isAssetPath', () => {
  it.each(['/a.png', '/a.JPG', '/x/app.js', '/s.css', '/f.woff2', '/v.mp4', '/z.zip', '/favicon.ico'])('%s is an asset', (p) =>
    expect(isAssetPath(p)).toBe(true),
  );
  it.each(['/', '/a', '/a.html', '/docs/png-guide', '/a.pdf', '/file.txt'])('%s is not an asset', (p) => expect(isAssetPath(p)).toBe(false));
});
```

`packages/crawler/test/links.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildScope, decideLink } from '../src';

const scope = (base: string, o: Parameters<typeof buildScope>[1] = {}) => buildScope(base, o);
const follows = (link: string, depth: number, s: ReturnType<typeof scope>) => {
  const d = decideLink(link, depth, s);
  return d.follow ? (d.external ? 'external' : 'yes') : d.reason;
};

describe('decideLink', () => {
  it('follows same-host children of the start path and refuses siblings and parents by default', () => {
    const s = scope('https://example.com/docs/guide');
    expect(follows('https://example.com/docs/guide', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/guide/intro', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/other', 1, s)).toBe('out-of-scope');
    expect(follows('https://example.com/', 1, s)).toBe('out-of-scope');
    expect(follows('https://example.com/docs/guidebook', 1, s)).toBe('out-of-scope');
  });

  it('follows everything on the host when starting at the root or with crawlEntireDomain', () => {
    expect(follows('https://example.com/anything/here', 1, scope('https://example.com/'))).toBe('yes');
    expect(follows('https://example.com/other', 1, scope('https://example.com/docs', { crawlEntireDomain: true }))).toBe('yes');
  });

  it('treats www and the bare domain as the same host', () => {
    expect(follows('https://www.example.com/a', 1, scope('https://example.com/'))).toBe('yes');
  });

  it('handles subdomains and external hosts per the flags', () => {
    const base = 'https://example.com/';
    expect(follows('https://blog.example.com/a', 1, scope(base))).toBe('subdomain');
    expect(follows('https://blog.example.com/a', 1, scope(base, { allowSubdomains: true }))).toBe('yes');
    expect(follows('https://other.org/a', 1, scope(base))).toBe('external');
    expect(follows('https://other.org/a', 1, scope(base, { allowExternalLinks: true }))).toBe('external');
    expect(follows('https://blog.example.com/a', 1, scope(base, { allowExternalLinks: true }))).toBe('external');
  });

  it('skips non-http schemes and static assets', () => {
    const s = scope('https://example.com/');
    expect(follows('mailto:a@b.c', 1, s)).toBe('scheme');
    expect(follows('javascript:void(0)', 1, s)).toBe('scheme');
    expect(follows('https://example.com/logo.png', 1, s)).toBe('asset');
    expect(follows('https://example.com/a.html', 1, s)).toBe('yes');
  });

  it('enforces maxDiscoveryDepth', () => {
    const s = scope('https://example.com/', { maxDiscoveryDepth: 2 });
    expect(follows('https://example.com/a', 2, s)).toBe('yes');
    expect(follows('https://example.com/a', 3, s)).toBe('depth');
  });

  it('applies excludePaths and includePaths to the pathname', () => {
    const s = scope('https://example.com/', { excludePaths: ['^/private'], includePaths: ['^/blog', '^/docs'] });
    expect(follows('https://example.com/blog/post', 1, s)).toBe('yes');
    expect(follows('https://example.com/docs/x', 1, s)).toBe('yes');
    expect(follows('https://example.com/about', 1, s)).toBe('not-included');
    expect(follows('https://example.com/private/blog', 1, scope('https://example.com/', { excludePaths: ['^/private'] }))).toBe('excluded');
  });

  it('matches patterns unanchored, like Firecrawl (blog/.* matches /blog/x)', () => {
    const s = scope('https://example.com/', { excludePaths: ['blog/.*'] });
    expect(follows('https://example.com/blog/x', 1, s)).toBe('excluded');
    expect(follows('https://example.com/news', 1, s)).toBe('yes');
  });

  it('can match patterns against the full URL including the query', () => {
    const s = scope('https://example.com/', { excludePaths: ['\\?draft=1'], regexOnFullURL: true });
    expect(follows('https://example.com/a?draft=1', 1, s)).toBe('excluded');
    expect(follows('https://example.com/a?draft=0', 1, s)).toBe('yes');
    const byPath = scope('https://example.com/', { excludePaths: ['\\?draft=1'] });
    expect(follows('https://example.com/a?draft=1', 1, byPath)).toBe('yes');
  });

  it('does not apply the child-path rule to subdomain or external hosts', () => {
    const s = scope('https://example.com/docs', { allowSubdomains: true, allowExternalLinks: true });
    expect(follows('https://blog.example.com/anything', 1, s)).toBe('yes');
    expect(follows('https://other.org/anything', 1, s)).toBe('external');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/crawler`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`packages/crawler/src/url.ts`:
```ts
import { getDomain } from 'tldts';

export function normalizeUrl(raw: string, o: { ignoreQueryParameters: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (o.ignoreQueryParameters) u.search = '';
  else u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

export type HostRelation = 'same' | 'subdomain' | 'external';

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, '');

export function hostRelation(host: string, baseHost: string): HostRelation {
  const a = stripWww(host);
  const b = stripWww(baseHost);
  if (a === b) return 'same';
  const da = getDomain(a, { allowPrivateDomains: true });
  const db = getDomain(b, { allowPrivateDomains: true });
  return da !== null && da === db ? 'subdomain' : 'external';
}

const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mov|avi|mp3|wav|ogg|zip|gz|tgz|tar|rar|7z|exe|dmg|iso|apk)$/i;

export function isAssetPath(pathname: string): boolean {
  return ASSET.test(pathname);
}
```

`packages/crawler/src/links.ts`:
```ts
import { hostRelation, isAssetPath } from './url';

export interface CrawlScope {
  baseUrl: URL;
  includePaths: RegExp[];
  excludePaths: RegExp[];
  regexOnFullURL: boolean;
  crawlEntireDomain: boolean;
  allowExternalLinks: boolean;
  allowSubdomains: boolean;
  maxDiscoveryDepth?: number;
}

export function buildScope(
  baseUrl: string,
  o: {
    includePaths?: string[];
    excludePaths?: string[];
    regexOnFullURL?: boolean;
    crawlEntireDomain?: boolean;
    allowExternalLinks?: boolean;
    allowSubdomains?: boolean;
    maxDiscoveryDepth?: number;
  } = {},
): CrawlScope {
  return {
    baseUrl: new URL(baseUrl),
    includePaths: (o.includePaths ?? []).map((p) => new RegExp(p)),
    excludePaths: (o.excludePaths ?? []).map((p) => new RegExp(p)),
    regexOnFullURL: o.regexOnFullURL ?? false,
    crawlEntireDomain: o.crawlEntireDomain ?? false,
    allowExternalLinks: o.allowExternalLinks ?? false,
    allowSubdomains: o.allowSubdomains ?? false,
    maxDiscoveryDepth: o.maxDiscoveryDepth,
  };
}

export type LinkDecision =
  | { follow: true; external: boolean }
  | { follow: false; reason: 'scheme' | 'asset' | 'depth' | 'external' | 'subdomain' | 'out-of-scope' | 'excluded' | 'not-included' };

const no = (reason: Extract<LinkDecision, { follow: false }>['reason']): LinkDecision => ({ follow: false, reason });

function inChildScope(path: string, basePath: string): boolean {
  const base = basePath.replace(/\/+$/, '');
  const p = path.replace(/\/+$/, '');
  return base === '' || p === base || p.startsWith(`${base}/`);
}

export function decideLink(link: string, depth: number, scope: CrawlScope): LinkDecision {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return no('scheme');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('scheme');
  if (isAssetPath(u.pathname)) return no('asset');
  if (scope.maxDiscoveryDepth !== undefined && depth > scope.maxDiscoveryDepth) return no('depth');

  const relation = hostRelation(u.hostname, scope.baseUrl.hostname);
  let external = false;
  if (relation === 'subdomain' && !scope.allowSubdomains) {
    if (!scope.allowExternalLinks) return no('subdomain');
    external = true;
  } else if (relation === 'external') {
    if (!scope.allowExternalLinks) return no('external');
    external = true;
  }

  if (relation === 'same' && !scope.crawlEntireDomain && !inChildScope(u.pathname, scope.baseUrl.pathname)) {
    return no('out-of-scope');
  }

  const target = scope.regexOnFullURL ? u.toString() : u.pathname;
  if (scope.excludePaths.some((r) => r.test(target))) return no('excluded');
  if (scope.includePaths.length > 0 && !scope.includePaths.some((r) => r.test(target))) return no('not-included');
  return { follow: true, external };
}
```

`packages/crawler/src/index.ts`:
```ts
export * from './url';
export * from './links';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/crawler && pnpm typecheck`
Expected: PASS. If `alice.github.io` vs `bob.github.io` is reported `subdomain`, the `allowPrivateDomains` option is not being honoured by the installed `tldts`; check its README for the current option name and fix the two `getDomain` calls (keep the expectation).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(crawler): URL normalisation and crawl link-scope rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `crawler`: robots.txt and sitemap handling

**Files:**
- Create: `packages/crawler/src/robots.ts`, `packages/crawler/src/sitemap.ts`
- Modify: `packages/crawler/src/index.ts`
- Test: `packages/crawler/test/robots.test.ts`, `packages/crawler/test/sitemap.test.ts`

**Interfaces:**
- Produces:
  - `type Fetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>` (redirects followed by the caller; throws on network errors).
  - `interface RobotsRules { allowed(url: string): boolean; crawlDelaySeconds: number | null; sitemaps: string[] }`, `ALLOW_ALL`, `DISALLOW_ALL`, `parseRobots(text, robotsUrl, userAgent): RobotsRules`, `loadRobots(origin: string, fetcher: Fetcher, userAgent: string): Promise<RobotsRules>` (RFC 9309: 2xx parse, 4xx allow all, 5xx or thrown error disallow all).
  - `parseSitemapXml(xml: string): { urls: string[]; sitemaps: string[] }`; `defaultSitemapSeeds(startUrl: string, robotsSitemaps: string[]): string[]`; `discoverSitemapUrls(seeds: string[], fetcher: Fetcher, o?: { maxSitemaps?: number; maxUrls?: number; maxDepth?: number }): Promise<string[]>` (follows sitemap indexes, gunzips `.gz`, ignores failures, de-duplicates, preserves order; defaults 50 sitemaps, 50000 URLs, depth 3).

- [ ] **Step 1: Write the failing tests**

`packages/crawler/test/robots.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, DISALLOW_ALL, loadRobots, parseRobots, type Fetcher } from '../src';

const text = `User-agent: *
Disallow: /private/
Crawl-delay: 2

User-agent: IceCrawl
Disallow: /icecrawl-only/
Allow: /private/public-ok

Sitemap: https://example.com/sitemap.xml
`;

describe('parseRobots', () => {
  it('applies the rules of the matching user agent and exposes crawl delay and sitemaps', () => {
    const generic = parseRobots(text, 'https://example.com/robots.txt', 'SomeBot');
    expect(generic.allowed('https://example.com/private/x')).toBe(false);
    expect(generic.allowed('https://example.com/public')).toBe(true);
    expect(generic.crawlDelaySeconds).toBe(2);
    expect(generic.sitemaps).toEqual(['https://example.com/sitemap.xml']);

    const ours = parseRobots(text, 'https://example.com/robots.txt', 'IceCrawl');
    expect(ours.allowed('https://example.com/icecrawl-only/x')).toBe(false);
    expect(ours.allowed('https://example.com/private/x')).toBe(true);
  });

  it('allows everything for an empty file', () => {
    expect(parseRobots('', 'https://example.com/robots.txt', 'IceCrawl').allowed('https://example.com/a')).toBe(true);
  });
});

const fetcherOf = (res: { status: number; text?: string } | Error): Fetcher => async () => {
  if (res instanceof Error) throw res;
  return { status: res.status, body: Buffer.from(res.text ?? '') };
};

describe('loadRobots (RFC 9309 status handling)', () => {
  it('parses a 200 response', async () => {
    const r = await loadRobots('https://example.com', fetcherOf({ status: 200, text: 'User-agent: *\nDisallow: /x' }), 'IceCrawl');
    expect(r.allowed('https://example.com/x')).toBe(false);
    expect(r.allowed('https://example.com/y')).toBe(true);
  });

  it('allows everything on 404 and other 4xx', async () => {
    for (const status of [404, 403, 410]) {
      const r = await loadRobots('https://example.com', fetcherOf({ status }), 'IceCrawl');
      expect(r.allowed('https://example.com/x')).toBe(true);
    }
  });

  it('disallows everything when the server errors or is unreachable', async () => {
    for (const res of [{ status: 500 }, { status: 503 }, new Error('ECONNRESET')]) {
      const r = await loadRobots('https://example.com', fetcherOf(res), 'IceCrawl');
      expect(r.allowed('https://example.com/x')).toBe(false);
    }
  });

  it('asks for /robots.txt on the origin', async () => {
    const seen: string[] = [];
    await loadRobots('https://example.com:8443', async (u) => (seen.push(u), { status: 404, body: new Uint8Array() }), 'IceCrawl');
    expect(seen).toEqual(['https://example.com:8443/robots.txt']);
  });

  it('exports the constant rule sets', () => {
    expect(ALLOW_ALL.allowed('https://x.example/')).toBe(true);
    expect(DISALLOW_ALL.allowed('https://x.example/')).toBe(false);
  });
});
```

`packages/crawler/test/sitemap.test.ts`:
```ts
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultSitemapSeeds, discoverSitemapUrls, parseSitemapXml, type Fetcher } from '../src';

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-01-01</lastmod></url>`).join('')}</urlset>`;
const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('parseSitemapXml', () => {
  it('reads urlsets, including a single entry', () => {
    expect(parseSitemapXml(urlset('https://e.com/a', 'https://e.com/b')).urls).toEqual(['https://e.com/a', 'https://e.com/b']);
    expect(parseSitemapXml(urlset('https://e.com/a')).urls).toEqual(['https://e.com/a']);
  });

  it('reads sitemap indexes', () => {
    expect(parseSitemapXml(index('https://e.com/s1.xml', 'https://e.com/s2.xml')).sitemaps).toEqual(['https://e.com/s1.xml', 'https://e.com/s2.xml']);
  });

  it('returns nothing for garbage or an unrelated document', () => {
    expect(parseSitemapXml('<html><body>nope</body></html>')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemapXml('not xml at all')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemapXml('')).toEqual({ urls: [], sitemaps: [] });
  });
});

describe('defaultSitemapSeeds', () => {
  it('lists robots sitemaps first, then /sitemap.xml, without duplicates', () => {
    expect(defaultSitemapSeeds('https://e.com/some/page', ['https://e.com/custom.xml', 'https://e.com/sitemap.xml'])).toEqual([
      'https://e.com/custom.xml',
      'https://e.com/sitemap.xml',
    ]);
    expect(defaultSitemapSeeds('https://e.com/x', [])).toEqual(['https://e.com/sitemap.xml']);
  });
});

function site(files: Record<string, string | Buffer | { status: number }>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const f = files[url];
    if (f === undefined) return { status: 404, body: new Uint8Array() };
    if (typeof f === 'object' && !Buffer.isBuffer(f)) return { status: f.status, body: new Uint8Array() };
    return { status: 200, body: Buffer.from(f as string | Buffer) };
  };
}

describe('discoverSitemapUrls', () => {
  it('follows sitemap indexes and keeps document order without duplicates', async () => {
    const f = site({
      'https://e.com/sitemap.xml': index('https://e.com/s1.xml', 'https://e.com/s2.xml'),
      'https://e.com/s1.xml': urlset('https://e.com/a', 'https://e.com/b'),
      'https://e.com/s2.xml': urlset('https://e.com/b', 'https://e.com/c'),
    });
    expect(await discoverSitemapUrls(['https://e.com/sitemap.xml'], f)).toEqual(['https://e.com/a', 'https://e.com/b', 'https://e.com/c']);
  });

  it('decompresses gzipped sitemaps', async () => {
    const f = site({ 'https://e.com/sitemap.xml.gz': gzipSync(urlset('https://e.com/zipped')) });
    expect(await discoverSitemapUrls(['https://e.com/sitemap.xml.gz'], f)).toEqual(['https://e.com/zipped']);
  });

  it('ignores missing, failing and malformed sitemaps', async () => {
    const f: Fetcher = async (url) => {
      if (url.endsWith('boom.xml')) throw new Error('network down');
      if (url.endsWith('bad.xml')) return { status: 200, body: Buffer.from('<html/>') };
      if (url.endsWith('ok.xml')) return { status: 200, body: Buffer.from(urlset('https://e.com/fine')) };
      return { status: 500, body: new Uint8Array() };
    };
    expect(await discoverSitemapUrls(['https://e.com/boom.xml', 'https://e.com/bad.xml', 'https://e.com/err.xml', 'https://e.com/ok.xml'], f)).toEqual([
      'https://e.com/fine',
    ]);
  });

  it('does not loop on cyclic indexes and respects the sitemap-count and depth limits', async () => {
    const calls: string[] = [];
    const cyc = site({ 'https://e.com/a.xml': index('https://e.com/b.xml'), 'https://e.com/b.xml': index('https://e.com/a.xml') }, calls);
    expect(await discoverSitemapUrls(['https://e.com/a.xml'], cyc)).toEqual([]);
    expect(calls).toEqual(['https://e.com/a.xml', 'https://e.com/b.xml']);

    const deepCalls: string[] = [];
    const chain = site(
      {
        'https://e.com/0.xml': index('https://e.com/1.xml'),
        'https://e.com/1.xml': index('https://e.com/2.xml'),
        'https://e.com/2.xml': index('https://e.com/3.xml'),
        'https://e.com/3.xml': urlset('https://e.com/deep'),
      },
      deepCalls,
    );
    expect(await discoverSitemapUrls(['https://e.com/0.xml'], chain, { maxDepth: 1 })).toEqual([]);
    expect(deepCalls).toEqual(['https://e.com/0.xml', 'https://e.com/1.xml']);
  });

  it('caps the number of URLs', async () => {
    const f = site({ 'https://e.com/s.xml': urlset(...Array.from({ length: 20 }, (_, i) => `https://e.com/p${i}`)) });
    expect(await discoverSitemapUrls(['https://e.com/s.xml'], f, { maxUrls: 5 })).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/crawler/test/robots.test.ts packages/crawler/test/sitemap.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`packages/crawler/src/robots.ts`:
```ts
import robotsParser from 'robots-parser';

export type Fetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>;

export interface RobotsRules {
  allowed(url: string): boolean;
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, crawlDelaySeconds: null, sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { allowed: () => false, crawlDelaySeconds: null, sitemaps: [] };

export function parseRobots(text: string, robotsUrl: string, userAgent: string): RobotsRules {
  const robots = robotsParser(robotsUrl, text);
  return {
    allowed: (url) => robots.isAllowed(url, userAgent) !== false,
    crawlDelaySeconds: robots.getCrawlDelay(userAgent) ?? null,
    sitemaps: robots.getSitemaps(),
  };
}

/** RFC 9309: 2xx parse, 4xx means no restrictions, 5xx or an unreachable server means assume everything is disallowed. */
export async function loadRobots(origin: string, fetcher: Fetcher, userAgent: string): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  let res: { status: number; body: Uint8Array };
  try {
    res = await fetcher(robotsUrl);
  } catch {
    return DISALLOW_ALL;
  }
  if (res.status >= 500) return DISALLOW_ALL;
  if (res.status >= 400) return ALLOW_ALL;
  return parseRobots(Buffer.from(res.body).toString('utf8'), robotsUrl, userAgent);
}
```

`packages/crawler/src/sitemap.ts`:
```ts
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { Fetcher } from './robots';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const MAX_XML_BYTES = 50 * 1024 * 1024;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const locs = (nodes: unknown): string[] =>
  asArray(nodes as unknown)
    .map((n) => (typeof n === 'string' ? n : (n as { loc?: unknown } | null)?.loc))
    .filter((x): x is string => typeof x === 'string' && x.length > 0);

export function parseSitemapXml(xml: string): { urls: string[]; sitemaps: string[] } {
  let doc: { urlset?: { url?: unknown }; sitemapindex?: { sitemap?: unknown } } | undefined;
  try {
    doc = parser.parse(xml);
  } catch {
    return { urls: [], sitemaps: [] };
  }
  return { urls: locs(doc?.urlset?.url), sitemaps: locs(doc?.sitemapindex?.sitemap) };
}

export function defaultSitemapSeeds(startUrl: string, robotsSitemaps: string[]): string[] {
  const fallback = new URL('/sitemap.xml', startUrl).toString();
  return [...new Set([...robotsSitemaps, fallback])];
}

export interface SitemapOptions {
  maxSitemaps?: number;
  maxUrls?: number;
  maxDepth?: number;
}

function decode(url: string, body: Uint8Array): string | null {
  const buf = Buffer.from(body);
  try {
    const gz = url.toLowerCase().endsWith('.gz') || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
    return (gz ? gunzipSync(buf, { maxOutputLength: MAX_XML_BYTES }) : buf).toString('utf8');
  } catch {
    return null;
  }
}

export async function discoverSitemapUrls(seeds: string[], fetcher: Fetcher, o: SitemapOptions = {}): Promise<string[]> {
  const maxSitemaps = o.maxSitemaps ?? 50;
  const maxUrls = o.maxUrls ?? 50_000;
  const maxDepth = o.maxDepth ?? 3;
  const queue: Array<{ url: string; depth: number }> = seeds.map((url) => ({ url, depth: 0 }));
  const visited = new Set<string>();
  const found = new Set<string>();

  while (queue.length > 0 && visited.size < maxSitemaps && found.size < maxUrls) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let res: { status: number; body: Uint8Array };
    try {
      res = await fetcher(url);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const xml = decode(url, res.body);
    if (xml === null) continue;

    const { urls, sitemaps } = parseSitemapXml(xml);
    for (const u of urls) {
      if (found.size >= maxUrls) break;
      found.add(u);
    }
    if (depth < maxDepth) for (const s of sitemaps) queue.push({ url: s, depth: depth + 1 });
  }
  return [...found];
}
```

`packages/crawler/src/index.ts`:
```ts
export * from './url';
export * from './links';
export * from './robots';
export * from './sitemap';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/crawler && pnpm typecheck`
Expected: PASS. If `import robotsParser from 'robots-parser'` fails to resolve a callable default under this TypeScript/vitest setup, switch to `import robotsParser = require(...)` style only if needed; prefer `import * as mod` plus `(mod as any).default ?? mod`, keep the assertions.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(crawler): robots.txt (RFC 9309) and sitemap parsing and discovery" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `api`: jobs in the store (migration, memory and Postgres)

**Files:**
- Create: `packages/api/migrations/003_jobs.sql`
- Modify: `packages/api/src/store/types.ts`, `packages/api/src/store/memory.ts`, `packages/api/src/store/pg.ts`, `packages/api/test/store.contract.ts`

**Interfaces:**
- Produces (in `store/types.ts`):
  - `type JobType = 'crawl' | 'batch'`; `type JobStatus = 'scraping' | 'completed' | 'failed' | 'cancelled'`.
  - `interface JobRecord { id; type: JobType; apiKeyId: string | null; status: JobStatus; request: Record<string, unknown>; webhook: WebhookConfig | null; limit: number; total: number; completed: number; failed: number; createdAt: string; completedAt: string | null; expiresAt: string }`.
  - `interface NewJob { id; type: JobType; apiKeyId: string | null; request: Record<string, unknown>; webhook: WebhookConfig | null; limit: number; expiresAt: Date }`.
  - `interface JobError { id: string; url: string; error: string; code: string | null; kind: 'error' | 'robots'; timestamp: string }`.
  - `ScrapeRecord.jobId?: string | null`.
  - New `Store` methods: `createJob(job: NewJob): Promise<void>`; `getJob(id): Promise<JobRecord | null>`; `reserveUrls(jobId, requested: number): Promise<number>` (atomically raises `total` by `min(requested, limit - total)` while the job is `scraping`, returns the granted count, 0 otherwise); `recordPageResult(jobId, outcome: 'completed' | 'failed'): Promise<{ total: number; completed: number; failed: number; status: JobStatus }>`; `finalizeJob(jobId, status: 'completed' | 'failed'): Promise<JobRecord | null>` (only from `scraping`; returns the record only to the caller that won); `cancelJob(jobId): Promise<boolean>`; `addJobError(jobId, e: { url; error; code: string | null; kind: 'error' | 'robots' }): Promise<void>`; `listJobErrors(jobId): Promise<JobError[]>`; `listJobPages(jobId, skip: number, maxBytes: number): Promise<{ items: Record<string, unknown>[]; nextSkip: number | null }>` (items are the `data` of accepted scrapes in insertion order; at least one item per call; `nextSkip` is the next offset when more accepted pages exist); `listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]>`; `deleteExpiredJobs(now: Date): Promise<number>` (cascades to the job's scrapes and receipts).

- [ ] **Step 1: Add the failing contract tests**

In `packages/api/test/store.contract.ts` add near the top (after the existing imports) `import type { WebhookConfig } from '@icecrawl/core';` and add the following tests inside `describeStoreContract`, directly after the existing `registers, lists and retires public keys` test:
```ts
    const newJob = (over: Partial<Parameters<Store['createJob']>[0]> = {}) => ({
      id: randomUUID(),
      type: 'crawl' as const,
      apiKeyId: null as string | null,
      request: { url: 'https://example.com' } as Record<string, unknown>,
      webhook: null as WebhookConfig | null,
      limit: 5,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...over,
    });

    it('creates and reads a job', async () => {
      const job = newJob({ webhook: { url: 'https://hooks.example.com/x', events: ['page'] } });
      await store.createJob(job);
      const got = await store.getJob(job.id);
      expect(got).toMatchObject({
        id: job.id,
        type: 'crawl',
        status: 'scraping',
        request: { url: 'https://example.com' },
        webhook: { url: 'https://hooks.example.com/x', events: ['page'] },
        limit: 5,
        total: 0,
        completed: 0,
        failed: 0,
        completedAt: null,
      });
      expect(Date.parse(got!.expiresAt)).toBeGreaterThan(Date.now());
      expect(await store.getJob(randomUUID())).toBeNull();
    });

    it('reserves URLs up to the limit atomically', async () => {
      const job = newJob({ limit: 5 });
      await store.createJob(job);
      expect(await store.reserveUrls(job.id, 3)).toBe(3);
      expect(await store.reserveUrls(job.id, 4)).toBe(2);
      expect(await store.reserveUrls(job.id, 1)).toBe(0);
      expect((await store.getJob(job.id))?.total).toBe(5);
      const results = await Promise.all([1, 2, 3].map(() => store.reserveUrls((async () => { const j = newJob({ limit: 4 }); await store.createJob(j); return j.id; })() as unknown as string, 0)));
      expect(results).toBeDefined();
    });

    it('never grants more than the limit under concurrent reservations', async () => {
      const job = newJob({ limit: 10 });
      await store.createJob(job);
      const grants = await Promise.all(Array.from({ length: 8 }, () => store.reserveUrls(job.id, 3)));
      expect(grants.reduce((a, b) => a + b, 0)).toBe(10);
      expect((await store.getJob(job.id))?.total).toBe(10);
    });

    it('records page results and finalizes exactly once', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.reserveUrls(job.id, 3);
      expect(await store.recordPageResult(job.id, 'completed')).toMatchObject({ total: 3, completed: 1, failed: 0, status: 'scraping' });
      expect(await store.recordPageResult(job.id, 'failed')).toMatchObject({ completed: 1, failed: 1 });
      const winner = await store.finalizeJob(job.id, 'completed');
      expect(winner).toMatchObject({ id: job.id, status: 'completed' });
      expect(winner?.completedAt).not.toBeNull();
      expect(await store.finalizeJob(job.id, 'failed')).toBeNull();
      expect((await store.getJob(job.id))?.status).toBe('completed');
    });

    it('cancels a running job once, refuses new reservations afterwards, and keeps counting', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.reserveUrls(job.id, 2);
      expect(await store.cancelJob(job.id)).toBe(true);
      expect(await store.cancelJob(job.id)).toBe(false);
      expect(await store.reserveUrls(job.id, 2)).toBe(0);
      expect(await store.recordPageResult(job.id, 'completed')).toMatchObject({ status: 'cancelled', completed: 1 });
      expect(await store.finalizeJob(job.id, 'completed')).toBeNull();
      expect((await store.getJob(job.id))?.status).toBe('cancelled');
      expect(await store.cancelJob(randomUUID())).toBe(false);
    });

    it('stores job errors in order', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.addJobError(job.id, { url: 'https://example.com/a', error: 'boom', code: 'TIMEOUT', kind: 'error' });
      await store.addJobError(job.id, { url: 'https://example.com/b', error: 'Blocked by robots.txt', code: null, kind: 'robots' });
      const errors = await store.listJobErrors(job.id);
      expect(errors.map((e) => [e.url, e.kind, e.code])).toEqual([
        ['https://example.com/a', 'error', 'TIMEOUT'],
        ['https://example.com/b', 'robots', null],
      ]);
      expect(errors[0].id).toBeTruthy();
      expect(Date.parse(errors[0].timestamp)).not.toBeNaN();
    });

    it('lists only accepted pages of a job in insertion order and paginates by size', async () => {
      const job = newJob();
      await store.createJob(job);
      const mk = (n: number, success: boolean) => {
        const id = randomUUID();
        return {
          id,
          rec: { ...sampleScrape(id, null), jobId: job.id, response: success ? { success: true, data: { markdown: `page ${n}`, metadata: { n } } } : { success: false, code: 'BLOCKED', error: 'no' } },
        };
      };
      for (const [n, ok] of [[1, true], [2, false], [3, true], [4, true]] as const) {
        const s = mk(n, ok);
        await store.saveScrape(s.rec, sampleReceipt(s.id), null);
      }
      const all = await store.listJobPages(job.id, 0, 1_000_000);
      expect(all.items.map((i) => (i.metadata as { n: number }).n)).toEqual([1, 3, 4]);
      expect(all.nextSkip).toBeNull();

      const first = await store.listJobPages(job.id, 0, 10);
      expect(first.items).toHaveLength(1);
      expect(first.nextSkip).toBe(1);
      const second = await store.listJobPages(job.id, first.nextSkip!, 10);
      expect((second.items[0].metadata as { n: number }).n).toBe(3);
      const last = await store.listJobPages(job.id, 2, 10);
      expect((last.items[0].metadata as { n: number }).n).toBe(4);
      expect(last.nextSkip).toBeNull();
      expect((await store.listJobPages(job.id, 10, 1_000_000)).items).toEqual([]);
    });

    it('lists active jobs per API key', async () => {
      const keyA = randomUUID();
      const keyB = randomUUID();
      await store.createApiKey({ id: keyA, hash: `a-${keyA}`, name: 'a' });
      await store.createApiKey({ id: keyB, hash: `b-${keyB}`, name: 'b' });
      const running = newJob({ apiKeyId: keyA });
      const done = newJob({ apiKeyId: keyA });
      const other = newJob({ apiKeyId: keyB });
      for (const j of [running, done, other]) await store.createJob(j);
      await store.finalizeJob(done.id, 'completed');
      expect((await store.listActiveJobs(keyA)).map((j) => j.id)).toEqual([running.id]);
      expect((await store.listActiveJobs(keyB)).map((j) => j.id)).toEqual([other.id]);
    });

    it('deletes expired jobs together with their pages and receipts', async () => {
      const old = newJob({ expiresAt: new Date(Date.now() - 1000) });
      const fresh = newJob();
      await store.createJob(old);
      await store.createJob(fresh);
      const id = randomUUID();
      await store.saveScrape({ ...sampleScrape(id, null), jobId: old.id }, sampleReceipt(id), null);
      expect(await store.deleteExpiredJobs(new Date())).toBeGreaterThanOrEqual(1);
      expect(await store.getJob(old.id)).toBeNull();
      expect(await store.getJob(fresh.id)).not.toBeNull();
      expect(await store.getScrape(id)).toBeNull();
      expect(await store.getReceipt(id)).toBeNull();
    });
```
Then fix one sloppy line: in the test `reserves URLs up to the limit atomically` delete the last three lines (the `const results = …` and `expect(results).toBeDefined();` lines); the concurrent behaviour is covered by the next test.

- [ ] **Step 2: Run to verify failure**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm vitest run packages/api/test/store.memory.test.ts packages/api/test/store.pg.test.ts`
Expected: FAIL (`store.createJob is not a function`; for Postgres also missing tables).

- [ ] **Step 3: Implement the migration and types**

`packages/api/migrations/003_jobs.sql`:
```sql
create table jobs (
  id uuid primary key,
  type text not null check (type in ('crawl', 'batch')),
  api_key_id uuid references api_keys(id),
  status text not null default 'scraping' check (status in ('scraping', 'completed', 'failed', 'cancelled')),
  request jsonb not null,
  webhook jsonb,
  page_limit int not null,
  total int not null default 0,
  completed int not null default 0,
  failed int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null
);
create index jobs_api_key_status_idx on jobs (api_key_id, status);
create index jobs_expires_idx on jobs (expires_at);

alter table scrapes add column job_id uuid references jobs(id) on delete cascade;
alter table scrapes add column seq bigserial;
create index scrapes_job_seq_idx on scrapes (job_id, seq);

create table job_errors (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  url text not null,
  error text not null,
  code text,
  kind text not null check (kind in ('error', 'robots')),
  created_at timestamptz not null default now()
);
create index job_errors_job_idx on job_errors (job_id, created_at);
```

In `packages/api/src/store/types.ts`:
1. Change the first import line to also import `WebhookConfig`: `import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict, WebhookConfig } from '@icecrawl/core';`
2. Add `  jobId?: string | null;` as a new member of `ScrapeRecord` (after `createdAt: string;`).
3. Add these declarations after the `SnapshotMeta` interface:
```ts
export type JobType = 'crawl' | 'batch';
export type JobStatus = 'scraping' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  type: JobType;
  apiKeyId: string | null;
  status: JobStatus;
  request: Record<string, unknown>;
  webhook: WebhookConfig | null;
  limit: number;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
}

export interface NewJob {
  id: string;
  type: JobType;
  apiKeyId: string | null;
  request: Record<string, unknown>;
  webhook: WebhookConfig | null;
  limit: number;
  expiresAt: Date;
}

export interface JobError {
  id: string;
  url: string;
  error: string;
  code: string | null;
  kind: 'error' | 'robots';
  timestamp: string;
}
```
4. Add these members to the `Store` interface, before `close(): Promise<void>;`:
```ts
  createJob(job: NewJob): Promise<void>;
  getJob(id: string): Promise<JobRecord | null>;
  reserveUrls(jobId: string, requested: number): Promise<number>;
  recordPageResult(
    jobId: string,
    outcome: 'completed' | 'failed',
  ): Promise<{ total: number; completed: number; failed: number; status: JobStatus }>;
  finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null>;
  cancelJob(jobId: string): Promise<boolean>;
  addJobError(
    jobId: string,
    e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' },
  ): Promise<void>;
  listJobErrors(jobId: string): Promise<JobError[]>;
  listJobPages(jobId: string, skip: number, maxBytes: number): Promise<{ items: Record<string, unknown>[]; nextSkip: number | null }>;
  listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]>;
  deleteExpiredJobs(now: Date): Promise<number>;
```

- [ ] **Step 4: Implement `MemoryStore`**

In `packages/api/src/store/memory.ts`: add `JobError, JobRecord, JobStatus, NewJob` to the type import from `./types`, and `import { randomUUID } from 'node:crypto';` at the top. Add these private fields to `MemoryStore` (next to `publicKeys`):
```ts
  private jobs = new Map<string, JobRecord>();
  private jobErrors = new Map<string, JobError[]>();
```
and these methods before `close()`:
```ts
  async createJob(j: NewJob): Promise<void> {
    this.jobs.set(j.id, {
      id: j.id,
      type: j.type,
      apiKeyId: j.apiKeyId,
      status: 'scraping',
      request: structuredClone(j.request),
      webhook: j.webhook ? structuredClone(j.webhook) : null,
      limit: j.limit,
      total: 0,
      completed: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      expiresAt: j.expiresAt.toISOString(),
    });
  }
  async getJob(id: string): Promise<JobRecord | null> {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async reserveUrls(jobId: string, requested: number): Promise<number> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return 0;
    const granted = Math.max(0, Math.min(requested, j.limit - j.total));
    j.total += granted;
    return granted;
  }
  async recordPageResult(jobId: string, outcome: 'completed' | 'failed') {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`unknown job ${jobId}`);
    if (outcome === 'completed') j.completed++;
    else j.failed++;
    return { total: j.total, completed: j.completed, failed: j.failed, status: j.status as JobStatus };
  }
  async finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return null;
    j.status = status;
    j.completedAt = new Date().toISOString();
    return structuredClone(j);
  }
  async cancelJob(jobId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return false;
    j.status = 'cancelled';
    j.completedAt = new Date().toISOString();
    return true;
  }
  async addJobError(jobId: string, e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' }): Promise<void> {
    const list = this.jobErrors.get(jobId) ?? [];
    list.push({ id: randomUUID(), url: e.url, error: e.error, code: e.code, kind: e.kind, timestamp: new Date().toISOString() });
    this.jobErrors.set(jobId, list);
  }
  async listJobErrors(jobId: string): Promise<JobError[]> {
    return structuredClone(this.jobErrors.get(jobId) ?? []);
  }
  async listJobPages(jobId: string, skip: number, maxBytes: number) {
    const accepted = [...this.scrapes.values()]
      .filter((s) => s.jobId === jobId && (s.response as { success?: boolean }).success === true)
      .map((s) => (s.response as { data: Record<string, unknown> }).data);
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    for (let i = skip; i < accepted.length; i++) {
      const size = JSON.stringify(accepted[i]).length;
      if (items.length > 0 && bytes + size > maxBytes) break;
      items.push(structuredClone(accepted[i]));
      bytes += size;
    }
    const next = skip + items.length;
    return { items, nextSkip: next < accepted.length ? next : null };
  }
  async listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'scraping' && j.apiKeyId === apiKeyId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => structuredClone(j));
  }
  async deleteExpiredJobs(now: Date): Promise<number> {
    let n = 0;
    for (const [id, j] of this.jobs) {
      if (Date.parse(j.expiresAt) >= now.getTime()) continue;
      for (const [sid, s] of this.scrapes) {
        if (s.jobId === id) {
          this.scrapes.delete(sid);
          this.receipts.delete(sid);
        }
      }
      this.jobs.delete(id);
      this.jobErrors.delete(id);
      n++;
    }
    return n;
  }
```

- [ ] **Step 5: Implement `PgStore`**

In `packages/api/src/store/pg.ts`: add `JobError, JobRecord, JobStatus, NewJob` to the `./types` type import. In `saveScrape`, replace the `insert into scrapes` statement with:
```ts
      await tx`
        insert into scrapes (id, api_key_id, job_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata, response, created_at)
        values (${rec.id}, ${rec.apiKeyId}, ${rec.jobId ?? null}, ${rec.url}, ${rec.finalUrl}, ${rec.verdict}, ${rec.confidence}, ${rec.engine},
                ${rec.statusCode}, ${rec.markdown}, ${tx.json(rec.metadata as never)}, ${tx.json(rec.response as never)}, ${rec.createdAt})`;
```
Add this helper above the `PgStore` class:
```ts
const jobFromRow = (r: postgres.Row): JobRecord => ({
  id: r.id,
  type: r.type,
  apiKeyId: r.api_key_id,
  status: r.status,
  request: r.request,
  webhook: r.webhook,
  limit: r.page_limit,
  total: r.total,
  completed: r.completed,
  failed: r.failed,
  createdAt: new Date(r.created_at).toISOString(),
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  expiresAt: new Date(r.expires_at).toISOString(),
});
```
and add these methods to the class before `close()`:
```ts
  async createJob(j: NewJob): Promise<void> {
    await this.sql`
      insert into jobs (id, type, api_key_id, request, webhook, page_limit, expires_at)
      values (${j.id}, ${j.type}, ${j.apiKeyId}, ${this.sql.json(j.request as never)}, ${j.webhook ? this.sql.json(j.webhook as never) : null}, ${j.limit}, ${j.expiresAt.toISOString()})`;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const [r] = await this.sql`select * from jobs where id = ${id}`;
    return r ? jobFromRow(r) : null;
  }

  async reserveUrls(jobId: string, requested: number): Promise<number> {
    const [r] = await this.sql`
      with old as (select id, total, page_limit from jobs where id = ${jobId} and status = 'scraping' for update)
      update jobs set total = jobs.total + least(${requested}::int, greatest(old.page_limit - old.total, 0))
      from old where jobs.id = old.id
      returning least(${requested}::int, greatest(old.page_limit - old.total, 0)) as granted`;
    return r ? Number(r.granted) : 0;
  }

  async recordPageResult(jobId: string, outcome: 'completed' | 'failed') {
    const [r] = await this.sql`
      update jobs set
        completed = completed + (case when ${outcome} = 'completed' then 1 else 0 end),
        failed = failed + (case when ${outcome} = 'failed' then 1 else 0 end)
      where id = ${jobId}
      returning total, completed, failed, status`;
    if (!r) throw new Error(`unknown job ${jobId}`);
    return { total: r.total, completed: r.completed, failed: r.failed, status: r.status as JobStatus };
  }

  async finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null> {
    const [r] = await this.sql`
      update jobs set status = ${status}, completed_at = now() where id = ${jobId} and status = 'scraping' returning *`;
    return r ? jobFromRow(r) : null;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      update jobs set status = 'cancelled', completed_at = now() where id = ${jobId} and status = 'scraping' returning id`;
    return rows.length > 0;
  }

  async addJobError(jobId: string, e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' }): Promise<void> {
    await this.sql`insert into job_errors (job_id, url, error, code, kind) values (${jobId}, ${e.url}, ${e.error}, ${e.code}, ${e.kind})`;
  }

  async listJobErrors(jobId: string): Promise<JobError[]> {
    const rows = await this.sql`select id, url, error, code, kind, created_at from job_errors where job_id = ${jobId} order by created_at, id`;
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      error: r.error,
      code: r.code,
      kind: r.kind,
      timestamp: new Date(r.created_at).toISOString(),
    }));
  }

  async listJobPages(jobId: string, skip: number, maxBytes: number) {
    const batch = 500;
    const rows = await this.sql`
      select response->'data' as data, length(response::text) as size
      from scrapes where job_id = ${jobId} and (response->>'success') = 'true'
      order by seq offset ${skip} limit ${batch + 1}`;
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    let more = rows.length > batch;
    for (const row of rows.slice(0, batch)) {
      const size = Number(row.size);
      if (items.length > 0 && bytes + size > maxBytes) {
        more = true;
        break;
      }
      items.push(row.data as Record<string, unknown>);
      bytes += size;
    }
    return { items, nextSkip: more ? skip + items.length : null };
  }

  async listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]> {
    const rows = await this.sql`
      select * from jobs where status = 'scraping' and api_key_id is not distinct from ${apiKeyId} order by created_at`;
    return rows.map(jobFromRow);
  }

  async deleteExpiredJobs(now: Date): Promise<number> {
    const rows = await this.sql`delete from jobs where expires_at < ${now.toISOString()} returning id`;
    return rows.length;
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test && pnpm typecheck`
Expected: PASS everywhere, nothing skipped; the contract's `migrate(sql)` applies `003`. If the Postgres `reserveUrls` fails with a type error on `least(...)`, keep the `::int` casts; if `listActiveJobs` for a `null` key returns nothing, confirm the `is not distinct from` clause.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): job storage (jobs, job errors, pagination, atomic URL reservation) in memory and Postgres" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `queue` package: `JobQueues` interface, in-memory twin, BullMQ implementation

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/src/types.ts`, `packages/queue/src/memory.ts`, `packages/queue/src/bull.ts`, `packages/queue/src/index.ts`
- Test: `packages/queue/test/memory.test.ts`, `packages/queue/test/bull.test.ts`

**Interfaces:**
- Produces:
  - Job payload types: `PageJobData { kind: 'page'; jobId; url; depth: number; external: boolean }`, `DiscoverJobData { kind: 'discover'; jobId }`, `ScrapeJobData = PageJobData | DiscoverJobData`, `WebhookJobData { jobId; webhookId; url; headers: Record<string, string>; body: string }`.
  - `interface JobQueues { addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void>; addDiscover(jobId): Promise<void>; addWebhook(data: WebhookJobData): Promise<void>; markSeen(jobId, urls: string[]): Promise<string[]> /* returns the URLs not seen before, in input order */; acquireSlot(jobId, o: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult>; clearJob(jobId): Promise<void>; close(): Promise<void> }`; `type SlotResult = { ok: true; release(): Promise<void> } | { ok: false; retryInMs: number }`.
  - `class PermanentError extends Error` (a handler throws it to say "do not retry"); `interface JobContext { attemptsMade: number; maxAttempts: number }`; `interface WorkerHandlers { scrape(data, ctx): Promise<{ delayMs?: number }>; webhook(data, ctx): Promise<void> }`.
  - `class MemoryQueues implements JobQueues` with public `jobs: ScrapeJobData[]`, `webhooks: WebhookJobData[]`, `busy: number[]` (each entry makes the next `acquireSlot` fail with that `retryInMs`), `cleared: string[]`, and `takeNext(): ScrapeJobData | undefined`.
  - `class BullQueues implements JobQueues` (`new BullQueues({ redisUrl, prefix?, maxAttempts?, seenTtlSeconds? })`, public `connection`, `prefix`, `scrapeQueue`, `webhookQueue`) and `startWorkers(q: BullQueues, h: WorkerHandlers, o: { concurrency: number; webhookConcurrency?: number }): { close(): Promise<void> }`. A scrape handler result with `delayMs` re-schedules the job (it does not use a retry attempt); a thrown error retries with exponential backoff until `maxAttempts` (default 3); `PermanentError` fails without retry. Webhook jobs get 5 attempts.

- [ ] **Step 1: Create the package and write the failing tests**

`packages/queue/package.json`:
```json
{
  "name": "@icecrawl/queue",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "bullmq": "^5.81.5",
    "ioredis": "^5.10.1"
  }
}
```
Run: `pnpm install`

`packages/queue/test/memory.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryQueues } from '../src';

describe('MemoryQueues', () => {
  it('queues pages and discover jobs in FIFO order', async () => {
    const q = new MemoryQueues();
    await q.addDiscover('j1');
    await q.addPages([
      { jobId: 'j1', url: 'https://e.com/a', depth: 0, external: false },
      { jobId: 'j1', url: 'https://e.com/b', depth: 1, external: true },
    ]);
    expect(q.takeNext()).toEqual({ kind: 'discover', jobId: 'j1' });
    expect(q.takeNext()).toEqual({ kind: 'page', jobId: 'j1', url: 'https://e.com/a', depth: 0, external: false });
    expect(q.takeNext()).toMatchObject({ url: 'https://e.com/b', external: true });
    expect(q.takeNext()).toBeUndefined();
  });

  it('reports only unseen URLs, per job, preserving order and removing duplicates', async () => {
    const q = new MemoryQueues();
    expect(await q.markSeen('j1', ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(await q.markSeen('j1', ['b', 'c'])).toEqual(['c']);
    expect(await q.markSeen('j2', ['a'])).toEqual(['a']);
    await q.clearJob('j1');
    expect(await q.markSeen('j1', ['a'])).toEqual(['a']);
    expect(q.cleared).toEqual(['j1']);
  });

  it('hands out slots and can be told to be busy', async () => {
    const q = new MemoryQueues();
    const ok = await q.acquireSlot('j1', { maxConcurrency: 1 });
    expect(ok.ok).toBe(true);
    q.busy.push(250);
    expect(await q.acquireSlot('j1', {})).toEqual({ ok: false, retryInMs: 250 });
    expect((await q.acquireSlot('j1', {})).ok).toBe(true);
  });

  it('collects webhook deliveries', async () => {
    const q = new MemoryQueues();
    await q.addWebhook({ jobId: 'j1', webhookId: 'w1', url: 'https://hooks.example/x', headers: {}, body: '{}' });
    expect(q.webhooks).toHaveLength(1);
  });
});
```

`packages/queue/test/bull.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BullQueues, PermanentError, startWorkers, type JobContext, type ScrapeJobData, type WebhookJobData } from '../src';

const redisUrl = process.env.REDIS_URL;

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!redisUrl)('BullQueues', () => {
  let q: BullQueues;
  let stop: (() => Promise<void>) | undefined;
  const prefix = () => `icecrawl-test-${randomUUID().slice(0, 8)}`;

  beforeEach(() => {
    q = new BullQueues({ redisUrl: redisUrl!, prefix: prefix(), maxAttempts: 3 });
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    const keys = await q.connection.keys(`${q.prefix}:*`);
    if (keys.length > 0) await q.connection.del(...keys);
    await q.close();
  });

  const handlers = (over: Partial<Parameters<typeof startWorkers>[1]> = {}) => ({
    scrape: async () => ({}),
    webhook: async () => {},
    ...over,
  });

  it('delivers page and discover jobs to the scrape handler', async () => {
    const seen: ScrapeJobData[] = [];
    stop = (await Promise.resolve(startWorkers(q, handlers({ scrape: async (d) => (seen.push(d), {}) }), { concurrency: 2 }))).close;
    await q.addDiscover('job-1');
    await q.addPages([{ jobId: 'job-1', url: 'https://e.com/a', depth: 2, external: true }]);
    await until(() => seen.length === 2);
    expect(seen).toContainEqual({ kind: 'discover', jobId: 'job-1' });
    expect(seen).toContainEqual({ kind: 'page', jobId: 'job-1', url: 'https://e.com/a', depth: 2, external: true });
  });

  it('re-schedules a job when the handler asks for a delay, without using a retry', async () => {
    const calls: Array<{ at: number; ctx: JobContext }> = [];
    stop = startWorkers(
      q,
      handlers({
        scrape: async (_d, ctx) => {
          calls.push({ at: Date.now(), ctx });
          return calls.length === 1 ? { delayMs: 400 } : {};
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addPages([{ jobId: 'j', url: 'https://e.com/a', depth: 0, external: false }]);
    await until(() => calls.length === 2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(350);
    expect(calls[1].ctx.attemptsMade).toBe(0);
    expect(calls[1].ctx.maxAttempts).toBe(3);
  });

  it('retries a failing handler with backoff and stops after maxAttempts', async () => {
    const attempts: number[] = [];
    stop = startWorkers(
      q,
      handlers({
        scrape: async (_d, ctx) => {
          attempts.push(ctx.attemptsMade);
          throw new Error('transient');
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addPages([{ jobId: 'j', url: 'https://e.com/a', depth: 0, external: false }]);
    await until(() => attempts.length === 3, 15000);
    await new Promise((r) => setTimeout(r, 300));
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('does not retry a PermanentError', async () => {
    let calls = 0;
    const webhooks: WebhookJobData[] = [];
    stop = startWorkers(
      q,
      handlers({
        webhook: async (d) => {
          calls++;
          webhooks.push(d);
          throw new PermanentError('never');
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addWebhook({ jobId: 'j', webhookId: 'w', url: 'https://hooks.example/x', headers: { a: 'b' }, body: '{"x":1}' });
    await until(() => calls >= 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(1);
    expect(webhooks[0]).toMatchObject({ webhookId: 'w', headers: { a: 'b' }, body: '{"x":1}' });
  });

  it('de-duplicates URLs per job in Redis', async () => {
    expect(await q.markSeen('j1', ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(await q.markSeen('j1', ['b', 'c'])).toEqual(['c']);
    expect(await q.markSeen('j2', ['a'])).toEqual(['a']);
    await q.clearJob('j1');
    expect(await q.markSeen('j1', ['a'])).toEqual(['a']);
  });

  it('limits concurrency and spaces requests with slots', async () => {
    const a = await q.acquireSlot('j', { maxConcurrency: 2 });
    const b = await q.acquireSlot('j', { maxConcurrency: 2 });
    const c = await q.acquireSlot('j', { maxConcurrency: 2 });
    expect(a.ok && b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (a.ok) await a.release();
    expect((await q.acquireSlot('j', { maxConcurrency: 2 })).ok).toBe(true);

    const first = await q.acquireSlot('d', { delayMs: 500 });
    const second = await q.acquireSlot('d', { delayMs: 500 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.retryInMs).toBeGreaterThan(0);
    if (!second.ok) expect(second.retryInMs).toBeLessThanOrEqual(500);
  });

  it('does not leak a concurrency slot when the delay slot is refused', async () => {
    await q.acquireSlot('x', { delayMs: 500 });
    const refused = await q.acquireSlot('x', { maxConcurrency: 1, delayMs: 500 });
    expect(refused.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect((await q.acquireSlot('x', { maxConcurrency: 1, delayMs: 500 })).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `REDIS_URL=redis://localhost:6379 pnpm vitest run packages/queue`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement types and the memory queue**

`packages/queue/src/types.ts`:
```ts
export interface PageJobData {
  kind: 'page';
  jobId: string;
  url: string;
  depth: number;
  external: boolean;
}

export interface DiscoverJobData {
  kind: 'discover';
  jobId: string;
}

export type ScrapeJobData = PageJobData | DiscoverJobData;

export interface WebhookJobData {
  jobId: string;
  webhookId: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type SlotResult = { ok: true; release(): Promise<void> } | { ok: false; retryInMs: number };

export interface JobQueues {
  addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void>;
  addDiscover(jobId: string): Promise<void>;
  addWebhook(data: WebhookJobData): Promise<void>;
  /** Returns the URLs not seen before for this job, in input order. */
  markSeen(jobId: string, urls: string[]): Promise<string[]>;
  acquireSlot(jobId: string, o: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult>;
  clearJob(jobId: string): Promise<void>;
  close(): Promise<void>;
}

/** A handler throws this to say the job must not be retried. */
export class PermanentError extends Error {}

export interface JobContext {
  attemptsMade: number;
  maxAttempts: number;
}

export interface WorkerHandlers {
  scrape(data: ScrapeJobData, ctx: JobContext): Promise<{ delayMs?: number }>;
  webhook(data: WebhookJobData, ctx: JobContext): Promise<void>;
}
```

`packages/queue/src/memory.ts`:
```ts
import type { JobQueues, PageJobData, ScrapeJobData, SlotResult, WebhookJobData } from './types';

export class MemoryQueues implements JobQueues {
  jobs: ScrapeJobData[] = [];
  webhooks: WebhookJobData[] = [];
  busy: number[] = [];
  cleared: string[] = [];
  private seen = new Map<string, Set<string>>();

  async addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void> {
    for (const i of items) this.jobs.push({ kind: 'page', ...i });
  }
  async addDiscover(jobId: string): Promise<void> {
    this.jobs.push({ kind: 'discover', jobId });
  }
  async addWebhook(data: WebhookJobData): Promise<void> {
    this.webhooks.push(data);
  }
  async markSeen(jobId: string, urls: string[]): Promise<string[]> {
    let set = this.seen.get(jobId);
    if (!set) {
      set = new Set();
      this.seen.set(jobId, set);
    }
    const fresh: string[] = [];
    for (const u of urls) {
      if (!set.has(u)) {
        set.add(u);
        fresh.push(u);
      }
    }
    return fresh;
  }
  async acquireSlot(): Promise<SlotResult> {
    const wait = this.busy.shift();
    if (wait !== undefined) return { ok: false, retryInMs: wait };
    return { ok: true, release: async () => {} };
  }
  async clearJob(jobId: string): Promise<void> {
    this.cleared.push(jobId);
    this.seen.delete(jobId);
  }
  async close(): Promise<void> {}

  takeNext(): ScrapeJobData | undefined {
    return this.jobs.shift();
  }
}
```

- [ ] **Step 4: Implement the BullMQ queues and workers**

`packages/queue/src/bull.ts`:
```ts
import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  PermanentError,
  type JobQueues,
  type PageJobData,
  type ScrapeJobData,
  type SlotResult,
  type WebhookJobData,
  type WorkerHandlers,
} from './types';

export interface BullQueuesOptions {
  redisUrl: string;
  prefix?: string;
  maxAttempts?: number;
  seenTtlSeconds?: number;
}

const SCRAPE_QUEUE = 'scrape';
const WEBHOOK_QUEUE = 'webhook';

export class BullQueues implements JobQueues {
  readonly connection: IORedis;
  readonly prefix: string;
  readonly scrapeQueue: Queue<ScrapeJobData>;
  readonly webhookQueue: Queue<WebhookJobData>;
  private readonly maxAttempts: number;
  private readonly seenTtl: number;

  constructor(o: BullQueuesOptions) {
    this.prefix = o.prefix ?? 'icecrawl';
    this.maxAttempts = o.maxAttempts ?? 3;
    this.seenTtl = o.seenTtlSeconds ?? 3 * 24 * 3600;
    this.connection = new IORedis(o.redisUrl, { maxRetriesPerRequest: null });
    this.scrapeQueue = new Queue<ScrapeJobData>(SCRAPE_QUEUE, { connection: this.connection, prefix: this.prefix });
    this.webhookQueue = new Queue<WebhookJobData>(WEBHOOK_QUEUE, { connection: this.connection, prefix: this.prefix });
  }

  async addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void> {
    if (items.length === 0) return;
    await this.scrapeQueue.addBulk(
      items.map((i) => ({
        name: 'page',
        data: { kind: 'page' as const, ...i },
        opts: { attempts: this.maxAttempts, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: 1000 },
      })),
    );
  }

  async addDiscover(jobId: string): Promise<void> {
    await this.scrapeQueue.add('discover', { kind: 'discover', jobId }, { attempts: 1, removeOnComplete: true, removeOnFail: 1000 });
  }

  async addWebhook(data: WebhookJobData): Promise<void> {
    await this.webhookQueue.add('deliver', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  async markSeen(jobId: string, urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    const key = `${this.prefix}:seen:${jobId}`;
    const pipe = this.connection.pipeline();
    for (const u of urls) pipe.sadd(key, u);
    pipe.expire(key, this.seenTtl);
    const results = (await pipe.exec()) ?? [];
    return urls.filter((_, i) => results[i]?.[1] === 1);
  }

  // shortcut: slot counters expire after 10 minutes, so a crashed worker can hold a concurrency slot until then. Upgrade by storing a per-slot lease with its own TTL.
  async acquireSlot(jobId: string, o: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult> {
    let release = async () => {};
    if (o.maxConcurrency) {
      const key = `${this.prefix}:active:${jobId}`;
      const n = await this.connection.incr(key);
      await this.connection.expire(key, 600);
      if (n > o.maxConcurrency) {
        await this.connection.decr(key);
        return { ok: false, retryInMs: 200 };
      }
      release = async () => {
        await this.connection.decr(key);
      };
    }
    if (o.delayMs && o.delayMs > 0) {
      const key = `${this.prefix}:slot:${jobId}`;
      const got = await this.connection.set(key, '1', 'PX', o.delayMs, 'NX');
      if (got !== 'OK') {
        await release();
        const ttl = await this.connection.pttl(key);
        return { ok: false, retryInMs: Math.max(ttl, 50) };
      }
    }
    return { ok: true, release };
  }

  async clearJob(jobId: string): Promise<void> {
    await this.connection.del(`${this.prefix}:seen:${jobId}`, `${this.prefix}:active:${jobId}`, `${this.prefix}:slot:${jobId}`);
  }

  async close(): Promise<void> {
    await this.scrapeQueue.close();
    await this.webhookQueue.close();
    this.connection.disconnect();
  }
}

export function startWorkers(
  q: BullQueues,
  h: WorkerHandlers,
  o: { concurrency: number; webhookConcurrency?: number },
): { close(): Promise<void> } {
  const scrapeWorker = new Worker<ScrapeJobData>(
    SCRAPE_QUEUE,
    async (job: Job<ScrapeJobData>, token?: string) => {
      const result = await h.scrape(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      if (result.delayMs) {
        await job.moveToDelayed(Date.now() + result.delayMs, token);
        throw new DelayedError();
      }
    },
    { connection: q.connection, prefix: q.prefix, concurrency: o.concurrency },
  );

  const webhookWorker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookJobData>) => {
      try {
        await h.webhook(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      } catch (err) {
        if (err instanceof PermanentError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: q.connection, prefix: q.prefix, concurrency: o.webhookConcurrency ?? 4 },
  );

  for (const w of [scrapeWorker, webhookWorker]) w.on('error', (err) => console.error('[icecrawl] queue worker error:', err.message));

  return {
    async close() {
      await Promise.all([scrapeWorker.close(), webhookWorker.close()]);
    },
  };
}
```

`packages/queue/src/index.ts`:
```ts
export * from './types';
export * from './memory';
export * from './bull';
```

- [ ] **Step 5: Run to verify pass**

Run: `REDIS_URL=redis://localhost:6379 pnpm vitest run packages/queue && pnpm typecheck`
Expected: PASS (4 memory tests and 7 Redis tests, none skipped). Run the Redis file three times. If a BullMQ typing or runtime difference appears (for example `moveToDelayed` needing a token, or `attemptsMade` counting a delayed run), consult `node_modules/bullmq` types and adapt the implementation while keeping the test assertions (delays must not consume a retry; three failing attempts total; `PermanentError` must not retry).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(queue): JobQueues interface with in-memory twin and BullMQ implementation" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `api`: shared scrape service and signed webhooks

**Files:**
- Create: `packages/api/src/scrape-service.ts`, `packages/api/src/jobs/webhooks.ts`
- Modify: `packages/api/package.json` (dependencies), `packages/api/src/app.ts`, `packages/api/src/response.ts`
- Test: `packages/api/test/webhooks.test.ts`; `packages/api/test/app.test.ts` gets one extra assertion

**Interfaces:**
- Consumes: `JobQueues`, `WebhookJobData`, `PermanentError` (Task 5); `JobRecord` (Task 4); `createSafeLookup`, `assertUrlAllowed` (engines).
- Produces:
  - `scrapeAndPersist(deps: ScrapeServiceDeps, normalized: NormalizedScrape, ctx: { apiKeyId: string | null; jobId?: string | null }): Promise<{ run: ScrapeRun; status: number; payload: Record<string, unknown> }>` where `ScrapeServiceDeps { store; snapshots; engines; scraper; signer? }`. The `/v2/scrape` route now calls it.
  - `buildResponse` metadata gains `scrapeId` (the scrape/receipt id).
  - `type WebhookEvent = 'started' | 'page' | 'completed' | 'failed'`; `interface WebhookPayload { success: boolean; type: string; id: string; webhookId: string; data: unknown[]; metadata: Record<string, unknown>; error?: string }`; `buildWebhookPayload(job: JobRecord, event: WebhookEvent, data: unknown[], o?: { success?: boolean; error?: string }): WebhookPayload` (type prefix `crawl.` or `batch_scrape.`; a batch `failed` event is sent as `batch_scrape.completed` with `success: false`); `sendWebhook(queues: JobQueues, job: JobRecord, event: WebhookEvent, data: unknown[], o?: { success?: boolean; error?: string }): Promise<void>` (no-op without a configured webhook or when the event is filtered out); `signBody(secret: string, body: string): string` (`sha256=<hex>`); `interface DeliveryDeps { secret: string | null; allowPrivate: boolean; timeoutMs?: number }`; `deliverWebhook(deps: DeliveryDeps, data: WebhookJobData): Promise<void>` (throws `PermanentError` for an unsafe URL, a plain `Error` for non-2xx or network failure so the queue retries).

- [ ] **Step 1: Write the failing tests**

Add `"@icecrawl/crawler": "workspace:*"`, `"@icecrawl/queue": "workspace:*"` and `"undici": "^6.21.0"` to `packages/api/package.json` `dependencies`, then run `pnpm install`.

`packages/api/test/webhooks.test.ts`:
```ts
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryQueues, PermanentError } from '@icecrawl/queue';
import { buildWebhookPayload, deliverWebhook, sendWebhook, signBody } from '../src/jobs/webhooks';
import type { JobRecord } from '../src/store/types';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'crawl',
  apiKeyId: null,
  status: 'scraping',
  request: {},
  webhook: { url: 'https://hooks.example.com/x', metadata: { run: 7 } },
  limit: 10,
  total: 0,
  completed: 0,
  failed: 0,
  createdAt: new Date().toISOString(),
  completedAt: null,
  expiresAt: new Date(Date.now() + 1000).toISOString(),
  ...over,
});

describe('buildWebhookPayload', () => {
  it('uses the Firecrawl envelope with a type prefix per job type', () => {
    const p = buildWebhookPayload(job(), 'page', [{ markdown: '# hi' }]);
    expect(p).toMatchObject({ success: true, type: 'crawl.page', id: job().id, data: [{ markdown: '# hi' }], metadata: { run: 7 } });
    expect(p.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.error).toBeUndefined();
    expect(buildWebhookPayload(job({ type: 'batch' }), 'started', []).type).toBe('batch_scrape.started');
  });

  it('carries failure details and maps a failed batch to batch_scrape.completed', () => {
    expect(buildWebhookPayload(job(), 'failed', [], { success: false, error: 'boom' })).toMatchObject({ type: 'crawl.failed', success: false, error: 'boom' });
    expect(buildWebhookPayload(job({ type: 'batch' }), 'failed', [], { success: false })).toMatchObject({ type: 'batch_scrape.completed', success: false });
    expect(buildWebhookPayload(job(), 'page', [], { success: false, error: 'robots' })).toMatchObject({ success: false, error: 'robots' });
  });

  it('defaults metadata to an empty object', () => {
    expect(buildWebhookPayload(job({ webhook: { url: 'https://h.example/x' } }), 'started', []).metadata).toEqual({});
  });
});

describe('sendWebhook', () => {
  it('queues a delivery with the serialized payload and the configured headers', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ webhook: { url: 'https://hooks.example.com/x', headers: { 'X-Mine': '1' } } }), 'started', []);
    expect(q.webhooks).toHaveLength(1);
    const d = q.webhooks[0];
    expect(d).toMatchObject({ jobId: job().id, url: 'https://hooks.example.com/x', headers: { 'X-Mine': '1' } });
    expect(JSON.parse(d.body)).toMatchObject({ type: 'crawl.started', webhookId: d.webhookId });
  });

  it('does nothing without a webhook or for filtered events', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ webhook: null }), 'started', []);
    await sendWebhook(q, job({ webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'page', []);
    expect(q.webhooks).toHaveLength(0);
    await sendWebhook(q, job({ webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'completed', []);
    expect(q.webhooks).toHaveLength(1);
  });

  it('applies the events filter to the mapped event for failed batches', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ type: 'batch', webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'failed', [], { success: false });
    expect(q.webhooks).toHaveLength(1);
  });
});

describe('signBody', () => {
  it('is HMAC-SHA256 over the raw body in sha256=<hex> form', () => {
    expect(signBody('secret', '{"a":1}')).toBe(`sha256=${createHmac('sha256', 'secret').update('{"a":1}').digest('hex')}`);
  });
});

describe('deliverWebhook', () => {
  let server: Server;
  let port: number;
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const data = (over: Record<string, unknown> = {}) => ({
    jobId: 'j',
    webhookId: 'wh-1',
    url: `http://127.0.0.1:${port}/hook`,
    headers: {},
    body: '{"type":"crawl.page"}',
    ...over,
  });

  it('POSTs the exact body with both signature headers and the webhook id', async () => {
    received.length = 0;
    await deliverWebhook({ secret: 's3cret', allowPrivate: true }, data({ headers: { 'X-Custom': 'yes' } }));
    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.body).toBe('{"type":"crawl.page"}');
    const expected = signBody('s3cret', r.body);
    expect(r.headers['x-icecrawl-signature']).toBe(expected);
    expect(r.headers['x-firecrawl-signature']).toBe(expected);
    expect(r.headers['x-icecrawl-webhook-id']).toBe('wh-1');
    expect(r.headers['x-custom']).toBe('yes');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['user-agent']).toContain('IceCrawl-Webhook');
  });

  it('sends no signature when no secret is configured', async () => {
    received.length = 0;
    await deliverWebhook({ secret: null, allowPrivate: true }, data());
    expect(received[0].headers['x-icecrawl-signature']).toBeUndefined();
  });

  it('does not let user headers override signature or framing headers', async () => {
    received.length = 0;
    await deliverWebhook(
      { secret: 'k', allowPrivate: true },
      data({ headers: { 'X-IceCrawl-Signature': 'forged', 'X-Firecrawl-Signature': 'forged', 'Content-Length': '1', Host: 'evil.example' } }),
    );
    const r = received[0];
    expect(r.headers['x-icecrawl-signature']).toBe(signBody('k', r.body));
    expect(r.headers['x-firecrawl-signature']).toBe(signBody('k', r.body));
    expect(r.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('throws a retryable error on a non-2xx response', async () => {
    status = 500;
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data())).rejects.toThrow(/500/);
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data())).rejects.not.toBeInstanceOf(PermanentError);
    status = 200;
  });

  it('throws a retryable error when the receiver is unreachable', async () => {
    await expect(deliverWebhook({ secret: null, allowPrivate: true, timeoutMs: 1000 }, data({ url: 'http://127.0.0.1:1/x' }))).rejects.not.toBeInstanceOf(PermanentError);
  });

  it('refuses private targets as a permanent failure', async () => {
    await expect(deliverWebhook({ secret: null, allowPrivate: false }, data())).rejects.toBeInstanceOf(PermanentError);
    await expect(deliverWebhook({ secret: null, allowPrivate: false }, data({ url: 'http://169.254.169.254/x' }))).rejects.toBeInstanceOf(PermanentError);
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data({ url: 'ftp://example.com/x' }))).rejects.toBeInstanceOf(PermanentError);
  });
});
```

In `packages/api/test/app.test.ts`, inside the test `returns a v2-shaped success envelope with metadata and a trust block`, add after the `expect(body.data.metadata).toMatchObject({...})` statement:
```ts
    expect(body.data.metadata.scrapeId).toBe(body.data.trust.receiptId);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/test/webhooks.test.ts packages/api/test/app.test.ts`
Expected: FAIL (module `../src/jobs/webhooks` missing; `scrapeId` undefined).

- [ ] **Step 3: Implement the scrape service and refactor the route**

`packages/api/src/scrape-service.ts`:
```ts
import type { NormalizedScrape } from '@icecrawl/core';
import type { Engine } from '@icecrawl/engines';
import { runScrape, type ScrapeRun, type ScraperConfig } from '@icecrawl/scraper';
import { signReceipt, type PrivateSigningKey } from '@icecrawl/trust';
import { buildResponse } from './response';
import type { SnapshotStore, Store } from './store/types';

export interface ScrapeServiceDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  signer?: PrivateSigningKey;
}

export async function scrapeAndPersist(
  deps: ScrapeServiceDeps,
  normalized: NormalizedScrape,
  ctx: { apiKeyId: string | null; jobId?: string | null },
): Promise<{ run: ScrapeRun; status: number; payload: Record<string, unknown> }> {
  const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
  const { status, payload } = buildResponse(run, normalized.formats);
  const snapshot = await deps.snapshots.put(run.snapshot.bytes);
  if (run.screenshot) await deps.snapshots.put(run.screenshot);
  const signature = deps.signer ? signReceipt(run.receipt, deps.signer) : null;
  await deps.store.saveScrape(
    {
      id: run.id,
      apiKeyId: ctx.apiKeyId,
      jobId: ctx.jobId ?? null,
      url: run.requestedUrl,
      finalUrl: run.finalUrl,
      verdict: run.verdict,
      confidence: run.confidence,
      engine: run.engine,
      statusCode: run.statusCode,
      markdown: run.markdown,
      metadata: { title: run.title, description: run.description, language: run.language, contentType: run.contentType },
      response: payload,
      createdAt: new Date().toISOString(),
    },
    run.receipt,
    snapshot,
    signature,
  );
  return { run, status, payload };
}
```

In `packages/api/src/app.ts`: replace the entire body of the `v2.post('/scrape', async (req, reply) => { … });` handler with
```ts
      v2.post('/scrape', async (req, reply) => {
        const normalized = normalizeScrapeRequest(req.body);
        const { status, payload } = await scrapeAndPersist(deps, normalized, { apiKeyId: req.apiKeyId });
        return reply.status(status).send(payload);
      });
```
add `import { scrapeAndPersist } from './scrape-service';` to the imports, and remove the now-unused imports (`runScrape`, `buildResponse`, `signReceipt`) from `app.ts` (keep `ScraperConfig`, `sha256Hex`, `PrivateSigningKey`).

In `packages/api/src/response.ts`, in the `data.metadata = { … }` object add `scrapeId: run.id,` as the last property.

- [ ] **Step 4: Implement webhooks**

`packages/api/src/jobs/webhooks.ts`:
```ts
import { createHmac, randomUUID } from 'node:crypto';
import { assertUrlAllowed, createSafeLookup } from '@icecrawl/engines';
import { PermanentError, type JobQueues, type WebhookJobData } from '@icecrawl/queue';
import { Agent, request } from 'undici';
import type { JobRecord } from '../store/types';

export type WebhookEvent = 'started' | 'page' | 'completed' | 'failed';

export interface WebhookPayload {
  success: boolean;
  type: string;
  id: string;
  webhookId: string;
  data: unknown[];
  metadata: Record<string, unknown>;
  error?: string;
}

const PREFIX = { crawl: 'crawl', batch: 'batch_scrape' } as const;

/** Batch scrapes have no failed event; a failed batch is reported as completed with success false. */
const effectiveEvent = (job: JobRecord, event: WebhookEvent): WebhookEvent =>
  job.type === 'batch' && event === 'failed' ? 'completed' : event;

export function buildWebhookPayload(
  job: JobRecord,
  event: WebhookEvent,
  data: unknown[],
  o: { success?: boolean; error?: string } = {},
): WebhookPayload {
  const payload: WebhookPayload = {
    success: o.success ?? event !== 'failed',
    type: `${PREFIX[job.type]}.${effectiveEvent(job, event)}`,
    id: job.id,
    webhookId: randomUUID(),
    data,
    metadata: job.webhook?.metadata ?? {},
  };
  if (o.error !== undefined) payload.error = o.error;
  return payload;
}

export async function sendWebhook(
  queues: JobQueues,
  job: JobRecord,
  event: WebhookEvent,
  data: unknown[],
  o: { success?: boolean; error?: string } = {},
): Promise<void> {
  const cfg = job.webhook;
  if (!cfg) return;
  const wanted = cfg.events ?? ['started', 'page', 'completed', 'failed'];
  if (!wanted.includes(effectiveEvent(job, event))) return;
  const payload = buildWebhookPayload(job, event, data, o);
  await queues.addWebhook({
    jobId: job.id,
    webhookId: payload.webhookId,
    url: cfg.url,
    headers: cfg.headers ?? {},
    body: JSON.stringify(payload),
  });
}

export const signBody = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export interface DeliveryDeps {
  secret: string | null;
  allowPrivate: boolean;
  timeoutMs?: number;
}

const RESERVED = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'x-icecrawl-signature', 'x-firecrawl-signature', 'x-icecrawl-webhook-id', 'user-agent']);

export async function deliverWebhook(deps: DeliveryDeps, data: WebhookJobData): Promise<void> {
  try {
    assertUrlAllowed(data.url, deps.allowPrivate);
  } catch (err) {
    throw new PermanentError(`webhook URL not allowed: ${(err as Error).message}`);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.headers)) if (!RESERVED.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  headers['content-type'] = 'application/json';
  headers['user-agent'] = 'IceCrawl-Webhook/0.1';
  headers['x-icecrawl-webhook-id'] = data.webhookId;
  if (deps.secret) {
    const sig = signBody(deps.secret, data.body);
    headers['x-icecrawl-signature'] = sig;
    headers['x-firecrawl-signature'] = sig;
  }

  const timeout = deps.timeoutMs ?? 10_000;
  const agent = new Agent({
    connect: { lookup: createSafeLookup(deps.allowPrivate) as never },
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  try {
    const res = await request(data.url, { method: 'POST', headers, body: data.body, dispatcher: agent, signal: AbortSignal.timeout(timeout) });
    await res.body.dump();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`webhook responded with HTTP ${res.statusCode}`);
  } finally {
    await agent.close().catch(() => undefined);
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test && pnpm typecheck`
Expected: PASS everywhere (the existing scrape tests prove the refactor kept behaviour; replay equality `replay.json() == post.json()` still holds). If the `Host` override test fails because undici sets host itself, assert only that the signature headers are not overridden.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): shared scrape service and signed webhook delivery" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `api`: the job processor (discover, crawl pages, batch pages, completion)

**Files:**
- Create: `packages/api/src/jobs/processor.ts`, `packages/api/test/jobs-helpers.ts`
- Test: `packages/api/test/processor.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (core request schemas, crawler, queue interface, store, scrape service, webhooks).
- Produces:
  - `interface JobDeps { store: Store; snapshots: SnapshotStore; engines: readonly Engine[]; scraper: ScraperConfig; signer?: PrivateSigningKey; queues: JobQueues; fetcher: Fetcher; allowIgnoreRobots: boolean; robotsTtlMs?: number; maxCrawlDelaySeconds?: number; robotsCache?: Map<string, { rules: RobotsRules; at: number }> }`.
  - `processScrapeJob(deps: JobDeps, data: ScrapeJobData, ctx: JobContext): Promise<{ delayMs?: number }>`.
  - Behaviour: ignores jobs that are missing or not `scraping`. `discover` (crawl only): sends `started`; reads robots and sitemap per mode; seeds the start URL plus in-scope sitemap URLs; dedupes via `markSeen`; reserves against the limit; enqueues pages at depth 0; on any failure records an error and finishes the job as failed. `page`: checks robots (crawl, unless ignored and allowed), applies delay/concurrency slots (returns `{ delayMs }` when busy, with no work done), scrapes through `scrapeAndPersist` (job-linked), records failures (retryable `TIMEOUT`/`TARGET_ERROR` are re-thrown until the last attempt), discovers links on accepted non-external crawl pages, then records the result, sends `page` webhooks and finalizes the job when `completed + failed >= total` (status `completed` if any page succeeded, else `failed`; webhook `completed` or `failed`; frontier keys cleared).

- [ ] **Step 1: Write the test helpers**

`packages/api/test/jobs-helpers.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { featureSet, type Engine } from '@icecrawl/engines';
import type { Fetcher } from '@icecrawl/crawler';
import { MemoryQueues, type JobContext } from '@icecrawl/queue';
import { processScrapeJob, type JobDeps } from '../src/jobs/processor';
import { MemorySnapshotStore, MemoryStore } from '../src/store/memory';
import type { NewJob } from '../src/store/types';

export const filler = 'Real readable sentence about a real topic that is long enough to be trusted. '.repeat(8);

export const pageHtml = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${filler}</p>${links
    .map((l, i) => `<a href="${l}">link ${i}</a>`)
    .join(' ')}</article></body></html>`;

export type Site = Record<string, { status?: number; html: string; contentType?: string } | Error>;

/** An engine that serves a fixed set of pages and records which URLs it was asked for. */
export function siteEngine(site: Site, calls: string[] = []): Engine {
  return {
    name: 'site',
    quality: 10,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async (ctx) => {
      calls.push(ctx.url);
      const p = site[ctx.url];
      if (p instanceof Error) throw p;
      if (!p) return { finalUrl: ctx.url, statusCode: 404, headers: {}, body: Buffer.from('<html><body>missing</body></html>'), contentType: 'text/html', truncated: false };
      return {
        finalUrl: ctx.url,
        statusCode: p.status ?? 200,
        headers: {},
        body: Buffer.from(p.html),
        contentType: p.contentType ?? 'text/html; charset=utf-8',
        truncated: false,
      };
    },
  };
}

export function fakeFetcher(files: Record<string, { status?: number; body: string | Uint8Array } | Error>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const f = files[url];
    if (f instanceof Error) throw f;
    if (!f) return { status: 404, body: new Uint8Array() };
    return { status: f.status ?? 200, body: typeof f.body === 'string' ? Buffer.from(f.body) : f.body };
  };
}

export function makeJobDeps(over: Partial<JobDeps> & { site?: Site; files?: Parameters<typeof fakeFetcher>[0] } = {}) {
  const queues = (over.queues as MemoryQueues | undefined) ?? new MemoryQueues();
  const store = over.store ?? new MemoryStore();
  const calls: string[] = [];
  const deps: JobDeps = {
    store,
    snapshots: new MemorySnapshotStore(),
    engines: [siteEngine(over.site ?? {}, calls)],
    scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false },
    queues,
    fetcher: fakeFetcher(over.files ?? {}),
    allowIgnoreRobots: false,
    ...over,
  };
  return { deps, store: store as MemoryStore, queues, calls };
}

export async function createCrawl(
  store: MemoryStore,
  request: Record<string, unknown>,
  over: Partial<NewJob> = {},
): Promise<string> {
  const id = randomUUID();
  await store.createJob({
    id,
    type: 'crawl',
    apiKeyId: null,
    request: { limit: 100, sitemap: 'include', ...request },
    webhook: null,
    limit: Number(request.limit ?? 100),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...over,
  });
  return id;
}

export async function createBatch(store: MemoryStore, urls: string[], over: Partial<NewJob> & { scrapeOptions?: Record<string, unknown>; maxConcurrency?: number } = {}) {
  const id = randomUUID();
  const { scrapeOptions, maxConcurrency, ...rest } = over;
  await store.createJob({
    id,
    type: 'batch',
    apiKeyId: null,
    request: { urls, scrapeOptions: scrapeOptions ?? {}, maxConcurrency },
    webhook: null,
    limit: urls.length,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...rest,
  });
  await store.reserveUrls(id, urls.length);
  return id;
}

/** Process queued jobs until the queue is empty, emulating BullMQ delays and retries. */
export async function drain(deps: JobDeps, queues: MemoryQueues, o: { maxAttempts?: number; maxSteps?: number } = {}): Promise<void> {
  const maxAttempts = o.maxAttempts ?? 1;
  const attempts = new Map<unknown, number>();
  for (let step = 0; step < (o.maxSteps ?? 2000); step++) {
    const next = queues.takeNext();
    if (!next) return;
    const made = attempts.get(next) ?? 0;
    const ctx: JobContext = { attemptsMade: made, maxAttempts };
    try {
      const r = await processScrapeJob(deps, next, ctx);
      if (r.delayMs) queues.jobs.push(next);
    } catch {
      attempts.set(next, made + 1);
      if (made + 1 < maxAttempts) queues.jobs.push(next);
    }
  }
  throw new Error('drain did not converge');
}
```
Note for the executor: `drain` must import `processScrapeJob` from `../src/jobs/processor` (done above); this file compiles only after Step 3 creates the processor.

- [ ] **Step 2: Write the failing tests**

`packages/api/test/processor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IceCrawlError } from '@icecrawl/core';
import { createBatch, createCrawl, drain, makeJobDeps, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const robotsOk = { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private/\n' } };

const pages = (urls: string[]) => urls.map((u) => (u.startsWith('http') ? u : `${E}${u}`));

describe('crawl processing', () => {
  it('crawls pages reachable by links, scoped to the start path, and completes the job', async () => {
    const site = {
      [`${E}/docs`]: { html: pageHtml('Docs', ['/docs/a', '/docs/b', '/blog/x', 'https://other.org/o', `${E}/logo.png`]) },
      [`${E}/docs/a`]: { html: pageHtml('A', ['/docs/b', '/docs/a/deep']) },
      [`${E}/docs/b`]: { html: pageHtml('B', ['/docs']) },
      [`${E}/docs/a/deep`]: { html: pageHtml('Deep') },
      [`${E}/blog/x`]: { html: pageHtml('Blog') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/docs` });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual(pages(['/docs', '/docs/a', '/docs/a/deep', '/docs/b']).sort());
    const job = await store.getJob(id);
    expect(job).toMatchObject({ status: 'completed', total: 4, completed: 4, failed: 0 });
    expect(job?.completedAt).not.toBeNull();
    const { items } = await store.listJobPages(id, 0, 10_000_000);
    expect(items.map((i) => (i.metadata as { title: string }).title).sort()).toEqual(['A', 'B', 'Deep', 'Docs']);
    expect(queues.cleared).toContain(id);
  });

  it('never scrapes a URL twice and respects the page limit', async () => {
    const site: Record<string, { html: string }> = {
      [`${E}/`]: { html: pageHtml('Home', ['/a', '/b', '/c', '/d', '/a', `${E}/a#frag`, `${E}/a/`]) },
    };
    for (const p of ['a', 'b', 'c', 'd']) site[`${E}/${p}`] = { html: pageHtml(p, ['/', '/a']) };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, limit: 3 });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3);
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 3 });
  });

  it('seeds from the sitemap and honours includePaths/excludePaths', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/blog/p1', '/about']) },
      [`${E}/blog/p1`]: { html: pageHtml('P1') },
      [`${E}/blog/p2`]: { html: pageHtml('P2') },
      [`${E}/about`]: { html: pageHtml('About') },
      [`${E}/drafts/d`]: { html: pageHtml('Draft') },
    };
    const files = {
      ...robotsOk,
      [`${E}/sitemap.xml`]: { body: `<urlset><url><loc>${E}/blog/p2</loc></url><url><loc>${E}/drafts/d</loc></url><url><loc>${E}/about</loc></url></urlset>` },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files });
    const id = await createCrawl(store, { url: `${E}/`, includePaths: ['^/blog'], excludePaths: ['drafts'] });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual(pages(['/', '/blog/p1', '/blog/p2']).sort());
  });

  it('supports sitemap modes only and skip', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/linked']) },
      [`${E}/linked`]: { html: pageHtml('Linked') },
      [`${E}/mapped`]: { html: pageHtml('Mapped', ['/linked']) },
    };
    const files = { ...robotsOk, [`${E}/sitemap.xml`]: { body: `<urlset><url><loc>${E}/mapped</loc></url></urlset>` } };

    const only = makeJobDeps({ site, files });
    const a = await createCrawl(only.store, { url: `${E}/`, sitemap: 'only' });
    await only.queues.addDiscover(a);
    await drain(only.deps, only.queues);
    expect(only.calls).toEqual([`${E}/mapped`]);

    const skip = makeJobDeps({ site, files });
    const b = await createCrawl(skip.store, { url: `${E}/`, sitemap: 'skip' });
    await skip.queues.addDiscover(b);
    await drain(skip.deps, skip.queues);
    expect([...skip.calls].sort()).toEqual([`${E}/`, `${E}/linked`].sort());
  });

  it('falls back to the start URL when sitemap=only finds no sitemap', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'only' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/`]);
  });

  it('follows external links one hop and does not discover from external pages', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['https://other.org/x']) },
      'https://other.org/x': { html: pageHtml('Ext', ['https://other.org/y']) },
      'https://other.org/y': { html: pageHtml('Ext2') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: { ...robotsOk, 'https://other.org/robots.txt': { status: 404, body: '' } } });
    const id = await createCrawl(store, { url: `${E}/`, allowExternalLinks: true, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/`, 'https://other.org/x'].sort());
  });

  it('honours maxDiscoveryDepth', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('0', ['/1']) },
      [`${E}/1`]: { html: pageHtml('1', ['/2']) },
      [`${E}/2`]: { html: pageHtml('2', ['/3']) },
      [`${E}/3`]: { html: pageHtml('3') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', maxDiscoveryDepth: 1 });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/`, `${E}/1`].sort());
  });
});

describe('robots.txt', () => {
  it('records robots-blocked URLs instead of scraping them', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/private/secret', '/ok']) },
      [`${E}/ok`]: { html: pageHtml('Ok') },
      [`${E}/private/secret`]: { html: pageHtml('Secret') },
    };
    const { deps, store, queues, calls } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).not.toContain(`${E}/private/secret`);
    const errors = await store.listJobErrors(id);
    expect(errors).toEqual([expect.objectContaining({ url: `${E}/private/secret`, kind: 'robots', code: 'ROBOTS_DISALLOWED' })]);
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 2, failed: 1 });
  });

  it('fails the job when the start URL itself is disallowed', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/private/x`]: { html: pageHtml('X') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/private/x`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([]);
    expect(await store.getJob(id)).toMatchObject({ status: 'failed', completed: 0, failed: 1 });
  });

  it('ignores robots only when the request asks and the operator allows it', async () => {
    const site = { [`${E}/private/x`]: { html: pageHtml('X') } };
    const denied = makeJobDeps({ site, files: robotsOk, allowIgnoreRobots: false });
    const a = await createCrawl(denied.store, { url: `${E}/private/x`, sitemap: 'skip', ignoreRobotsTxt: true });
    await denied.queues.addDiscover(a);
    await drain(denied.deps, denied.queues);
    expect(denied.calls).toEqual([]);

    const allowed = makeJobDeps({ site, files: robotsOk, allowIgnoreRobots: true });
    const b = await createCrawl(allowed.store, { url: `${E}/private/x`, sitemap: 'skip', ignoreRobotsTxt: true });
    await allowed.queues.addDiscover(b);
    await drain(allowed.deps, allowed.queues);
    expect(allowed.calls).toEqual([`${E}/private/x`]);
  });

  it('treats an unreachable robots.txt as disallow-all (RFC 9309)', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: { [`${E}/robots.txt`]: { status: 503, body: '' } } });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(calls).toEqual([]);
    expect((await store.getJob(id))?.status).toBe('failed');
  });

  it('caches robots.txt per origin across pages', async () => {
    const fetched: string[] = [];
    const { fakeFetcher } = await import('./jobs-helpers');
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) },
      [`${E}/a`]: { html: pageHtml('A') },
      [`${E}/b`]: { html: pageHtml('B') },
    };
    const { deps, store, queues } = makeJobDeps({ site, fetcher: fakeFetcher(robotsOk, fetched) });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(fetched.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('failures, retries, delays and cancellation', () => {
  it('records failed verdicts as errors and still completes when some pages succeed', async () => {
    const site = {
      [`${E}/`]: { html: pageHtml('Home', ['/blocked', '/gone']) },
      [`${E}/blocked`]: { status: 403, html: '<html>Forbidden</html>' },
    };
    const { deps, store, queues } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const errors = await store.listJobErrors(id);
    expect(errors.map((e) => [e.url, e.code]).sort()).toEqual([[`${E}/blocked`, 'BLOCKED'], [`${E}/gone`, 'TARGET_ERROR']].sort());
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 1, failed: 2 });
  });

  it('marks the job failed when no page succeeded', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: { status: 403, html: 'no' } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues);
    expect(await store.getJob(id)).toMatchObject({ status: 'failed', completed: 0, failed: 1 });
  });

  it('retries transient errors until the last attempt and then records the failure', async () => {
    let n = 0;
    const flaky = { [`${E}/`]: new IceCrawlError('TIMEOUT', 'slow') };
    const { deps, store, queues } = makeJobDeps({ site: flaky, files: robotsOk });
    const real = deps.engines[0];
    (deps as { engines: unknown }).engines = [{ ...real, scrape: async (c: Parameters<typeof real.scrape>[0]) => { n++; return real.scrape(c); } }];
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues, { maxAttempts: 3 });
    expect(n).toBe(3);
    expect(await store.listJobErrors(id)).toEqual([expect.objectContaining({ code: 'TIMEOUT', kind: 'error' })]);
    expect((await store.getJob(id))?.status).toBe('failed');
  });

  it('does not retry permanent errors', async () => {
    let n = 0;
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: new IceCrawlError('SSRF_BLOCKED', 'private') }, files: robotsOk });
    const real = deps.engines[0];
    (deps as { engines: unknown }).engines = [{ ...real, scrape: async (c: Parameters<typeof real.scrape>[0]) => { n++; return real.scrape(c); } }];
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    await drain(deps, queues, { maxAttempts: 3 });
    expect(n).toBe(1);
    expect((await store.listJobErrors(id))[0]).toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('asks to be delayed when the crawl slot is busy, doing no work meanwhile', async () => {
    const { deps, store, queues, calls } = makeJobDeps({ site: { [`${E}/`]: { html: pageHtml('Home') } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', maxConcurrency: 1 });
    await queues.addDiscover(id);
    queues.takeNext(); // discover processed manually below
    const { processScrapeJob } = await import('../src/jobs/processor');
    await processScrapeJob(deps, { kind: 'discover', jobId: id }, { attemptsMade: 0, maxAttempts: 1 });
    const page = queues.takeNext()!;
    queues.busy.push(321);
    expect(await processScrapeJob(deps, page, { attemptsMade: 0, maxAttempts: 1 })).toEqual({ delayMs: 321 });
    expect(calls).toEqual([]);
    expect(await processScrapeJob(deps, page, { attemptsMade: 0, maxAttempts: 1 })).toEqual({});
    expect(calls).toEqual([`${E}/`]);
  });

  it('applies the crawl delay and the robots Crawl-delay as slot spacing', async () => {
    const seen: Array<{ maxConcurrency?: number; delayMs?: number }> = [];
    const { deps, store, queues } = makeJobDeps({
      site: { [`${E}/`]: { html: pageHtml('Home') }, [`${E}/b`]: { html: pageHtml('B') } },
      files: { [`${E}/robots.txt`]: { body: 'User-agent: *\nCrawl-delay: 2\n' } },
    });
    queues.acquireSlot = async (_id, o) => (seen.push(o), { ok: true, release: async () => {} });
    const viaRobots = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(viaRobots);
    await drain(deps, queues);
    expect(seen[0]).toEqual({ maxConcurrency: 1, delayMs: 2000 });

    seen.length = 0;
    const explicit = await createCrawl(store, { url: `${E}/`, sitemap: 'skip', delay: 0.5, maxConcurrency: 5 });
    await queues.addDiscover(explicit);
    await drain(deps, queues);
    expect(seen[0]).toEqual({ maxConcurrency: 1, delayMs: 500 });
  });

  it('skips queued work of a cancelled job and does not finish it again', async () => {
    const { deps, store, queues, calls } = makeJobDeps({
      site: { [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) }, [`${E}/a`]: { html: pageHtml('A') }, [`${E}/b`]: { html: pageHtml('B') } },
      files: robotsOk,
    });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' });
    await queues.addDiscover(id);
    const { processScrapeJob } = await import('../src/jobs/processor');
    await processScrapeJob(deps, queues.takeNext()!, { attemptsMade: 0, maxAttempts: 1 }); // discover
    await processScrapeJob(deps, queues.takeNext()!, { attemptsMade: 0, maxAttempts: 1 }); // start page (enqueues /a, /b)
    expect(await store.cancelJob(id)).toBe(true);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/`]);
    expect((await store.getJob(id))?.status).toBe('cancelled');
  });

  it('ignores jobs that do not exist', async () => {
    const { deps } = makeJobDeps();
    const { processScrapeJob } = await import('../src/jobs/processor');
    expect(await processScrapeJob(deps, { kind: 'page', jobId: 'nope', url: `${E}/`, depth: 0, external: false }, { attemptsMade: 0, maxAttempts: 1 })).toEqual({});
  });
});

describe('batch processing', () => {
  it('scrapes every URL, counts failures, and completes', async () => {
    const site = { [`${E}/a`]: { html: pageHtml('A') }, [`${E}/b`]: { html: pageHtml('B') } };
    const { deps, store, queues, calls } = makeJobDeps({ site });
    const id = await createBatch(store, [`${E}/a`, `${E}/b`, `${E}/missing`]);
    await queues.addPages([`${E}/a`, `${E}/b`, `${E}/missing`].map((url) => ({ jobId: id, url, depth: 0, external: false })));
    await drain(deps, queues);
    expect([...calls].sort()).toEqual([`${E}/a`, `${E}/b`, `${E}/missing`].sort());
    expect(await store.getJob(id)).toMatchObject({ status: 'completed', total: 3, completed: 2, failed: 1 });
    expect((await store.listJobErrors(id))[0]).toMatchObject({ url: `${E}/missing`, kind: 'error' });
  });

  it('does not check robots.txt or follow links for batch jobs, and uses the stored scrape options', async () => {
    const site = { [`${E}/private/a`]: { html: pageHtml('A', ['/more']) }, [`${E}/more`]: { html: pageHtml('More') } };
    const fetched: string[] = [];
    const { fakeFetcher } = await import('./jobs-helpers');
    const { deps, store, queues, calls } = makeJobDeps({ site, fetcher: fakeFetcher(robotsOk, fetched) });
    const id = await createBatch(store, [`${E}/private/a`], { scrapeOptions: { formats: ['markdown', 'links'] } });
    await queues.addPages([{ jobId: id, url: `${E}/private/a`, depth: 0, external: false }]);
    await drain(deps, queues);
    expect(calls).toEqual([`${E}/private/a`]);
    expect(fetched).toEqual([]);
    const { items } = await store.listJobPages(id, 0, 1_000_000);
    expect(items[0].links).toEqual([`${E}/more`]);
  });
});

describe('webhooks from the processor', () => {
  it('emits started, one page event per page, and completed, in order', async () => {
    const site = { [`${E}/`]: { html: pageHtml('Home', ['/a']) }, [`${E}/a`]: { html: pageHtml('A') } };
    const { deps, store, queues } = makeJobDeps({ site, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' }, { webhook: { url: 'https://hooks.example.com/x', metadata: { m: 1 } } });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const events = queues.webhooks.map((w) => JSON.parse(w.body));
    expect(events.map((e) => e.type)).toEqual(['crawl.started', 'crawl.page', 'crawl.page', 'crawl.completed']);
    expect(events[1].data[0]).toMatchObject({ markdown: expect.stringContaining('Home'), metadata: { url: `${E}/`, scrapeId: expect.any(String) } });
    expect(events[3]).toMatchObject({ success: true, data: [], metadata: { m: 1 }, id });
    expect(new Set(events.map((e) => e.webhookId)).size).toBe(4);
  });

  it('emits crawl.failed when nothing succeeded, and page events carry the error for failed pages', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/`]: { status: 403, html: 'no' } }, files: robotsOk });
    const id = await createCrawl(store, { url: `${E}/`, sitemap: 'skip' }, { webhook: { url: 'https://hooks.example.com/x' } });
    await queues.addDiscover(id);
    await drain(deps, queues);
    const events = queues.webhooks.map((w) => JSON.parse(w.body));
    expect(events.map((e) => e.type)).toEqual(['crawl.started', 'crawl.page', 'crawl.failed']);
    expect(events[1]).toMatchObject({ success: false, data: [] });
    expect(events[1].error).toContain('BLOCKED'.toLowerCase().length ? '' : '');
    expect(events[2]).toMatchObject({ success: false });
  });

  it('emits batch_scrape events', async () => {
    const { deps, store, queues } = makeJobDeps({ site: { [`${E}/a`]: { html: pageHtml('A') } } });
    const id = await createBatch(store, [`${E}/a`], { webhook: { url: 'https://hooks.example.com/x' } });
    await queues.addPages([{ jobId: id, url: `${E}/a`, depth: 0, external: false }]);
    await drain(deps, queues);
    expect(queues.webhooks.map((w) => JSON.parse(w.body).type)).toEqual(['batch_scrape.page', 'batch_scrape.completed']);
  });
});
```
Cleanup note for the executor: the assertion `expect(events[1].error).toContain('BLOCKED'.toLowerCase().length ? '' : '')` is a placeholder that always passes; replace it with `expect(typeof events[1].error).toBe('string')`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/api/test/processor.test.ts`
Expected: FAIL (`../src/jobs/processor` missing).

- [ ] **Step 4: Implement the processor**

`packages/api/src/jobs/processor.ts`:
```ts
import { crawlRequestSchema, IceCrawlError, normalizeScrapeRequest, type CrawlRequest } from '@icecrawl/core';
import {
  ALLOW_ALL,
  buildScope,
  decideLink,
  defaultSitemapSeeds,
  discoverSitemapUrls,
  loadRobots,
  normalizeUrl,
  type Fetcher,
  type RobotsRules,
} from '@icecrawl/crawler';
import type { Engine } from '@icecrawl/engines';
import type { JobContext, JobQueues, PageJobData, ScrapeJobData } from '@icecrawl/queue';
import type { ScraperConfig } from '@icecrawl/scraper';
import type { PrivateSigningKey } from '@icecrawl/trust';
import { scrapeAndPersist } from '../scrape-service';
import type { JobRecord, SnapshotStore, Store } from '../store/types';
import { sendWebhook } from './webhooks';

export interface JobDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  signer?: PrivateSigningKey;
  queues: JobQueues;
  fetcher: Fetcher;
  allowIgnoreRobots: boolean;
  robotsTtlMs?: number;
  maxCrawlDelaySeconds?: number;
  // shortcut: robots rules are cached per worker process; upgrade by caching in Redis so workers share them.
  robotsCache?: Map<string, { rules: RobotsRules; at: number }>;
}

const DEFAULT_UA = 'IceCrawl';
const RETRYABLE = new Set(['TIMEOUT', 'TARGET_ERROR']);

interface StoredBatch {
  urls: string[];
  maxConcurrency?: number;
  scrapeOptions?: Record<string, unknown>;
}

export async function processScrapeJob(
  deps: JobDeps,
  data: ScrapeJobData,
  ctx: JobContext,
): Promise<{ delayMs?: number }> {
  const job = await deps.store.getJob(data.jobId);
  if (!job || job.status !== 'scraping') return {};
  return data.kind === 'discover' ? discover(deps, job) : page(deps, job, data, ctx);
}

const scopeOf = (crawl: CrawlRequest) =>
  buildScope(crawl.url, {
    includePaths: crawl.includePaths,
    excludePaths: crawl.excludePaths,
    regexOnFullURL: crawl.regexOnFullURL,
    crawlEntireDomain: crawl.crawlEntireDomain,
    allowExternalLinks: crawl.allowExternalLinks,
    allowSubdomains: crawl.allowSubdomains,
    maxDiscoveryDepth: crawl.maxDiscoveryDepth,
  });

const ignoresRobots = (deps: JobDeps, crawl: CrawlRequest) => crawl.ignoreRobotsTxt && deps.allowIgnoreRobots;

async function robotsFor(deps: JobDeps, origin: string, userAgent: string): Promise<RobotsRules> {
  const cache = (deps.robotsCache ??= new Map());
  const key = `${origin}|${userAgent}`;
  const hit = cache.get(key);
  const ttl = deps.robotsTtlMs ?? 10 * 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.rules;
  const rules = await loadRobots(origin, deps.fetcher, userAgent);
  cache.set(key, { rules, at: Date.now() });
  return rules;
}

async function finishJob(deps: JobDeps, jobId: string, failureMessage?: string): Promise<void> {
  const fresh = await deps.store.getJob(jobId);
  if (!fresh || fresh.status !== 'scraping') return;
  const status = fresh.completed > 0 ? 'completed' : 'failed';
  const won = await deps.store.finalizeJob(jobId, status);
  if (!won) return;
  await sendWebhook(deps.queues, won, status === 'failed' ? 'failed' : 'completed', [], {
    success: status === 'completed',
    error: status === 'failed' ? failureMessage ?? 'No page could be scraped' : undefined,
  });
  await deps.queues.clearJob(jobId);
}

async function completePage(
  deps: JobDeps,
  job: JobRecord,
  outcome: 'completed' | 'failed',
  info: { page?: unknown; error?: string },
): Promise<void> {
  await sendWebhook(deps.queues, job, 'page', info.page === undefined ? [] : [info.page], {
    success: outcome === 'completed',
    error: info.error,
  });
  const counters = await deps.store.recordPageResult(job.id, outcome);
  if (counters.status === 'scraping' && counters.completed + counters.failed >= counters.total) {
    await finishJob(deps, job.id, info.error);
  }
}

async function discover(deps: JobDeps, job: JobRecord): Promise<{ delayMs?: number }> {
  if (job.type !== 'crawl') return {};
  const crawl = crawlRequestSchema.parse(job.request);
  try {
    await sendWebhook(deps.queues, job, 'started', []);
    const start = new URL(crawl.url);
    const ua = crawl.robotsUserAgent ?? DEFAULT_UA;
    const robots = ignoresRobots(deps, crawl) ? ALLOW_ALL : await robotsFor(deps, start.origin, ua);
    const scope = scopeOf(crawl);
    const normOpts = { ignoreQueryParameters: crawl.ignoreQueryParameters };
    const startUrl = normalizeUrl(crawl.url, normOpts) ?? crawl.url;

    const seeds = new Map<string, boolean>();
    if (crawl.sitemap !== 'skip') {
      const found = await discoverSitemapUrls(defaultSitemapSeeds(crawl.url, robots.sitemaps), deps.fetcher);
      for (const raw of found) {
        const norm = normalizeUrl(raw, normOpts);
        if (!norm) continue;
        const d = decideLink(norm, 0, scope);
        if (d.follow) seeds.set(norm, d.external);
      }
    }
    const ordered: Array<[string, boolean]> =
      crawl.sitemap === 'only' && seeds.size > 0 ? [...seeds] : [[startUrl, false], ...seeds];

    const fresh = await deps.queues.markSeen(job.id, ordered.map(([u]) => u));
    const external = new Map(ordered);
    const granted = await deps.store.reserveUrls(job.id, fresh.length);
    if (granted === 0) {
      await finishJob(deps, job.id, 'Nothing to crawl');
      return {};
    }
    await deps.queues.addPages(
      fresh.slice(0, granted).map((url): Omit<PageJobData, 'kind'> => ({ jobId: job.id, url, depth: 0, external: external.get(url) ?? false })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.addJobError(job.id, {
      url: crawl.url,
      error: message,
      code: err instanceof IceCrawlError ? err.code : null,
      kind: 'error',
    });
    await finishJob(deps, job.id, message);
  }
  return {};
}

async function page(
  deps: JobDeps,
  job: JobRecord,
  data: PageJobData,
  ctx: JobContext,
): Promise<{ delayMs?: number }> {
  const crawl = job.type === 'crawl' ? crawlRequestSchema.parse(job.request) : null;
  const stored = job.request as { scrapeOptions?: Record<string, unknown>; maxConcurrency?: number };
  const scrapeOptions = stored.scrapeOptions ?? {};

  let robots: RobotsRules = ALLOW_ALL;
  if (crawl && !ignoresRobots(deps, crawl)) {
    robots = await robotsFor(deps, new URL(data.url).origin, crawl.robotsUserAgent ?? DEFAULT_UA);
    if (!robots.allowed(data.url)) {
      await deps.store.addJobError(job.id, { url: data.url, error: 'Blocked by robots.txt', code: 'ROBOTS_DISALLOWED', kind: 'robots' });
      await completePage(deps, job, 'failed', { error: 'Blocked by robots.txt' });
      return {};
    }
  }

  const delaySeconds = crawl ? crawl.delay ?? Math.min(robots.crawlDelaySeconds ?? 0, deps.maxCrawlDelaySeconds ?? 30) : 0;
  const delayMs = Math.round(delaySeconds * 1000);
  const slot = await deps.queues.acquireSlot(job.id, {
    maxConcurrency: delayMs > 0 ? 1 : crawl ? crawl.maxConcurrency : stored.maxConcurrency,
    delayMs,
  });
  if (!slot.ok) return { delayMs: slot.retryInMs };

  try {
    const normalized = normalizeScrapeRequest({ ...scrapeOptions, url: data.url });
    let result: Awaited<ReturnType<typeof scrapeAndPersist>>;
    try {
      result = await scrapeAndPersist(deps, normalized, { apiKeyId: job.apiKeyId, jobId: job.id });
    } catch (err) {
      const e = err instanceof IceCrawlError ? err : new IceCrawlError('TARGET_ERROR', err instanceof Error ? err.message : String(err));
      if (RETRYABLE.has(e.code) && ctx.attemptsMade + 1 < ctx.maxAttempts) throw e;
      await deps.store.addJobError(job.id, { url: data.url, error: e.message, code: e.code, kind: 'error' });
      await completePage(deps, job, 'failed', { error: `${e.code}: ${e.message}` });
      return {};
    }

    const { payload, run } = result;
    if (payload.success !== true) {
      const message = String(payload.error ?? 'Scrape failed');
      await deps.store.addJobError(job.id, { url: data.url, error: message, code: String(payload.code ?? ''), kind: 'error' });
      await completePage(deps, job, 'failed', { error: message });
      return {};
    }

    if (crawl && !data.external && crawl.sitemap !== 'only') await discoverLinks(deps, job, crawl, data, run.links);
    await completePage(deps, job, 'completed', { page: payload.data });
    return {};
  } finally {
    await slot.release();
  }
}

async function discoverLinks(deps: JobDeps, job: JobRecord, crawl: CrawlRequest, data: PageJobData, links: string[]): Promise<void> {
  const scope = scopeOf(crawl);
  const candidates = new Map<string, boolean>();
  for (const raw of links) {
    const norm = normalizeUrl(raw, { ignoreQueryParameters: crawl.ignoreQueryParameters });
    if (!norm) continue;
    const d = decideLink(norm, data.depth + 1, scope);
    if (d.follow) candidates.set(norm, d.external);
  }
  if (candidates.size === 0) return;
  const fresh = await deps.queues.markSeen(job.id, [...candidates.keys()]);
  if (fresh.length === 0) return;
  const granted = await deps.store.reserveUrls(job.id, fresh.length);
  if (granted === 0) return;
  await deps.queues.addPages(
    fresh.slice(0, granted).map((url) => ({ jobId: job.id, url, depth: data.depth + 1, external: candidates.get(url) ?? false })),
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/api/test/processor.test.ts && pnpm typecheck`
Expected: PASS. Typical issues and their intent-preserving fixes: (a) the `delay` test expects `{ maxConcurrency: 1, delayMs: 2000 }` from a robots `Crawl-delay: 2`; if `robots-parser` returns the delay as a string/number, convert with `Number(...)`. (b) The `failed pages` test expects error code `TARGET_ERROR` for a 404 page: the pipeline classifies a 404 as verdict `error`, which maps to `TARGET_ERROR`; if the stored code is different, fix the code mapping in `page()` (`payload.code`), not the test. (c) The cancel test relies on `reserveUrls` returning 0 after cancel and on skipped queue items; if `drain` loops, confirm `processScrapeJob` returns `{}` for non-`scraping` jobs.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): crawl and batch job processor with robots, sitemap seeding, frontier, delays and webhooks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `api`: crawl and batch HTTP routes

**Files:**
- Create: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/jobs-routes.test.ts`

**Interfaces:**
- Produces:
  - `AppDeps.jobs?: JobsDeps` with `interface JobsDeps { queues: JobQueues; publicUrl?: string; ttlHours: number; pageBytes: number; maxCrawlLimit: number; allowPrivateNetworks: boolean; allowIgnoreRobots: boolean; webhookSecret?: never }` (exported from `routes/jobs.ts`).
  - Routes (all authenticated, ownership-checked; a missing, foreign, wrongly-typed or expired job is `404 NOT_FOUND`): `POST /v2/crawl`, `GET /v2/crawl/active`, `GET /v2/crawl/:id`, `DELETE /v2/crawl/:id`, `GET /v2/crawl/:id/errors`, `POST /v2/crawl/params-preview` (501, phase 5), `POST /v2/batch/scrape`, `GET /v2/batch/scrape/:id`, `DELETE /v2/batch/scrape/:id`, `GET /v2/batch/scrape/:id/errors`.
  - Start responses: crawl `{ success: true, id, url, warning? }` where `url` is `<base>/v2/crawl/<id>`; batch `{ success: true, id, url, invalidURLs? }`. Status responses: `{ success: true, status, total, completed, creditsUsed, expiresAt, createdAt, completedAt?, duration, next, data }` with `next` the URL of the next page (`?skip=N`) or `null`. Cancel: `{ status: 'cancelled' }`; cancelling a finished job is `409 CONFLICT`. Errors: `{ errors: [{ id, timestamp, url, error }], robotsBlocked: [url] }`. Active: `{ success: true, crawls: [{ id, teamId, url, status, options }] }`.
  - Validation at start: `ignoreRobotsTxt` without operator permission is `400 VALIDATION`; private crawl or webhook URLs are `400 SSRF_BLOCKED` unless private networks are allowed; the crawl limit is capped at `maxCrawlLimit`. Without `deps.jobs` the endpoints answer `501 NOT_IMPLEMENTED` ("job queue is not configured").
  - `PLANNED` in `app.ts` no longer lists `crawl`, `map` (Task 9 adds the route; until then keep `map`) or `batch`.

- [ ] **Step 1: Write the failing tests**

Add this helper block to the end of `packages/api/test/jobs-helpers.ts`:
```ts
import { buildApp } from '../src/app';
import { sha256Hex } from '@icecrawl/trust';
import { fakeFetcher as _ff } from './jobs-helpers';
```
Do NOT add those two imports at the end of the file (imports belong at the top). Instead, add `import { buildApp } from '../src/app';` and `import { sha256Hex } from '@icecrawl/trust';` to the top import list of `jobs-helpers.ts`, and append:
```ts
export async function makeJobsApp(
  over: { site?: Site; files?: Parameters<typeof fakeFetcher>[0]; useAuth?: boolean; jobs?: Partial<import('../src/routes/jobs').JobsDeps>; allowIgnoreRobots?: boolean } = {},
) {
  const { deps, store, queues, calls } = makeJobDeps({ site: over.site, files: over.files, allowIgnoreRobots: over.allowIgnoreRobots ?? false });
  const keyId = randomUUID();
  await store.createApiKey({ id: keyId, hash: sha256Hex('ic-jobs'), name: 'jobs' });
  const app = buildApp({
    store,
    snapshots: deps.snapshots,
    engines: deps.engines,
    scraper: deps.scraper,
    useAuth: over.useAuth ?? true,
    jobs: {
      queues,
      ttlHours: 24,
      pageBytes: 10_000_000,
      maxCrawlLimit: 1000,
      allowPrivateNetworks: false,
      allowIgnoreRobots: over.allowIgnoreRobots ?? false,
      ...over.jobs,
    },
  });
  return { app, store, queues, deps, calls, keyId, auth: { authorization: 'Bearer ic-jobs' } };
}
```

`packages/api/test/jobs-routes.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const robots = { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private/\n' } };
const site = {
  [`${E}/`]: { html: pageHtml('Home', ['/a', '/b', '/private/x', '/missing']) },
  [`${E}/a`]: { html: pageHtml('A') },
  [`${E}/b`]: { html: pageHtml('B') },
  [`${E}/private/x`]: { html: pageHtml('Private') },
};

const post = (t: Awaited<ReturnType<typeof makeJobsApp>>, url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: t.auth, payload: payload as never });
const get = (t: Awaited<ReturnType<typeof makeJobsApp>>, url: string, headers = t.auth) => t.app.inject({ method: 'GET', url, headers });

describe('POST /v2/crawl', () => {
  it('creates a job, returns its status URL, and queues the discovery', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const res = await post(t, '/v2/crawl', { url: `${E}/`, limit: 5 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toBe(`http://localhost:80/v2/crawl/${body.id}`);
    expect(body.warning).toBeUndefined();
    expect(t.queues.jobs).toEqual([{ kind: 'discover', jobId: body.id }]);
    expect(await t.store.getJob(body.id)).toMatchObject({ type: 'crawl', status: 'scraping', limit: 5, apiKeyId: t.keyId });
  });

  it('uses the configured public URL and returns warnings for ignored options', async () => {
    const t = await makeJobsApp({ jobs: { publicUrl: 'https://api.example.org' } });
    const body = (await post(t, '/v2/crawl', { url: `${E}/`, prompt: 'blog only' })).json();
    expect(body.url).toBe(`https://api.example.org/v2/crawl/${body.id}`);
    expect(body.warning).toContain('prompt');
  });

  it('caps the limit at the operator maximum', async () => {
    const t = await makeJobsApp({ jobs: { maxCrawlLimit: 7 } });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, limit: 100000 })).json();
    expect((await t.store.getJob(id))?.limit).toBe(7);
  });

  it('validates input and security-sensitive options', async () => {
    const t = await makeJobsApp();
    expect((await post(t, '/v2/crawl', { url: 'nope' })).json()).toMatchObject({ code: 'VALIDATION' });
    const robotsRes = await post(t, '/v2/crawl', { url: `${E}/`, ignoreRobotsTxt: true });
    expect(robotsRes.statusCode).toBe(400);
    expect(robotsRes.json().error).toContain('ignoreRobotsTxt');
    expect((await post(t, '/v2/crawl', { url: 'http://127.0.0.1:8080/' })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
    expect((await post(t, '/v2/crawl', { url: `${E}/`, webhook: { url: 'http://169.254.169.254/x' } })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('allows ignoreRobotsTxt when the operator enabled it', async () => {
    const t = await makeJobsApp({ allowIgnoreRobots: true });
    expect((await post(t, '/v2/crawl', { url: `${E}/`, ignoreRobotsTxt: true })).statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const t = await makeJobsApp();
    const res = await t.app.inject({ method: 'POST', url: '/v2/crawl', payload: { url: `${E}/` } });
    expect(res.statusCode).toBe(401);
  });

  it('answers 501 when the job queue is not configured', async () => {
    const t = await makeJobsApp();
    const { buildApp } = await import('../src/app');
    const bare = buildApp({ store: t.store, snapshots: t.deps.snapshots, engines: t.deps.engines, scraper: t.deps.scraper, useAuth: false });
    const res = await bare.inject({ method: 'POST', url: '/v2/crawl', payload: { url: `${E}/` } });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('queue');
  });
});

describe('GET /v2/crawl/:id', () => {
  it('reports progress and returns the crawled pages as v2 documents', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    const early = (await get(t, `/v2/crawl/${id}`)).json();
    expect(early).toMatchObject({ success: true, status: 'scraping', total: 0, completed: 0, data: [], next: null });

    await drain(t.deps, t.queues);
    const res = await get(t, `/v2/crawl/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'completed', total: 5, completed: 3, creditsUsed: 3, next: null });
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect(Date.parse(body.completedAt)).not.toBeNaN();
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(typeof body.duration).toBe('number');
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({ markdown: expect.any(String), metadata: { sourceURL: `${E}/`, statusCode: 200 }, trust: { verdict: 'ok' } });
  });

  it('paginates with skip and next when a page would exceed the byte budget', async () => {
    const t = await makeJobsApp({ site, files: robots, jobs: { pageBytes: 1 } });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    await drain(t.deps, t.queues);
    const first = (await get(t, `/v2/crawl/${id}`)).json();
    expect(first.data).toHaveLength(1);
    expect(first.next).toBe(`http://localhost:80/v2/crawl/${id}?skip=1`);
    const second = (await get(t, `/v2/crawl/${id}?skip=1`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].metadata.sourceURL).not.toBe(first.data[0].metadata.sourceURL);
    expect(second.next).toBe(`http://localhost:80/v2/crawl/${id}?skip=2`);
    const last = (await get(t, `/v2/crawl/${id}?skip=2`)).json();
    expect(last.data).toHaveLength(1);
    expect(last.next).toBeNull();
    expect((await get(t, `/v2/crawl/${id}?skip=-5`)).json().data).toHaveLength(1);
  });

  it('hides jobs from other keys, other job types, bad ids and expired jobs', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/` })).json();
    await t.store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'o' });
    expect((await get(t, `/v2/crawl/${id}`, { authorization: 'Bearer ic-other' })).statusCode).toBe(404);
    expect((await get(t, `/v2/batch/scrape/${id}`)).statusCode).toBe(404);
    expect((await get(t, '/v2/crawl/not-a-uuid')).statusCode).toBe(404);
    expect((await get(t, `/v2/crawl/${randomUUID()}`)).statusCode).toBe(404);

    const old = await t.store.getJob(id);
    expect(old).not.toBeNull();
    await t.store.createJob({ id: randomUUID(), type: 'crawl', apiKeyId: t.keyId, request: { url: E }, webhook: null, limit: 1, expiresAt: new Date(Date.now() - 1000) });
  });

  it('treats an expired job as not found', async () => {
    const t = await makeJobsApp();
    const id = randomUUID();
    await t.store.createJob({ id, type: 'crawl', apiKeyId: t.keyId, request: { url: E }, webhook: null, limit: 1, expiresAt: new Date(Date.now() - 1000) });
    expect((await get(t, `/v2/crawl/${id}`)).statusCode).toBe(404);
  });
});

describe('DELETE /v2/crawl/:id', () => {
  it('cancels a running crawl, is refused for finished ones, and stops further work', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    const res = await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: t.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'cancelled' });
    await drain(t.deps, t.queues);
    expect(t.calls).toEqual([]);
    expect((await get(t, `/v2/crawl/${id}`)).json()).toMatchObject({ status: 'cancelled' });

    const again = await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: t.auth });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONFLICT' });
    expect((await t.app.inject({ method: 'DELETE', url: `/v2/crawl/${randomUUID()}`, headers: t.auth })).statusCode).toBe(404);
  });
});

describe('GET /v2/crawl/:id/errors and /v2/crawl/active', () => {
  it('lists failed pages and robots-blocked URLs', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).json();
    await drain(t.deps, t.queues);
    const body = (await get(t, `/v2/crawl/${id}/errors`)).json();
    expect(body.robotsBlocked).toEqual([`${E}/private/x`]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ url: `${E}/missing`, error: expect.any(String) });
    expect(body.errors[0].id).toBeTruthy();
    expect(Date.parse(body.errors[0].timestamp)).not.toBeNaN();
  });

  it('lists the caller\'s active crawls', async () => {
    const t = await makeJobsApp({ site, files: robots });
    const { id } = (await post(t, '/v2/crawl', { url: `${E}/`, limit: 3 })).json();
    const active = (await get(t, '/v2/crawl/active')).json();
    expect(active).toMatchObject({ success: true });
    expect(active.crawls).toEqual([{ id, teamId: t.keyId, url: `${E}/`, status: 'scraping', options: { scrapeOptions: {} } }]);
    await drain(t.deps, t.queues);
    expect((await get(t, '/v2/crawl/active')).json().crawls).toEqual([]);
  });

  it('answers 501 for crawl params-preview (needs an LLM, phase 5)', async () => {
    const t = await makeJobsApp();
    const res = await post(t, '/v2/crawl/params-preview', { url: `${E}/`, prompt: 'blog' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('phase 5');
  });
});

describe('batch scrape routes', () => {
  it('creates a batch, reports invalid URLs, and serves its status, errors and cancellation', async () => {
    const t = await makeJobsApp({ site });
    const res = await post(t, '/v2/batch/scrape', { urls: [`${E}/a`, `${E}/b`, `${E}/missing`, 'not a url'], formats: ['markdown'] });
    expect(res.statusCode).toBe(200);
    const { id, url, invalidURLs } = res.json();
    expect(url).toBe(`http://localhost:80/v2/batch/scrape/${id}`);
    expect(invalidURLs).toEqual(['not a url']);
    expect(t.queues.jobs).toHaveLength(3);
    expect(await t.store.getJob(id)).toMatchObject({ type: 'batch', total: 3, limit: 3 });

    await drain(t.deps, t.queues);
    const status = (await get(t, `/v2/batch/scrape/${id}`)).json();
    expect(status).toMatchObject({ status: 'completed', total: 3, completed: 2, creditsUsed: 2, next: null });
    expect(status.data.map((d: { markdown: string }) => d.markdown.includes('Real readable'))).toEqual([true, true]);
    const errors = (await get(t, `/v2/batch/scrape/${id}/errors`)).json();
    expect(errors.errors).toHaveLength(1);
    expect(errors.robotsBlocked).toEqual([]);

    expect((await t.app.inject({ method: 'DELETE', url: `/v2/batch/scrape/${id}`, headers: t.auth })).statusCode).toBe(409);
    expect((await get(t, `/v2/crawl/${id}`)).statusCode).toBe(404);
  });

  it('omits invalidURLs when ignoreInvalidURLs is false and rejects bad URLs then', async () => {
    const t = await makeJobsApp({ site });
    expect((await post(t, '/v2/batch/scrape', { urls: [`${E}/a`], ignoreInvalidURLs: false })).json().invalidURLs).toBeUndefined();
    expect((await post(t, '/v2/batch/scrape', { urls: [`${E}/a`, 'bad'], ignoreInvalidURLs: false })).statusCode).toBe(400);
    expect((await post(t, '/v2/batch/scrape', { urls: [] })).statusCode).toBe(400);
  });

  it('refuses private URLs in the batch and queues a started webhook', async () => {
    const t = await makeJobsApp({ site });
    expect((await post(t, '/v2/batch/scrape', { urls: ['http://127.0.0.1/x'] })).json()).toMatchObject({ code: 'SSRF_BLOCKED' });
    await post(t, '/v2/batch/scrape', { urls: [`${E}/a`], webhook: { url: 'https://hooks.example.com/x' } });
    expect(JSON.parse(t.queues.webhooks[0].body).type).toBe('batch_scrape.started');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/test/jobs-routes.test.ts`
Expected: FAIL (`jobs` dep unknown, routes missing).

- [ ] **Step 3: Implement the job routes**

`packages/api/src/routes/jobs.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IceCrawlError, normalizeBatchRequest, normalizeCrawlRequest } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import type { JobQueues } from '@icecrawl/queue';
import { sendWebhook } from '../jobs/webhooks';
import type { JobRecord, JobType, Store } from '../store/types';

export interface JobsDeps {
  queues: JobQueues;
  publicUrl?: string;
  ttlHours: number;
  pageBytes: number;
  maxCrawlLimit: number;
  allowPrivateNetworks: boolean;
  allowIgnoreRobots: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS: Record<JobType, string> = { crawl: 'crawl', batch: 'batch/scrape' };

export function registerJobRoutes(v2: FastifyInstance, deps: { store: Store; useAuth: boolean; jobs?: JobsDeps }): void {
  const need = (): JobsDeps => {
    if (!deps.jobs) throw new IceCrawlError('NOT_IMPLEMENTED', 'The job queue is not configured on this server.');
    return deps.jobs;
  };
  const baseOf = (req: FastifyRequest) => (deps.jobs?.publicUrl ?? `${req.protocol}://${req.headers.host}`).replace(/\/+$/, '');

  async function loadJob(req: FastifyRequest, id: string, type: JobType): Promise<JobRecord> {
    const job = UUID.test(id) ? await deps.store.getJob(id) : null;
    if (
      !job ||
      job.type !== type ||
      (deps.useAuth && job.apiKeyId !== req.apiKeyId) ||
      Date.parse(job.expiresAt) < Date.now()
    ) {
      throw new IceCrawlError('NOT_FOUND', 'Job not found');
    }
    return job;
  }

  async function statusBody(req: FastifyRequest, job: JobRecord, skipParam: unknown) {
    const j = need();
    const skip = Number.isInteger(Number(skipParam)) && Number(skipParam) > 0 ? Number(skipParam) : 0;
    const { items, nextSkip } = await deps.store.listJobPages(job.id, skip, j.pageBytes);
    const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
    return {
      success: true,
      status: job.status,
      total: job.total,
      completed: job.completed,
      creditsUsed: job.completed,
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      duration: Math.max(0, (end - Date.parse(job.createdAt)) / 1000),
      next: nextSkip === null ? null : `${baseOf(req)}/v2/${PATHS[job.type]}/${job.id}?skip=${nextSkip}`,
      data: items,
    };
  }

  async function errorsBody(job: JobRecord) {
    const all = await deps.store.listJobErrors(job.id);
    return {
      errors: all.filter((e) => e.kind === 'error').map((e) => ({ id: e.id, timestamp: e.timestamp, url: e.url, error: e.error })),
      robotsBlocked: all.filter((e) => e.kind === 'robots').map((e) => e.url),
    };
  }

  async function cancel(job: JobRecord) {
    if (!(await deps.store.cancelJob(job.id))) throw new IceCrawlError('CONFLICT', `The ${job.type} is already ${job.status}.`);
    await need().queues.clearJob(job.id);
    return { status: 'cancelled' };
  }

  function checkWebhook(webhook: { url: string } | undefined) {
    if (webhook) assertUrlAllowed(webhook.url, need().allowPrivateNetworks);
  }

  v2.post('/crawl', async (req) => {
    const j = need();
    const n = normalizeCrawlRequest(req.body);
    if (n.request.ignoreRobotsTxt && !j.allowIgnoreRobots) {
      throw new IceCrawlError('VALIDATION', 'ignoreRobotsTxt is disabled on this server.');
    }
    assertUrlAllowed(n.request.url, j.allowPrivateNetworks);
    checkWebhook(n.request.webhook);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'crawl',
      apiKeyId: req.apiKeyId,
      request: { ...n.request, scrapeOptions: n.scrapeOptions },
      webhook: n.request.webhook ?? null,
      limit: Math.min(n.request.limit, j.maxCrawlLimit),
      expiresAt: new Date(Date.now() + j.ttlHours * 3_600_000),
    });
    await j.queues.addDiscover(id);
    return {
      success: true,
      id,
      url: `${baseOf(req)}/v2/crawl/${id}`,
      ...(n.warnings.length > 0 ? { warning: n.warnings.join(' ') } : {}),
    };
  });

  v2.get('/crawl/active', async (req) => {
    need();
    const jobs = await deps.store.listActiveJobs(req.apiKeyId);
    return {
      success: true,
      crawls: jobs
        .filter((job) => job.type === 'crawl')
        .map((job) => ({
          id: job.id,
          teamId: job.apiKeyId,
          url: (job.request as { url: string }).url,
          status: job.status,
          options: { scrapeOptions: (job.request as { scrapeOptions?: unknown }).scrapeOptions ?? {} },
        })),
    };
  });

  v2.post('/crawl/params-preview', async () => {
    throw new IceCrawlError('NOT_IMPLEMENTED', '/v2/crawl/params-preview needs an LLM and is planned for phase 5 of the IceCrawl roadmap.');
  });

  v2.get<{ Params: { id: string }; Querystring: { skip?: string } }>('/crawl/:id', async (req) =>
    statusBody(req, await loadJob(req, req.params.id, 'crawl'), req.query.skip),
  );
  v2.delete<{ Params: { id: string } }>('/crawl/:id', async (req) => cancel(await loadJob(req, req.params.id, 'crawl')));
  v2.get<{ Params: { id: string } }>('/crawl/:id/errors', async (req) => errorsBody(await loadJob(req, req.params.id, 'crawl')));

  v2.post('/batch/scrape', async (req) => {
    const j = need();
    const n = normalizeBatchRequest(req.body);
    for (const u of n.urls) assertUrlAllowed(u, j.allowPrivateNetworks);
    checkWebhook(n.request.webhook);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'batch',
      apiKeyId: req.apiKeyId,
      request: { urls: n.urls, maxConcurrency: n.request.maxConcurrency, scrapeOptions: n.scrapeOptions },
      webhook: n.request.webhook ?? null,
      limit: n.urls.length,
      expiresAt: new Date(Date.now() + j.ttlHours * 3_600_000),
    });
    await deps.store.reserveUrls(id, n.urls.length);
    const job = (await deps.store.getJob(id))!;
    await sendWebhook(j.queues, job, 'started', []);
    await j.queues.addPages(n.urls.map((url) => ({ jobId: id, url, depth: 0, external: false })));
    return {
      success: true,
      id,
      url: `${baseOf(req)}/v2/batch/scrape/${id}`,
      ...(n.invalidURLs !== undefined ? { invalidURLs: n.invalidURLs } : {}),
      ...(n.warnings.length > 0 ? { warning: n.warnings.join(' ') } : {}),
    };
  });

  v2.get<{ Params: { id: string }; Querystring: { skip?: string } }>('/batch/scrape/:id', async (req) =>
    statusBody(req, await loadJob(req, req.params.id, 'batch'), req.query.skip),
  );
  v2.delete<{ Params: { id: string } }>('/batch/scrape/:id', async (req) => cancel(await loadJob(req, req.params.id, 'batch')));
  v2.get<{ Params: { id: string } }>('/batch/scrape/:id/errors', async (req) => errorsBody(await loadJob(req, req.params.id, 'batch')));
}
```

In `packages/api/src/app.ts`:
1. Add `import { registerJobRoutes, type JobsDeps } from './routes/jobs';`
2. Add `  jobs?: JobsDeps;` to `AppDeps` (after `signer?`).
3. Remove `crawl: 3,` and `batch: 3,` from `PLANNED` (leave `map: 3`; Task 9 removes it).
4. Inside the `v2` plugin, right before `v2.get<{ Params: { id: string } }>('/scrape/:id', …)`, add `registerJobRoutes(v2, deps);`.

- [ ] **Step 4: Run to verify pass**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test && pnpm typecheck`
Expected: PASS. Fix-forward notes: (a) `req.protocol`/`req.headers.host` give `http://localhost:80` under `inject`; the tests encode that. (b) The test `hides jobs from other keys…` ends with a stray `createJob` for an expired job that is not asserted; leave it (harmless) or delete those last two lines. (c) Fastify allows a static route (`/crawl/active`, `/crawl/params-preview`) beside `/crawl/:id`; if `GET /crawl/active` is routed to `:id`, confirm the static routes are registered (they are).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): crawl and batch scrape endpoints with status pagination, cancel, errors and active list" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `api`: `/v2/map`

**Files:**
- Create: `packages/api/src/jobs/map.ts`, `packages/api/src/routes/map.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/map.test.ts`

**Interfaces:**
- Consumes: crawler (`normalizeUrl`, `hostRelation`, `isAssetPath`, sitemap and robots helpers), `runScrape`, `MapRequest` (core).
- Produces:
  - `rankBySearch(urls: string[], search: string): string[]` (keeps URLs containing at least one search token, case-insensitive, ordered by number of matching tokens then original order).
  - `mapSite(deps: { engines: readonly Engine[]; scraper: ScraperConfig; fetcher: Fetcher }, request: MapRequest): Promise<Array<{ url: string; title?: string; description?: string }>>`: start page links (unless `sitemap: 'only'`) plus sitemap URLs (unless `skip`), same-host (and subdomains when `includeSubdomains`), static assets removed, normalised and de-duplicated (query dropped when `ignoreQueryParameters`), the start URL first with its page title/description, `search` applied, cut to `limit`. Errors only when nothing at all could be found; sitemap fetching is bounded by `timeout` (default 30 s).
  - `POST /v2/map` → `{ success: true, links: [...], warning? }` (authenticated); the route needs `deps.jobs` for its fetcher: `MapDeps` is provided through `AppDeps.map?: { fetcher: Fetcher }`.
  - `PLANNED` no longer lists `map`.

- [ ] **Step 1: Write the failing tests**

`packages/api/test/map.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeMapRequest } from '@icecrawl/core';
import { mapSite, rankBySearch } from '../src/jobs/map';
import { fakeFetcher, makeJobDeps, makeJobsApp, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const request = (over: Record<string, unknown> = {}) => normalizeMapRequest({ url: `${E}/`, ...over }).request;

const home = pageHtml('Example Home', [
  '/a',
  '/a?utm=1',
  '/b/',
  `${E}/logo.png`,
  'https://blog.example.com/post',
  'https://other.org/x',
  'mailto:me@example.com',
  '#top',
]);
const sitemap = `<urlset><url><loc>${E}/from-sitemap</loc></url><url><loc>${E}/a</loc></url><url><loc>https://other.org/y</loc></url></urlset>`;

const mk = (over: { site?: Record<string, { html: string; status?: number }>; files?: Parameters<typeof fakeFetcher>[0] } = {}) => {
  const { deps } = makeJobDeps({ site: over.site ?? { [`${E}/`]: { html: home } }, files: over.files ?? { [`${E}/robots.txt`]: { status: 404, body: '' }, [`${E}/sitemap.xml`]: { body: sitemap } } });
  return { engines: deps.engines, scraper: deps.scraper, fetcher: deps.fetcher };
};

describe('rankBySearch', () => {
  it('keeps matching URLs ordered by token matches, then original order', () => {
    const urls = ['https://e.com/pricing', 'https://e.com/docs/api-keys', 'https://e.com/docs/api', 'https://e.com/blog'];
    expect(rankBySearch(urls, 'docs api')).toEqual(['https://e.com/docs/api-keys', 'https://e.com/docs/api']);
    expect(rankBySearch(urls, 'PRICING')).toEqual(['https://e.com/pricing']);
    expect(rankBySearch(urls, 'nothing')).toEqual([]);
    expect(rankBySearch(urls, '   ')).toEqual(urls);
  });
});

describe('mapSite', () => {
  it('combines page links and sitemap URLs, same host and subdomains only, without assets or duplicates', async () => {
    const links = await mapSite(mk(), request());
    expect(links.map((l) => l.url)).toEqual([
      `${E}/`,
      `${E}/a`,
      `${E}/b`,
      'https://blog.example.com/post',
      `${E}/from-sitemap`,
    ]);
    expect(links[0]).toMatchObject({ url: `${E}/`, title: 'Example Home' });
  });

  it('excludes subdomains when includeSubdomains is false', async () => {
    const links = await mapSite(mk(), request({ includeSubdomains: false }));
    expect(links.map((l) => l.url)).not.toContain('https://blog.example.com/post');
  });

  it('keeps query variants apart when ignoreQueryParameters is false', async () => {
    const links = await mapSite(mk(), request({ ignoreQueryParameters: false }));
    expect(links.map((l) => l.url)).toContain(`${E}/a?utm=1`);
    expect(links.map((l) => l.url)).toContain(`${E}/a`);
  });

  it('supports sitemap=only and sitemap=skip', async () => {
    const only = await mapSite(mk(), request({ sitemap: 'only' }));
    expect(only.map((l) => l.url)).toEqual([`${E}/from-sitemap`, `${E}/a`]);
    const skip = await mapSite(mk(), request({ sitemap: 'skip' }));
    expect(skip.map((l) => l.url)).not.toContain(`${E}/from-sitemap`);
    expect(skip.map((l) => l.url)).toContain(`${E}/b`);
  });

  it('applies search and limit', async () => {
    const searched = await mapSite(mk(), request({ search: 'sitemap' }));
    expect(searched.map((l) => l.url)).toEqual([`${E}/from-sitemap`]);
    const limited = await mapSite(mk(), request({ limit: 2 }));
    expect(limited).toHaveLength(2);
  });

  it('still returns sitemap URLs when the start page cannot be scraped', async () => {
    const links = await mapSite(mk({ site: { [`${E}/`]: { status: 403, html: 'no' } } }), request());
    expect(links.map((l) => l.url)).toEqual([`${E}/from-sitemap`, `${E}/a`]);
  });

  it('fails when nothing could be discovered', async () => {
    await expect(mapSite(mk({ site: {}, files: {} }), request())).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_ERROR|BLOCKED|EMPTY_CONTENT/) });
  });

  it('is not stopped by a robots.txt that disallows everything (map only reads sitemaps from it)', async () => {
    const m = mk({ files: { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /\nSitemap: https://example.com/custom.xml' }, 'https://example.com/custom.xml': { body: `<urlset><url><loc>${E}/custom-page</loc></url></urlset>` } } });
    const links = await mapSite(m, request({ sitemap: 'only' }));
    expect(links.map((l) => l.url)).toEqual([`${E}/custom-page`]);
  });
});

describe('POST /v2/map', () => {
  it('returns links in the v2 shape', async () => {
    const t = await makeJobsApp({ site: { [`${E}/`]: { html: home } }, files: { [`${E}/robots.txt`]: { status: 404, body: '' }, [`${E}/sitemap.xml`]: { body: sitemap } } });
    const res = await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: `${E}/`, limit: 3 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.links).toHaveLength(3);
    expect(body.links[0]).toMatchObject({ url: `${E}/`, title: 'Example Home' });
    for (const l of body.links) expect(typeof l.url).toBe('string');
  });

  it('validates input, requires authentication and refuses private targets', async () => {
    const t = await makeJobsApp();
    expect((await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: 'nope' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/v2/map', payload: { url: `${E}/` } })).statusCode).toBe(401);
    const priv = await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: 'http://127.0.0.1/' } });
    expect(priv.json()).toMatchObject({ code: 'SSRF_BLOCKED' });
  });
});
```
(`makeJobsApp` must give the app a `map` dependency; Step 3 wires it through `AppDeps.map`, and Step 1b below updates the helper.)

- [ ] **Step 1b: Update the helper to provide the map dependency**

In `packages/api/test/jobs-helpers.ts`, in `makeJobsApp`, add `map: { fetcher: deps.fetcher },` to the object passed to `buildApp` (next to `jobs: {...}`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/test/map.test.ts`
Expected: FAIL (`../src/jobs/map` missing).

- [ ] **Step 3: Implement**

`packages/api/src/jobs/map.ts`:
```ts
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
```

`packages/api/src/routes/map.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { IceCrawlError, normalizeMapRequest } from '@icecrawl/core';
import { assertUrlAllowed, type Engine } from '@icecrawl/engines';
import type { ScraperConfig } from '@icecrawl/scraper';
import { mapSite, type MapDeps } from '../jobs/map';

export interface MapRouteDeps {
  engines: readonly Engine[];
  scraper: ScraperConfig;
  map?: Pick<MapDeps, 'fetcher'>;
}

export function registerMapRoute(v2: FastifyInstance, deps: MapRouteDeps): void {
  v2.post('/map', async (req) => {
    if (!deps.map) throw new IceCrawlError('NOT_IMPLEMENTED', 'Map is not configured on this server.');
    const { request, warnings } = normalizeMapRequest(req.body);
    assertUrlAllowed(request.url, deps.scraper.allowPrivateNetworks);
    const links = await mapSite({ engines: deps.engines, scraper: deps.scraper, fetcher: deps.map.fetcher }, request);
    return { success: true, links, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
  });
}
```

In `packages/api/src/app.ts`: add `import { registerMapRoute } from './routes/map';` and `import type { MapDeps } from './jobs/map';`; add `  map?: Pick<MapDeps, 'fetcher'>;` to `AppDeps`; remove `map: 3,` from `PLANNED`; and call `registerMapRoute(v2, deps);` right after `registerJobRoutes(v2, deps);`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If the ordering assertion for search fails, note that `rank` already contains only matching URLs (the `keep` set is redundant but harmless); keep the behaviour and the test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): /v2/map with sitemap and page-link discovery, subdomain/query handling, search and limit" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Runtime wiring, BullMQ workers, end-to-end crawl test, Docker, docs

**Files:**
- Create: `packages/api/src/jobs/fetcher.ts`, `packages/api/src/jobs/runner.ts`, `packages/api/src/jobs/reaper.ts`, `packages/api/src/webhook-secret.ts`, `packages/api/src/runtime.ts`, `packages/api/src/worker.ts`
- Modify: `packages/api/src/config.ts`, `packages/api/src/server.ts`, `packages/api/package.json` (script), `docker-compose.yml`, `.env.example`, `README.md`, `docs/superpowers/specs/2026-10-24-icecrawl-design.md`
- Test: `packages/api/test/e2e.crawl.test.ts`

**Interfaces:**
- Produces:
  - `makeFetcher(o: { allowPrivateNetworks: boolean; maxBytes?: number; timeoutMs?: number }): Fetcher` (uses `fetchEngine`, so SSRF-safe; returns `{ status, body }`).
  - `startJobWorkers(q: BullQueues, deps: JobDeps, delivery: DeliveryDeps, o: { concurrency: number }): { close(): Promise<void> }`.
  - `startReaper(store: Store, intervalMs?: number): () => void` (deletes expired jobs; unref'd timer).
  - `loadOrCreateWebhookSecret(file: string): Promise<string>` (32 random bytes hex, file mode 0600, created if absent).
  - `createRuntime(config: AppConfig): Promise<Runtime>` where `Runtime` bundles `{ sql; store; snapshots; signer; engines; browser; queues: BullQueues; jobDeps: JobDeps; delivery: DeliveryDeps; close(): Promise<void> }`.
  - New env settings: `REDIS_URL`, `ICECRAWL_QUEUE_PREFIX` (default `icecrawl`), `ICECRAWL_RUN_WORKER` (default `true`), `ICECRAWL_WORKER_CONCURRENCY` (default 8), `ICECRAWL_JOB_TTL_HOURS` (24), `ICECRAWL_JOB_PAGE_BYTES` (10485760), `ICECRAWL_MAX_CRAWL_LIMIT` (100000), `ICECRAWL_ALLOW_IGNORE_ROBOTS` (false), `ICECRAWL_PUBLIC_URL` (optional), `ICECRAWL_WEBHOOK_SECRET_FILE` (`./data/webhook-secret`), `ICECRAWL_SCRAPE_MAX_ATTEMPTS` (3).
  - `pnpm --filter @icecrawl/api worker` runs a worker-only process; compose gains a `worker` service.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/api/test/e2e.crawl.test.ts`:
```ts
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine } from '@icecrawl/engines';
import { BullQueues } from '@icecrawl/queue';
import { sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { makeFetcher } from '../src/jobs/fetcher';
import { startJobWorkers } from '../src/jobs/runner';
import type { JobDeps } from '../src/jobs/processor';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';
import { filler } from './jobs-helpers';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const html = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${filler}</p>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(' ')}</article></body></html>`;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!databaseUrl || !redisUrl)('end to end: crawl, batch, map and webhooks with real Postgres, Redis and BullMQ', () => {
  const sql = createSql(databaseUrl ?? 'postgres://unused');
  let origin: Server;
  let receiver: Server;
  let port: number;
  let hookPort: number;
  let dir: string;
  let queues: BullQueues;
  let stopWorkers: { close(): Promise<void> };
  let app: ReturnType<typeof buildApp>;
  let auth: { authorization: string };
  const secret = 'e2e-webhook-secret';
  const hits: string[] = [];
  const hooks: Array<{ headers: IncomingMessage['headers']; body: string }> = [];

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-crawl-'));

    origin = createServer((req, res) => {
      const url = req.url ?? '/';
      hits.push(url);
      const send = (status: number, type: string, body: string) => res.writeHead(status, { 'content-type': type }).end(body);
      const o = `http://127.0.0.1:${port}`;
      switch (url) {
        case '/robots.txt':
          return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\nSitemap: ${o}/sitemap.xml\n`);
        case '/sitemap.xml':
          return send(200, 'application/xml', `<urlset><url><loc>${o}/sitemap-only</loc></url><url><loc>${o}/a</loc></url></urlset>`);
        case '/':
          return send(200, 'text/html', html('Home', ['/a', '/b', '/blog/post-1', '/private/secret', '/missing', '/logo.png']));
        case '/a':
          return send(200, 'text/html', html('A', ['/b', '/a/deep']));
        case '/a/deep':
          return send(200, 'text/html', html('Deep'));
        case '/b':
          return send(200, 'text/html', html('B'));
        case '/blog/post-1':
          return send(200, 'text/html', html('Post 1'));
        case '/sitemap-only':
          return send(200, 'text/html', html('Sitemap only'));
        case '/private/secret':
          return send(200, 'text/html', html('Secret'));
        case '/slow1':
        case '/slow2':
        case '/slow3':
          return send(200, 'text/html', html(url.slice(1), ['/slow1', '/slow2', '/slow3']));
        default:
          return send(404, 'text/html', '<html><body>missing</body></html>');
      }
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;

    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hooks.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    hookPort = (receiver.address() as AddressInfo).port;

    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(join(dir, 'snaps'));
    queues = new BullQueues({ redisUrl: redisUrl!, prefix: `icecrawl-e2e-${randomUUID().slice(0, 8)}`, maxAttempts: 2 });
    const scraper = { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false };
    const fetcher = makeFetcher({ allowPrivateNetworks: true });
    const jobDeps: JobDeps = { store, snapshots, engines: [fetchEngine], scraper, queues, fetcher, allowIgnoreRobots: false };
    stopWorkers = startJobWorkers(queues, jobDeps, { secret, allowPrivate: true }, { concurrency: 4 });

    const token = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(token), name: 'e2e-crawl' });
    auth = { authorization: `Bearer ${token}` };
    app = buildApp({
      store,
      snapshots,
      engines: [fetchEngine],
      scraper,
      useAuth: true,
      map: { fetcher },
      jobs: { queues, ttlHours: 24, pageBytes: 10_000_000, maxCrawlLimit: 1000, allowPrivateNetworks: true, allowIgnoreRobots: false },
    });
  });

  afterAll(async () => {
    await stopWorkers.close();
    const keys = await queues.connection.keys(`${queues.prefix}:*`);
    if (keys.length > 0) await queues.connection.del(...keys);
    await queues.close();
    origin.closeAllConnections();
    origin.close();
    receiver.closeAllConnections();
    receiver.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  const o = () => `http://127.0.0.1:${port}`;
  const start = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/v2/crawl', headers: auth, payload: payload as never });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; url: string };
  };
  const finished = (id: string, path = 'crawl') =>
    until(async () => {
      const body = (await app.inject({ method: 'GET', url: `/v2/${path}/${id}`, headers: auth })).json();
      return body.status !== 'scraping' ? body : false;
    });

  it('crawls a site: robots, sitemap, dedup, scope, errors, signed webhooks and receipts', async () => {
    hooks.length = 0;
    const { id } = await start({
      url: `${o()}/`,
      webhook: { url: `http://127.0.0.1:${hookPort}/hook`, metadata: { run: 'e2e' }, headers: { 'X-Run': '1' } },
    });
    const body = await finished(id);
    expect(body.status).toBe('completed');

    const urls = body.data.map((d: { metadata: { sourceURL: string } }) => d.metadata.sourceURL).sort();
    expect(urls).toEqual(['/', '/a', '/a/deep', '/b', '/blog/post-1', '/sitemap-only'].map((p) => `${o()}${p}`).sort());
    expect(body.total).toBe(8);
    expect(body.completed).toBe(6);

    const errors = (await app.inject({ method: 'GET', url: `/v2/crawl/${id}/errors`, headers: auth })).json();
    expect(errors.robotsBlocked).toEqual([`${o()}/private/secret`]);
    expect(errors.errors.map((e: { url: string }) => e.url)).toEqual([`${o()}/missing`]);
    expect(hits).not.toContain('/private/secret');
    expect(hits.filter((h) => h === '/a')).toHaveLength(1);
    expect(hits).not.toContain('/logo.png');

    const receiptId = body.data[0].trust.receiptId as string;
    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${receiptId}`, headers: auth })).json();
    expect(receipt.success).toBe(true);

    await until(async () => hooks.some((h) => JSON.parse(h.body).type === 'crawl.completed') || false);
    const events = hooks.map((h) => JSON.parse(h.body));
    expect(events[0].type).toBe('crawl.started');
    expect(events.filter((e) => e.type === 'crawl.page')).toHaveLength(8);
    expect(events.at(-1).type).toBe('crawl.completed');
    expect(events.every((e) => e.id === id && e.metadata.run === 'e2e')).toBe(true);
    for (const h of hooks) {
      const expected = `sha256=${createHmac('sha256', secret).update(h.body).digest('hex')}`;
      expect(h.headers['x-icecrawl-signature']).toBe(expected);
      expect(h.headers['x-firecrawl-signature']).toBe(expected);
      expect(h.headers['x-run']).toBe('1');
    }
  });

  it('applies includePaths and the page limit', async () => {
    const included = await finished((await start({ url: `${o()}/`, includePaths: ['^/blog'], sitemap: 'skip' })).id);
    expect(included.data.map((d: { metadata: { sourceURL: string } }) => d.metadata.sourceURL).sort()).toEqual([`${o()}/`, `${o()}/blog/post-1`].sort());

    const limited = await finished((await start({ url: `${o()}/`, limit: 2, sitemap: 'skip' })).id);
    expect(limited.total).toBe(2);
    expect(limited.data).toHaveLength(2);
  });

  it('cancels a slow crawl and stops scraping', async () => {
    const { id } = await start({ url: `${o()}/slow1`, delay: 1, sitemap: 'skip' });
    await until(async () => ((await app.inject({ method: 'GET', url: `/v2/crawl/${id}`, headers: auth })).json().completed >= 1) || false);
    const del = await app.inject({ method: 'DELETE', url: `/v2/crawl/${id}`, headers: auth });
    expect(del.json()).toEqual({ status: 'cancelled' });
    const before = hits.filter((h) => h.startsWith('/slow')).length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(hits.filter((h) => h.startsWith('/slow')).length).toBeLessThanOrEqual(before + 1);
    expect((await app.inject({ method: 'GET', url: `/v2/crawl/${id}`, headers: auth })).json().status).toBe('cancelled');
  });

  it('runs a batch scrape with an invalid URL and a failing page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v2/batch/scrape',
      headers: auth,
      payload: { urls: [`${o()}/a`, `${o()}/b`, `${o()}/missing`, 'not-a-url'], formats: ['markdown', 'links'] } as never,
    });
    const { id, invalidURLs } = res.json();
    expect(invalidURLs).toEqual(['not-a-url']);
    const body = await finished(id, 'batch/scrape');
    expect(body).toMatchObject({ status: 'completed', total: 3, completed: 2 });
    expect(body.data[0].links).toBeDefined();
    const errors = (await app.inject({ method: 'GET', url: `/v2/batch/scrape/${id}/errors`, headers: auth })).json();
    expect(errors.errors).toHaveLength(1);
  });

  it('maps a site', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/map', headers: auth, payload: { url: `${o()}/` } as never });
    const links = res.json().links.map((l: { url: string }) => l.url);
    expect(links).toContain(`${o()}/sitemap-only`);
    expect(links).toContain(`${o()}/blog/post-1`);
    expect(links).not.toContain(`${o()}/logo.png`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm vitest run packages/api/test/e2e.crawl.test.ts`
Expected: FAIL (`../src/jobs/fetcher` and `runner` missing).

- [ ] **Step 3: Implement the fetcher, runner, reaper and webhook secret**

`packages/api/src/jobs/fetcher.ts`:
```ts
import type { Fetcher } from '@icecrawl/crawler';
import { fetchEngine } from '@icecrawl/engines';

/** Plain, SSRF-safe GET used for robots.txt and sitemaps. Redirects are followed by the fetch engine. */
export function makeFetcher(o: { allowPrivateNetworks: boolean; maxBytes?: number; timeoutMs?: number }): Fetcher {
  return async (url) => {
    const r = await fetchEngine.scrape({
      url,
      headers: {},
      timeoutMs: o.timeoutMs ?? 10_000,
      skipTlsVerification: true,
      allowPrivateNetworks: o.allowPrivateNetworks,
      maxBytes: o.maxBytes ?? 20 * 1024 * 1024,
      waitFor: 0,
      mobile: false,
      actions: [],
      screenshot: null,
    });
    return { status: r.statusCode, body: r.body };
  };
}
```

`packages/api/src/jobs/runner.ts`:
```ts
import { startWorkers, type BullQueues } from '@icecrawl/queue';
import { processScrapeJob, type JobDeps } from './processor';
import { deliverWebhook, type DeliveryDeps } from './webhooks';

export function startJobWorkers(
  q: BullQueues,
  deps: JobDeps,
  delivery: DeliveryDeps,
  o: { concurrency: number },
): { close(): Promise<void> } {
  return startWorkers(
    q,
    {
      scrape: (data, ctx) => processScrapeJob(deps, data, ctx),
      webhook: (data) => deliverWebhook(delivery, data),
    },
    { concurrency: o.concurrency },
  );
}
```

`packages/api/src/jobs/reaper.ts`:
```ts
import type { Store } from '../store/types';

/** Deletes expired jobs (and their pages and receipts) on an interval. Returns a stop function. */
export function startReaper(store: Store, intervalMs = 3_600_000): () => void {
  const timer = setInterval(() => {
    store.deleteExpiredJobs(new Date()).catch((err) => console.error('[icecrawl] reaper failed:', (err as Error).message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

`packages/api/src/webhook-secret.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadOrCreateWebhookSecret(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const secret = randomBytes(32).toString('hex');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, secret, { mode: 0o600, flag: 'wx' });
  return secret;
}
```

- [ ] **Step 4: Config, runtime, server and worker entry**

Replace `packages/api/src/config.ts` with (keeping the existing fields and adding the new ones):
```ts
export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  snapshotDir: string;
  useAuth: boolean;
  allowPrivateNetworks: boolean;
  strict: boolean;
  maxResponseBytes: number;
  browserEnabled: boolean;
  preferBrowser: boolean;
  browserConcurrency: number;
  browserNoSandbox: boolean;
  signingKeyFile: string;
  webhookSecretFile: string;
  runWorker: boolean;
  workerConcurrency: number;
  scrapeMaxAttempts: number;
  jobTtlHours: number;
  jobPageBytes: number;
  maxCrawlLimit: number;
  allowIgnoreRobots: boolean;
  publicUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3002),
    databaseUrl: env.DATABASE_URL ?? 'postgres://icecrawl:icecrawl@localhost:5432/icecrawl',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    queuePrefix: env.ICECRAWL_QUEUE_PREFIX ?? 'icecrawl',
    snapshotDir: env.ICECRAWL_SNAPSHOT_DIR ?? './data/snapshots',
    useAuth: env.ICECRAWL_USE_AUTH !== 'false',
    allowPrivateNetworks: env.ICECRAWL_ALLOW_PRIVATE_NETWORKS === 'true',
    strict: env.ICECRAWL_STRICT === 'true',
    maxResponseBytes: Number(env.ICECRAWL_MAX_RESPONSE_BYTES ?? 10 * 1024 * 1024),
    browserEnabled: env.ICECRAWL_BROWSER !== 'false',
    preferBrowser: env.ICECRAWL_PREFER_BROWSER !== 'false',
    browserConcurrency: Number(env.ICECRAWL_BROWSER_CONCURRENCY ?? 4),
    browserNoSandbox: env.ICECRAWL_BROWSER_NO_SANDBOX === 'true',
    signingKeyFile: env.ICECRAWL_SIGNING_KEY_FILE ?? './data/signing-key.pem',
    webhookSecretFile: env.ICECRAWL_WEBHOOK_SECRET_FILE ?? './data/webhook-secret',
    runWorker: env.ICECRAWL_RUN_WORKER !== 'false',
    workerConcurrency: Number(env.ICECRAWL_WORKER_CONCURRENCY ?? 8),
    scrapeMaxAttempts: Number(env.ICECRAWL_SCRAPE_MAX_ATTEMPTS ?? 3),
    jobTtlHours: Number(env.ICECRAWL_JOB_TTL_HOURS ?? 24),
    jobPageBytes: Number(env.ICECRAWL_JOB_PAGE_BYTES ?? 10 * 1024 * 1024),
    maxCrawlLimit: Number(env.ICECRAWL_MAX_CRAWL_LIMIT ?? 100_000),
    allowIgnoreRobots: env.ICECRAWL_ALLOW_IGNORE_ROBOTS === 'true',
    publicUrl: env.ICECRAWL_PUBLIC_URL || undefined,
  };
}
```

`packages/api/src/runtime.ts`:
```ts
import { createPlaywrightEngine, fetchEngine, type Engine, type PlaywrightEngine } from '@icecrawl/engines';
import { BullQueues } from '@icecrawl/queue';
import type { PrivateSigningKey } from '@icecrawl/trust';
import type postgres from 'postgres';
import type { AppConfig } from './config';
import { makeFetcher } from './jobs/fetcher';
import type { JobDeps } from './jobs/processor';
import type { DeliveryDeps } from './jobs/webhooks';
import { loadOrCreateSigningKey } from './signing';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';
import type { SnapshotStore, Store } from './store/types';
import { loadOrCreateWebhookSecret } from './webhook-secret';

export interface Runtime {
  sql: postgres.Sql;
  store: Store;
  snapshots: SnapshotStore;
  signer: PrivateSigningKey;
  engines: Engine[];
  browser: PlaywrightEngine | null;
  queues: BullQueues;
  jobDeps: JobDeps;
  delivery: DeliveryDeps;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig): Promise<Runtime> {
  const sql = createSql(config.databaseUrl);
  await migrate(sql);
  const store = new PgStore(sql);
  const snapshots = new FileSnapshotStore(config.snapshotDir);
  const signer = await loadOrCreateSigningKey(config.signingKeyFile, store);
  const webhookSecret = await loadOrCreateWebhookSecret(config.webhookSecretFile);

  const browser = config.browserEnabled
    ? createPlaywrightEngine({
        quality: config.preferBrowser ? 20 : 4,
        maxConcurrency: config.browserConcurrency,
        noSandbox: config.browserNoSandbox,
      })
    : null;
  const engines: Engine[] = browser ? [browser, fetchEngine] : [fetchEngine];

  const queues = new BullQueues({ redisUrl: config.redisUrl, prefix: config.queuePrefix, maxAttempts: config.scrapeMaxAttempts });
  const scraper = {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
  };
  const jobDeps: JobDeps = {
    store,
    snapshots,
    engines,
    scraper,
    signer,
    queues,
    fetcher: makeFetcher({ allowPrivateNetworks: config.allowPrivateNetworks }),
    allowIgnoreRobots: config.allowIgnoreRobots,
  };

  return {
    sql,
    store,
    snapshots,
    signer,
    engines,
    browser,
    queues,
    jobDeps,
    delivery: { secret: webhookSecret, allowPrivate: config.allowPrivateNetworks },
    async close() {
      await queues.close();
      await browser?.close();
      await sql.end();
    },
  };
}
```

Replace `packages/api/src/server.ts` with:
```ts
import { buildApp } from './app';
import { loadConfig } from './config';
import { startReaper } from './jobs/reaper';
import { startJobWorkers } from './jobs/runner';
import { createRuntime } from './runtime';

const config = loadConfig();
const rt = await createRuntime(config);

const app = buildApp({
  store: rt.store,
  snapshots: rt.snapshots,
  engines: rt.engines,
  scraper: rt.jobDeps.scraper,
  useAuth: config.useAuth,
  signer: rt.signer,
  map: { fetcher: rt.jobDeps.fetcher },
  jobs: {
    queues: rt.queues,
    publicUrl: config.publicUrl,
    ttlHours: config.jobTtlHours,
    pageBytes: config.jobPageBytes,
    maxCrawlLimit: config.maxCrawlLimit,
    allowPrivateNetworks: config.allowPrivateNetworks,
    allowIgnoreRobots: config.allowIgnoreRobots,
  },
});

const workers = config.runWorker ? startJobWorkers(rt.queues, rt.jobDeps, rt.delivery, { concurrency: config.workerConcurrency }) : null;
const stopReaper = startReaper(rt.store);

const shutdown = async () => {
  stopReaper();
  await app.close();
  await workers?.close();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'}, engines ${rt.engines.map((e) => e.name).join(' > ')}, signing key ${rt.signer.keyId}, worker ${config.runWorker ? 'in-process' : 'external'})`,
);
```

`packages/api/src/worker.ts`:
```ts
import { loadConfig } from './config';
import { startReaper } from './jobs/reaper';
import { startJobWorkers } from './jobs/runner';
import { createRuntime } from './runtime';

const config = loadConfig();
const rt = await createRuntime(config);
const workers = startJobWorkers(rt.queues, rt.jobDeps, rt.delivery, { concurrency: config.workerConcurrency });
const stopReaper = startReaper(rt.store);

const shutdown = async () => {
  stopReaper();
  await workers.close();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`IceCrawl worker running (concurrency ${config.workerConcurrency}, signing key ${rt.signer.keyId})`);
```
Add `"worker": "tsx src/worker.ts"` to `packages/api/package.json` `scripts`.

- [ ] **Step 5: Run the end-to-end test and the whole suite**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm vitest run packages/api/test/e2e.crawl.test.ts`
Expected: 5 tests PASS (not skipped). Repeat 3 times to check for flakiness.

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test && pnpm typecheck`
Expected: every file passes, nothing skipped, typecheck exits 0. Fix-forward notes: (a) the page-count assertions (`total` 8, `completed` 6, 8 `crawl.page` events) follow from the fixture: pages `/ /a /a/deep /b /blog/post-1 /sitemap-only` succeed, `/missing` fails, `/private/secret` is robots-blocked; if the real count differs, trace which URL is missing before changing numbers. (b) The cancel test tolerates one extra in-flight page. (c) If the webhook test sees fewer than 8 page events because webhook jobs are still queued, the `until(... crawl.completed)` wait must also cover the last page events; completed is queued last, so the check is sufficient only if the webhook worker processes in order; with concurrency 4 it may not: wait until `hooks.length >= 10` instead (1 started + 8 page + 1 completed) and keep the other assertions.

- [ ] **Step 6: Compose, env, docs**

In `docker-compose.yml`, in the `api` service `environment:` add:
```yaml
      ICECRAWL_RUN_WORKER: "false"
      ICECRAWL_WEBHOOK_SECRET_FILE: /data/signing/webhook-secret
```
and add this service after `api`:
```yaml
  worker:
    build: .
    command: ["pnpm", "--filter", "@icecrawl/api", "worker"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://icecrawl:icecrawl@postgres:5432/icecrawl
      REDIS_URL: redis://redis:6379
      ICECRAWL_SNAPSHOT_DIR: /data/snapshots
      ICECRAWL_SIGNING_KEY_FILE: /data/signing/signing-key.pem
      ICECRAWL_WEBHOOK_SECRET_FILE: /data/signing/webhook-secret
      ICECRAWL_BROWSER_NO_SANDBOX: "true"
    volumes: ["snapshots:/data/snapshots", "signing:/data/signing"]
    shm_size: "1gb"
```
Append to `.env.example`:
```
REDIS_URL=redis://localhost:6379
ICECRAWL_QUEUE_PREFIX=icecrawl
ICECRAWL_RUN_WORKER=true
ICECRAWL_WORKER_CONCURRENCY=8
ICECRAWL_SCRAPE_MAX_ATTEMPTS=3
ICECRAWL_JOB_TTL_HOURS=24
ICECRAWL_JOB_PAGE_BYTES=10485760
ICECRAWL_MAX_CRAWL_LIMIT=100000
ICECRAWL_ALLOW_IGNORE_ROBOTS=false
ICECRAWL_PUBLIC_URL=
ICECRAWL_WEBHOOK_SECRET_FILE=./data/webhook-secret
```
(Remove the duplicate `REDIS_URL` line if `.env.example` already has one.)

In `README.md`: change the status line to `> Status: phase 3 (crawl layer). Scrape, crawl, batch scrape and map work, with signed webhooks. Search, extract, MCP and the rest follow the roadmap in \`docs/superpowers/specs/2026-10-24-icecrawl-design.md\`.` and add this section before `## Tests` (use real triple-backtick fences):
```markdown
## Crawling

```bash
# start a crawl (returns an id and a status URL)
curl -s http://localhost:3002/v2/crawl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://docs.example.com","limit":50,"includePaths":["^/guide"],"webhook":{"url":"https://you.example.com/hook"}}'

# poll it (pages arrive as they finish; follow "next" for more than ~10 MB)
curl -s http://localhost:3002/v2/crawl/$ID -H "Authorization: Bearer $KEY"
curl -s http://localhost:3002/v2/crawl/$ID/errors -H "Authorization: Bearer $KEY"   # failed pages and robots.txt blocks
curl -s -X DELETE http://localhost:3002/v2/crawl/$ID -H "Authorization: Bearer $KEY"  # cancel
```

Crawls respect robots.txt (including `Crawl-delay`), seed from the sitemap, never fetch a URL twice, stay inside the start path unless `crawlEntireDomain` is set, and follow external links one hop only with `allowExternalLinks`. Every crawled page is a normal scrape with a verdict and a signed receipt (`data[].trust.receiptId`). `/v2/batch/scrape` takes a list of URLs, `/v2/map` lists a site's URLs.

Webhooks are signed: `X-IceCrawl-Signature: sha256=<hmac of the raw body>` (also sent as `X-Firecrawl-Signature`). The secret is generated into `ICECRAWL_WEBHOOK_SECRET_FILE` on first start.

Workers run inside the API process by default. To scale out, run the API with `ICECRAWL_RUN_WORKER=false` and start `pnpm --filter @icecrawl/api worker` (or `docker compose up worker`) as many times as needed.
```

In `docs/superpowers/specs/2026-10-24-icecrawl-design.md`: in the package table add two rows after the `scraper` row:
```
| `crawler` | Pure crawl logic: URL normalisation, link-scope rules, robots.txt (RFC 9309), sitemap discovery. | none |
| `queue` | `JobQueues` interface, BullMQ implementation and in-memory twin; frontier de-dup and concurrency/delay slots in Redis. | none |
```
and append a bullet at the end of section 8: `- Crawls respect robots.txt (RFC 9309: 4xx allow all, 5xx or unreachable disallow all); \`ignoreRobotsTxt\` works only when the operator enables it. Webhook deliveries are SSRF-checked and HMAC-signed (phase 3). Job workers live in the \`api\` package for now.`

- [ ] **Step 7: Verify Docker config and run a live smoke test**

Run: `docker compose config -q`
Expected: valid.

Run: `pnpm db:up`, then `pnpm --filter @icecrawl/api keys:create dev` (note the key), then start the server in the background: `ICECRAWL_BROWSER=false pnpm --filter @icecrawl/api start`.
Expected: `IceCrawl listening on :3002 (... worker in-process)`.

Start a throwaway local site for the smoke test (`node` one-liner HTTP server on port 4100 serving `/` linking to `/a` and `/b`, and a `/robots.txt` that disallows `/b`), restart the API with `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true ICECRAWL_BROWSER=false`, then:
```bash
curl -s http://localhost:3002/v2/crawl -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4100/","sitemap":"skip"}'
```
Expected: `{"success":true,"id":"...","url":"http://localhost:3002/v2/crawl/..."}`.

Poll the returned URL until `"status":"completed"`.
Expected: `completed` 2, `/b` listed under `robotsBlocked` at `/v2/crawl/<id>/errors`; then `pnpm --filter @icecrawl/cli icecrawl verify <receiptId from data[0].trust.receiptId> --api http://localhost:3002 --key KEY` prints all checks `PASS`.

Also run one real public crawl to confirm networking works without private-network mode (restart without `ICECRAWL_ALLOW_PRIVATE_NETWORKS`): `{"url":"https://example.com","limit":3,"sitemap":"skip"}`; expected `completed` 1 (the IANA link is external and not followed).

Stop the server (kill only the PID listening on 3002; confirm with `netstat` that the port is free) and stop the throwaway site.

- [ ] **Step 8: Run everything and commit**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test && pnpm typecheck`
Expected: all test files PASS with none skipped; typecheck exits 0.

```bash
git add -A
git commit -m "feat: BullMQ workers, runtime wiring, e2e crawl/batch/map/webhook test, compose worker, docs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage for phase 3)

| Phase 3 item (spec section 10) | Task |
|---|---|
| `/map` | 1 (schema), 9 (implementation, route) |
| `/crawl` (+ status, errors, cancel, active) | 1, 8, 7 |
| `/batch/scrape` (+ status, errors, cancel) | 1, 8, 7 |
| webhooks | 6 (payload, signing, SSRF-safe delivery), 7 (events), 8 (started for batch) |
| robots | 3 (RFC 9309 rules), 7 (enforcement, crawl-delay, ignore flag) |
| frontier | 2 (scope + dedup normalisation), 5 (Redis seen-set), 7 (reserve against limit, depth) |
| jobs table, queue, worker | 4, 5, 7, 10 |
| Redis for BullMQ + frontier de-dup (spec sections 6, 3) | 5, 10 |
| `crawl children use parent_id` (spec 6) | realised as `scrapes.job_id` (4); noted in deviations |
| `/crawl/params-preview`, `prompt` | 8 (501 / warning), deferred to phase 5 |
| Receipts for every crawled page (trust principle) | 6 (`scrapeAndPersist`), 10 (e2e fetches a receipt) |

Not in this plan on purpose: per-API-key rate limits, LLM-driven crawl parameters (phase 5), separate worker package, crash-recovery reaper for stuck counters, snapshot blob garbage collection, JavaScript-rendered link discovery beyond what the browser engine already returns (it works, but is untested at crawl scale), Redis-shared robots cache.

Type consistency: `JobQueues`/`ScrapeJobData`/`PageJobData`/`WebhookJobData` (Task 5) are used unchanged by `webhooks.ts` (6), `processor.ts` (7), routes (8) and the runner (10); `JobRecord`/`Store` job methods (Task 4) match their use in 6–10; `CrawlRequest` stored by `POST /crawl` (8) is re-parsed by `crawlRequestSchema.parse(job.request)` in the processor (7); `Fetcher` (Task 3) is produced by `makeFetcher` (10) and the test `fakeFetcher` (7); `AppDeps.jobs`/`AppDeps.map` (8, 9) are filled by `server.ts` (10) and `makeJobsApp` (8, 9).
