# IceCrawl Phase 2 (Browser + Signing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v2/scrape` can render JavaScript pages in a real browser, run Firecrawl-style `actions`, return screenshots, and every receipt is Ed25519-signed and independently verifiable with `icecrawl verify` (signature, snapshot hash, and a replay of the HTML-to-markdown conversion).

**Architecture:** A new `playwright` engine joins `fetch` in the picker. All browser traffic is forced through an in-process egress proxy that applies the SSRF guard at connect time, so private addresses stay blocked for pages, redirects and subresources. Receipts gain a few additive fields and are signed (RFC 8785 canonical JSON, Ed25519); the signature is stored beside the receipt. A new `cli` package verifies a receipt against its stored snapshot using the same converter code as the pipeline.

**Tech Stack:** playwright-core 1.64.x (Chromium), Node `crypto` (Ed25519), Fastify 5, Postgres 16, vitest 2. No new runtime dependency for canonical JSON.

## Global Constraints

Copied from `docs/superpowers/specs/2026-10-24-icecrawl-design.md` and phase 1:

- TypeScript on Node >=20.12; Apache-2.0; clean-room (no Firecrawl code copied).
- Receipt signature: Ed25519 over RFC 8785 canonical JSON. Public keys at `/.well-known/icecrawl-keys.json` so receipts survive key rotation.
- `icecrawl verify` re-hashes the snapshot, re-runs the pinned converter and compares.
- Raw HTML is stored by SHA-256; `GET /v2/receipts/{id}` returns the receipt.
- SSRF guard: block private, loopback and link-local addresses after DNS resolution and on every redirect; response size cap; per-scrape wall-clock limit; API keys stored hashed.
- Engine picker: priorities `actions 20, waitFor 1, screenshot 10, pdf 100, document 100, location 10, mobile 10, skipTlsVerification 10, stealthProxy 20, disableAdblock 10`; threshold `floor(sum/2)`; drop quality <= 0 engines when a positive one qualifies; sort by support score then quality.
- Only verdict `ok` (or `uncertain` when not strict) is success; failures are `{success:false, code, error, trust}`.
- Unsupported options are accepted and reported in `warning`.
- Formats now: `markdown`, `html`, `rawHtml`, `links`, `screenshot`. Actions: `wait, click, write, press, scroll, screenshot, scrape, executeJavascript, pdf` (v2 shapes).
- Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (second `-m`).
- Run tests with `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl` so Postgres suites are not skipped (`pnpm db:up` must be running). Browser suites additionally need Chromium installed (Task 7, step 3).

## Deviations and decisions for phase 2

- **Browser first by default**, matching Firecrawl's self-host ordering (playwright quality 20 vs fetch 5). `ICECRAWL_PREFER_BROWSER=false` flips it (quality 4). If Chromium is missing or fails to launch, the waterfall falls back to `fetch`.
- **Screenshots are PNG data URIs** in the response (`data:image/png;base64,...`), not hosted URLs. A `quality` value is accepted but ignored with a warning. The PNG is also stored by hash and exposed at `GET /v2/receipts/{id}/screenshot`.
- **Action outputs** (action screenshots, PDFs, scrape snapshots, JS return values) are returned inline and are not covered by the receipt hashes.
- **Receipt stays `version: 1`**; new fields (`contentType`, `screenshotSha256`, extra `options`) are optional/additive. Phase-1 receipts still validate; `verify` reports checks it cannot do as `skipped`.
- **Browser receipts hash the rendered DOM** (`page.content()` as UTF-8), not network bytes. The snapshot is exactly those bytes.
- **Waterfall is still sequential** (overlapped racing is deferred).
- **Residual browser SSRF risk**: attribution of blocked requests to a scrape is best-effort (shortcut noted in code). The proxy enforces blocking at connect time, so rebinding cannot bypass it, but recommend running the browser in an egress-restricted container.
- `location`, stealth/proxy selection, and captcha handling stay out of scope (phase 7).

## File Structure

```
packages/
  core/     src/{errors,trust,scrape}.ts (modified)           test/{scrape}.test.ts (modified)
  trust/    src/{receipt}.ts (modified)  src/{sign,verify}.ts (new)   src/index.ts
            test/{receipt}.test.ts (modified)  test/{sign,verify}.test.ts (new)
  engines/  src/{types}.ts (modified)  src/{egress-proxy,playwright}.ts (new)   src/index.ts
            test/{fetch}.test.ts (modified)  test/{egress-proxy,playwright}.test.ts (new)
  scraper/  src/{pipeline}.ts (modified)  src/{render,replay}.ts (new)   src/index.ts
            test/{flags,pipeline}.test.ts (modified)  test/replay.test.ts (new)
  api/      src/{app,response,config,server}.ts (modified)  src/signing.ts (new)
            src/store/{types,memory,pg}.ts (modified)  src/cli/signing.ts (new)
            migrations/002_signing_keys.sql (new)
            test/{helpers,app.test,store.contract,store.pg.test}.ts (modified)
            test/{signing,e2e.browser}.test.ts (new)
  cli/      package.json  src/{verify-cmd,bin}.ts  test/verify-cmd.test.ts   (all new)
Dockerfile, docker-compose.yml, .env.example, README.md (modified)
```

---

### Task 1: `core`: actions, screenshot format, `ACTION_FAILED`, receipt and signature types

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/trust.ts`, `packages/core/src/scrape.ts`
- Modify (tests): `packages/core/test/scrape.test.ts`, `packages/scraper/test/flags.test.ts`, `packages/api/test/app.test.ts`

**Interfaces:**
- Produces: `ERROR_STATUS.ACTION_FAILED` (422); `actionSchema`, `type Action` (parsed, defaults applied); `interface ScreenshotOptions { fullPage: boolean; quality?: number; viewport?: { width: number; height: number } }`; `SUPPORTED_FORMATS` now includes `'screenshot'`; `NormalizedScrape.screenshot: ScreenshotOptions | null`; `ScrapeRequest.actions: Action[] | undefined`.
- Produces (types in `trust.ts`): `ReceiptOptions`, `Receipt` with optional `contentType`, `screenshotSha256`; `ReceiptSignature { alg: 'Ed25519'; keyId: string; sig: string }`; `PublicKeyEntry { keyId; alg: 'Ed25519'; publicKey: string /* base64 SPKI DER */; createdAt: string; retiredAt: string | null }`; `SignedReceipt { receipt: Receipt; signature: ReceiptSignature | null }`.

- [ ] **Step 1: Write the failing tests (and fix the three existing tests that used `screenshot` as the "unsupported" example)**

Append to `packages/core/test/scrape.test.ts`, inside the existing `describe('normalizeScrapeRequest', ...)` block just before its final `});`:
```ts
  it('accepts the screenshot format as a string with defaults', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', formats: ['markdown', 'screenshot'] });
    expect(n.formats).toEqual(['markdown', 'screenshot']);
    expect(n.screenshot).toEqual({ fullPage: false, quality: undefined, viewport: undefined });
  });

  it('parses screenshot format options and warns that quality is ignored', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      formats: [{ type: 'screenshot', fullPage: true, quality: 80, viewport: { width: 800, height: 600 } }],
    });
    expect(n.screenshot).toEqual({ fullPage: true, quality: 80, viewport: { width: 800, height: 600 } });
    expect(n.warnings.join(' ')).toContain('quality');
  });

  it('returns null screenshot options when no screenshot was requested', () => {
    expect(normalizeScrapeRequest({ url: 'https://example.com' }).screenshot).toBeNull();
  });

  it('rejects bad screenshot options', () => {
    for (const bad of [{ type: 'screenshot', quality: 0 }, { type: 'screenshot', viewport: { width: 10, height: 600 } }]) {
      expect(() => normalizeScrapeRequest({ url: 'https://example.com', formats: [bad] })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' }),
      );
    }
  });

  it('parses every action type and applies defaults', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      actions: [
        { type: 'wait', milliseconds: 100 },
        { type: 'wait', selector: '#a' },
        { type: 'click', selector: '#b' },
        { type: 'write', text: 'hi' },
        { type: 'press', key: 'Enter' },
        { type: 'scroll' },
        { type: 'screenshot' },
        { type: 'scrape' },
        { type: 'executeJavascript', script: '1+1' },
        { type: 'pdf' },
      ],
    });
    const a = n.request.actions!;
    expect(a).toHaveLength(10);
    expect(a[2]).toEqual({ type: 'click', selector: '#b', all: false });
    expect(a[5]).toEqual({ type: 'scroll', direction: 'down' });
    expect(a[6]).toEqual({ type: 'screenshot', fullPage: false });
    expect(a[9]).toEqual({ type: 'pdf', format: 'Letter', landscape: false, scale: 1 });
  });

  it('rejects malformed actions', () => {
    const bad: unknown[] = [
      { type: 'wait' },
      { type: 'wait', milliseconds: 5, selector: '#a' },
      { type: 'click' },
      { type: 'teleport' },
    ];
    for (const action of bad) {
      expect(() => normalizeScrapeRequest({ url: 'https://example.com', actions: [action] })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' }),
      );
    }
    const many = Array.from({ length: 51 }, () => ({ type: 'scrape' }));
    expect(() => normalizeScrapeRequest({ url: 'https://example.com', actions: many })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
```

Then edit three existing tests in the same file (screenshot is now supported, so use `json` as the unsupported example):
- In `warns about unsupported formats but keeps supported ones`: change `formats: ['markdown', 'screenshot']` to `formats: ['markdown', 'json']` and `toContain('screenshot')` to `toContain('json')`.
- In `rejects a request whose formats are all unsupported`: change `formats: ['screenshot']` to `formats: ['json']`.

In `packages/scraper/test/flags.test.ts` change `actions: [{ type: 'wait' }]` to `actions: [{ type: 'wait', milliseconds: 100 }]`.

In `packages/api/test/app.test.ts`, in the test `adds a warning for unsupported formats and ignored options`, change `formats: ['markdown', 'screenshot']` to `formats: ['markdown', 'json']` and `toContain('screenshot')` to `toContain('json')`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core`
Expected: FAIL (the new tests; `n.screenshot` undefined, actions not typed, `wait` without args accepted).

- [ ] **Step 3: Implement**

In `packages/core/src/errors.ts` insert `  ACTION_FAILED: 422,` on the line after `  NO_ENGINE: 422,`.

In `packages/core/src/trust.ts`, replace

```ts
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}
```
with
```ts
  converter: { name: string; version: string };
  contentType?: string | null;
  screenshotSha256?: string | null;
  options: ReceiptOptions;
}
```
and add the following immediately above `export interface Receipt {`:
```ts
export interface ReceiptOptions {
  onlyMainContent: boolean;
  skipTlsVerification: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images?: boolean;
}

```
Then append at the end of the file:
```ts

export interface ReceiptSignature {
  alg: 'Ed25519';
  keyId: string;
  /** base64 Ed25519 signature over the RFC 8785 canonical JSON of the receipt */
  sig: string;
}

export interface PublicKeyEntry {
  keyId: string;
  alg: 'Ed25519';
  /** base64 of the SPKI DER encoding */
  publicKey: string;
  createdAt: string;
  retiredAt: string | null;
}

export interface SignedReceipt {
  receipt: Receipt;
  signature: ReceiptSignature | null;
}
```

Replace the whole of `packages/core/src/scrape.ts` with:
```ts
import { z } from 'zod';
import { IceCrawlError } from './errors';

export const SUPPORTED_FORMATS = ['markdown', 'html', 'rawHtml', 'links', 'screenshot'] as const;
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

export interface NormalizedScrape {
  request: ScrapeRequest;
  formats: SupportedFormat[];
  screenshot: ScreenshotOptions | null;
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
  for (const f of request.formats) {
    const type = typeof f === 'string' ? f : f.type;
    if (type === 'screenshot') {
      const s = screenshotFormatSchema.safeParse(typeof f === 'string' ? { type: 'screenshot' } : f);
      if (!s.success) throw new IceCrawlError('VALIDATION', `formats.screenshot: ${describeIssues(s.error)}`);
      screenshot = { fullPage: s.data.fullPage, quality: s.data.quality, viewport: s.data.viewport };
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

  return { request, formats, screenshot, warnings };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test && pnpm typecheck`
Expected: every existing suite and the new core tests PASS (Postgres suites skip without `DATABASE_URL`); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): actions, screenshot format, ACTION_FAILED and signature types" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Plumb browser inputs and outputs through `trust`, `engines` types and the pipeline

**Files:**
- Modify: `packages/trust/src/receipt.ts`, `packages/engines/src/types.ts`, `packages/scraper/src/pipeline.ts`
- Modify (tests): `packages/trust/test/receipt.test.ts`, `packages/engines/test/fetch.test.ts`, `packages/scraper/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `Action`, `ScreenshotOptions`, `ReceiptOptions` (Task 1).
- Produces:
  - `EngineContext` gains `waitFor: number; mobile: boolean; actions: Action[]; screenshot: ScreenshotOptions | null`.
  - `interface ActionOutputs { screenshots: Uint8Array[]; scrapes: { url: string; html: string }[]; javascriptReturns: { type: string; value: unknown }[]; pdfs: Uint8Array[] }`; `EngineResult` gains `screenshot?: Uint8Array; actions?: ActionOutputs`.
  - `ReceiptInput` gains `contentType: string | null; screenshot: Uint8Array | null; options: ReceiptOptions`; `buildReceipt` sets `contentType` and `screenshotSha256`.
  - `ScrapeRun` gains `screenshot: Uint8Array | null; actions: ActionOutputs | null`; the receipt records `includeTags`, `excludeTags`, `removeBase64Images`; `ACTION_FAILED` is a fatal pipeline error (no waterfall).

- [ ] **Step 1: Write the failing tests**

In `packages/trust/test/receipt.test.ts`, replace

```ts
  converter: { name: 'icecrawl-convert', version: '1' },
  options: { onlyMainContent: true, skipTlsVerification: true },
};
```
with
```ts
  converter: { name: 'icecrawl-convert', version: '1' },
  contentType: 'text/html; charset=utf-8',
  screenshot: null,
  options: { onlyMainContent: true, skipTlsVerification: true, removeBase64Images: true },
};
```
and add this test inside `describe('buildReceipt', ...)` before its closing `});`:
```ts
  it('hashes the screenshot and records the content type', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const r = buildReceipt({ ...base, screenshot: png });
    expect(r.screenshotSha256).toBe(sha256Hex(png));
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.options.removeBase64Images).toBe(true);
    expect(buildReceipt(base).screenshotSha256).toBeNull();
  });
```

In `packages/engines/test/fetch.test.ts`, in the `ctx` helper replace

```ts
  allowPrivateNetworks: true,
  maxBytes: 100_000,
  ...over,
});
```
with
```ts
  allowPrivateNetworks: true,
  maxBytes: 100_000,
  waitFor: 0,
  mobile: false,
  actions: [],
  screenshot: null,
  ...over,
});
```

Append to the end of `packages/scraper/test/pipeline.test.ts`:
```ts
import type { EngineContext } from '@icecrawl/engines';

describe('runScrape with browser features', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

  function browserEngine(seen: EngineContext[], over: Partial<EngineResult> = {}): Engine {
    return {
      name: 'browser',
      quality: 20,
      features: featureSet(['skipTlsVerification', 'waitFor', 'actions', 'screenshot', 'screenshot@fullScreen', 'mobile']),
      maxReasonableTimeMs: 1000,
      scrape: async (ctx) => {
        seen.push(ctx);
        return {
          ...reply(okHtml),
          screenshot: PNG,
          actions: {
            screenshots: [PNG],
            scrapes: [{ url: 'https://example.com/final', html: '<p>x</p>' }],
            javascriptReturns: [{ type: 'number', value: 42 }],
            pdfs: [],
          },
          ...over,
        };
      },
    };
  }

  it('passes waitFor, mobile, actions and screenshot options to the engine', async () => {
    const seen: EngineContext[] = [];
    await run([browserEngine(seen)], {
      waitFor: 250,
      mobile: true,
      actions: [{ type: 'click', selector: '#go' }],
      formats: ['markdown', { type: 'screenshot', fullPage: true }],
    });
    expect(seen[0]).toMatchObject({
      waitFor: 250,
      mobile: true,
      actions: [{ type: 'click', selector: '#go', all: false }],
      screenshot: { fullPage: true },
    });
  });

  it('passes safe defaults when no browser features are requested', async () => {
    const seen: EngineContext[] = [];
    await run([browserEngine(seen)]);
    expect(seen[0]).toMatchObject({ waitFor: 0, mobile: false, actions: [], screenshot: null });
  });

  it('returns the screenshot and action outputs and hashes the screenshot into the receipt', async () => {
    const r = await run([browserEngine([])], { formats: ['markdown', 'screenshot'] });
    expect(r.screenshot).toEqual(PNG);
    expect(r.actions?.javascriptReturns).toEqual([{ type: 'number', value: 42 }]);
    expect(r.receipt.screenshotSha256).toBe(sha256Hex(PNG));
    expect(r.receipt.contentType).toContain('text/html');
  });

  it('records the conversion options in the receipt so the conversion can be replayed', async () => {
    const r = await run([browserEngine([])], { includeTags: ['article'], excludeTags: ['nav'], removeBase64Images: false });
    expect(r.receipt.options).toEqual({
      onlyMainContent: true,
      skipTlsVerification: true,
      includeTags: ['article'],
      excludeTags: ['nav'],
      removeBase64Images: false,
    });
  });

  it('warns when screenshot quality is requested', async () => {
    const r = await run([browserEngine([])], { formats: [{ type: 'screenshot', quality: 50 }] });
    expect(r.warnings.join(' ')).toContain('quality');
  });

  it('treats ACTION_FAILED as fatal (no waterfall)', async () => {
    const calls: string[] = [];
    const failing = { ...browserEngine([]), scrape: async () => { calls.push('browser'); throw new IceCrawlError('ACTION_FAILED', 'click failed'); } };
    await expect(run([failing, engine('fallback', 5, reply(okHtml), calls)], { actions: [{ type: 'click', selector: '#x' }] })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
    });
    expect(calls).toEqual(['browser']);
  });

  it('reports an unsupported screenshot as a warning when the engine cannot take one', async () => {
    const r = await run([engine('a', 10, reply(okHtml))], { formats: ['markdown', 'screenshot'] });
    expect(r.screenshot).toBeNull();
    expect(r.warnings.join(' ')).toContain('screenshot');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/trust packages/scraper/test/pipeline.test.ts`
Expected: FAIL (new receipt fields missing, engine context lacks new keys, `run.screenshot` undefined).

- [ ] **Step 3: Implement**

Replace `packages/engines/src/types.ts` with:
```ts
import type { Action, ScreenshotOptions } from '@icecrawl/core';
import type { FeatureFlag } from './flags';

export interface EngineContext {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  skipTlsVerification: boolean;
  allowPrivateNetworks: boolean;
  maxBytes: number;
  waitFor: number;
  mobile: boolean;
  actions: Action[];
  screenshot: ScreenshotOptions | null;
}

export interface ActionOutputs {
  screenshots: Uint8Array[];
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
  pdfs: Uint8Array[];
}

export interface EngineResult {
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
  truncated: boolean;
  screenshot?: Uint8Array;
  actions?: ActionOutputs;
}

export interface Engine {
  name: string;
  quality: number;
  features: Record<FeatureFlag, boolean>;
  maxReasonableTimeMs: number;
  scrape(ctx: EngineContext): Promise<EngineResult>;
}
```

In `packages/trust/src/receipt.ts` change the import to `import type { EngineAttempt, Receipt, ReceiptOptions } from '@icecrawl/core';`, replace the `ReceiptInput` interface's last two lines

```ts
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}
```
with
```ts
  converter: { name: string; version: string };
  contentType: string | null;
  screenshot: Uint8Array | null;
  options: ReceiptOptions;
}
```
and in `buildReceipt` replace the two lines `    converter: i.converter,\n    options: i.options,` with
```ts
    converter: i.converter,
    contentType: i.contentType,
    screenshotSha256: i.screenshot ? sha256Hex(i.screenshot) : null,
    options: i.options,
```

In `packages/scraper/src/pipeline.ts` make these edits:
1. Change `import { pickEngines, type Engine, type EngineResult } from '@icecrawl/engines';` to `import { pickEngines, type ActionOutputs, type Engine, type EngineResult } from '@icecrawl/engines';`
2. In `ScrapeRun`, replace
```ts
  receipt: Receipt;
  snapshot: { bytes: Uint8Array; sha256: string };
  warnings: string[];
}
```
with
```ts
  receipt: Receipt;
  snapshot: { bytes: Uint8Array; sha256: string };
  screenshot: Uint8Array | null;
  actions: ActionOutputs | null;
  warnings: string[];
}
```
3. In `FATAL`, replace `  'RESPONSE_TOO_LARGE',\n]);` with `  'RESPONSE_TOO_LARGE',\n  'ACTION_FAILED',\n]);`
4. Replace `const ignored = [...picks[0].unsupported].filter((f) => !f.startsWith('screenshot'));` with `const ignored = [...picks[0].unsupported];`
5. In the engine call replace
```ts
        maxBytes: deps.config.maxResponseBytes,
      });
```
with
```ts
        maxBytes: deps.config.maxResponseBytes,
        waitFor: request.waitFor,
        mobile: request.mobile,
        actions: request.actions ?? [],
        screenshot: n.screenshot,
      });
```
6. In the `buildReceipt({...})` call replace
```ts
    converter: CONVERTER,
    options: { onlyMainContent: request.onlyMainContent, skipTlsVerification: request.skipTlsVerification },
  });
```
with
```ts
    converter: CONVERTER,
    contentType: last.result.contentType,
    screenshot: last.result.screenshot ?? null,
    options: {
      onlyMainContent: request.onlyMainContent,
      skipTlsVerification: request.skipTlsVerification,
      includeTags: request.includeTags,
      excludeTags: request.excludeTags,
      removeBase64Images: request.removeBase64Images,
    },
  });
```
7. In the returned object replace
```ts
    receipt,
    snapshot: { bytes: last.result.body, sha256: sha256Hex(last.result.body) },
    warnings,
  };
```
with
```ts
    receipt,
    snapshot: { bytes: last.result.body, sha256: sha256Hex(last.result.body) },
    screenshot: last.result.screenshot ?? null,
    actions: last.result.actions ?? null,
    warnings,
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test && pnpm typecheck`
Expected: all suites PASS (the pre-existing "warns when the chosen engine ignores a soft option" test still passes); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plumb browser inputs, screenshot and action outputs through engines, pipeline and receipts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `trust`: canonical JSON and Ed25519 signing

**Files:**
- Create: `packages/trust/src/sign.ts`
- Modify: `packages/trust/src/index.ts`
- Test: `packages/trust/test/sign.test.ts`

**Interfaces:**
- Consumes: `Receipt`, `ReceiptSignature`, `PublicKeyEntry` (Task 1).
- Produces:
  - `canonicalJson(value: unknown): string` (RFC 8785 for the JSON subset used by receipts; throws on non-finite numbers, functions, symbols).
  - `interface PrivateSigningKey { keyId: string; privateKeyPem: string }`
  - `generateSigningKey(now?: Date): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry }`
  - `signingKeyFromPem(pem: string, now?: Date): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry }` (derives the same key ID and public entry from a stored PEM)
  - `signReceipt(receipt: Receipt, key: PrivateSigningKey): ReceiptSignature`
  - `verifySignature(receipt: Receipt, signature: ReceiptSignature, publicKeyBase64Der: string): boolean`

- [ ] **Step 1: Write the failing test**

`packages/trust/test/sign.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
import { canonicalJson, generateSigningKey, signReceipt, signingKeyFromPem, verifySignature } from '../src';

const receipt: Receipt = {
  version: 1,
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  statusCode: 200,
  fetchedAt: '2026-10-24T10:00:00.000Z',
  engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.95, reasons: [], durationMs: 12 }],
  htmlSha256: 'a'.repeat(64),
  outputSha256: 'b'.repeat(64),
  converter: { name: 'icecrawl-convert', version: '1' },
  contentType: 'text/html',
  screenshotSha256: null,
  options: { onlyMainContent: true, skipTlsVerification: true },
};

describe('canonicalJson', () => {
  it('sorts object keys recursively and removes whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}],"b":1}');
  });

  it('ignores undefined object members like JSON.stringify but maps undefined array items to null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('serializes strings, numbers, booleans and null like ECMAScript', () => {
    expect(canonicalJson({ s: 'é"\n\u0001', n: 1e21, z: -0, t: true, f: false, x: null })).toBe(
      '{"f":false,"n":1e+21,"s":"é\\"\\n\\u0001","t":true,"x":null,"z":0}',
    );
  });

  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalJson({ 'é': 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
  });

  it('throws on values that cannot be represented', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it('is stable across a JSON round trip (as stored in Postgres jsonb)', () => {
    expect(canonicalJson(JSON.parse(JSON.stringify(receipt)))).toBe(canonicalJson(receipt));
  });
});

describe('signing', () => {
  it('derives a stable key id and produces an Ed25519 signature that verifies', () => {
    const { privateKey, publicKey } = generateSigningKey(new Date('2026-10-24T00:00:00.000Z'));
    expect(privateKey.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(publicKey).toMatchObject({ keyId: privateKey.keyId, alg: 'Ed25519', retiredAt: null, createdAt: '2026-10-24T00:00:00.000Z' });
    const sig = signReceipt(receipt, privateKey);
    expect(sig).toMatchObject({ alg: 'Ed25519', keyId: privateKey.keyId });
    expect(Buffer.from(sig.sig, 'base64')).toHaveLength(64);
    expect(verifySignature(receipt, sig, publicKey.publicKey)).toBe(true);
  });

  it('rejects any change to the receipt', () => {
    const { privateKey, publicKey } = generateSigningKey();
    const sig = signReceipt(receipt, privateKey);
    expect(verifySignature({ ...receipt, outputSha256: 'c'.repeat(64) }, sig, publicKey.publicKey)).toBe(false);
    expect(verifySignature({ ...receipt, finalUrl: 'https://evil.example/' }, sig, publicKey.publicKey)).toBe(false);
    expect(verifySignature({ ...receipt, engineChain: [] }, sig, publicKey.publicKey)).toBe(false);
  });

  it('rejects a signature from a different key and malformed input', () => {
    const a = generateSigningKey();
    const b = generateSigningKey();
    const sig = signReceipt(receipt, a.privateKey);
    expect(verifySignature(receipt, sig, b.publicKey.publicKey)).toBe(false);
    expect(verifySignature(receipt, { ...sig, sig: '!!!' }, a.publicKey.publicKey)).toBe(false);
    expect(verifySignature(receipt, sig, 'not-a-key')).toBe(false);
  });

  it('reloads the same key id and public key from a PEM', () => {
    const { privateKey, publicKey } = generateSigningKey();
    const again = signingKeyFromPem(privateKey.privateKeyPem);
    expect(again.privateKey.keyId).toBe(privateKey.keyId);
    expect(again.publicKey.publicKey).toBe(publicKey.publicKey);
    expect(verifySignature(receipt, signReceipt(receipt, again.privateKey), publicKey.publicKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/trust/test/sign.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`packages/trust/src/sign.ts`:
```ts
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { PublicKeyEntry, Receipt, ReceiptSignature } from '@icecrawl/core';

/**
 * RFC 8785 (JCS) for the JSON subset receipts use: objects, arrays, strings, finite numbers,
 * booleans and null. JSON.stringify already emits ECMAScript number and string forms, which JCS
 * mandates; keys are sorted by UTF-16 code units, which is the default string sort.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export interface PrivateSigningKey {
  keyId: string;
  privateKeyPem: string;
}

function keyIdOf(publicDer: Buffer): string {
  return `k_${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`;
}

export function signingKeyFromPem(
  pem: string,
  now: Date = new Date(),
): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry } {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
  const keyId = keyIdOf(der);
  return {
    privateKey: { keyId, privateKeyPem: pem },
    publicKey: { keyId, alg: 'Ed25519', publicKey: der.toString('base64'), createdAt: now.toISOString(), retiredAt: null },
  };
}

export function generateSigningKey(now: Date = new Date()): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signingKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now);
}

export function signReceipt(receipt: Receipt, key: PrivateSigningKey): ReceiptSignature {
  const sig = sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), createPrivateKey(key.privateKeyPem));
  return { alg: 'Ed25519', keyId: key.keyId, sig: sig.toString('base64') };
}

export function verifySignature(receipt: Receipt, signature: ReceiptSignature, publicKeyBase64Der: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64Der, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canonicalJson(receipt), 'utf8'), publicKey, Buffer.from(signature.sig, 'base64'));
  } catch {
    return false;
  }
}
```

`packages/trust/src/index.ts`:
```ts
export * from './classify';
export * from './receipt';
export * from './sign';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/trust && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(trust): RFC 8785 canonical JSON and Ed25519 receipt signing" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `api`: store signatures and public keys, migration, signing-key loader and rotation

**Files:**
- Create: `packages/api/migrations/002_signing_keys.sql`, `packages/api/src/signing.ts`, `packages/api/src/cli/signing.ts`
- Modify: `packages/api/src/store/types.ts`, `packages/api/src/store/memory.ts`, `packages/api/src/store/pg.ts`, `packages/api/package.json` (script)
- Modify (tests): `packages/api/test/store.contract.ts`, `packages/api/test/store.pg.test.ts`
- Test: `packages/api/test/signing.test.ts`

**Interfaces:**
- Consumes: `PublicKeyEntry`, `ReceiptSignature`, `SignedReceipt` (Task 1); `generateSigningKey`, `signingKeyFromPem`, `PrivateSigningKey` (Task 3).
- Produces:
  - `Store.saveScrape(rec, receipt, snapshot, signature?: ReceiptSignature | null)`; `Store.getSignedReceipt(id): Promise<SignedReceipt | null>`; `Store.registerPublicKey(e: PublicKeyEntry)`; `Store.listPublicKeys(): Promise<PublicKeyEntry[]>` (oldest first); `Store.retireKey(keyId: string)`.
  - `snapshotKey(sha256: string): string` exported from `store/types.ts` (`<first 2 hex>/<sha256>`).
  - `loadOrCreateSigningKey(file: string, store: Store): Promise<PrivateSigningKey>`; `rotateSigningKey(file: string, store: Store): Promise<{ oldKeyId: string | null; newKeyId: string }>`.

- [ ] **Step 1: Write the failing tests**

In `packages/api/test/store.contract.ts`, add these imports at the top: `import type { ReceiptSignature } from '@icecrawl/core';` and replace the final test

```ts
    it('returns null for unknown ids', async () => {
      expect(await store.getScrape(randomUUID())).toBeNull();
      expect(await store.getReceipt(randomUUID())).toBeNull();
    });
```
with
```ts
    it('returns null for unknown ids', async () => {
      expect(await store.getScrape(randomUUID())).toBeNull();
      expect(await store.getReceipt(randomUUID())).toBeNull();
      expect(await store.getSignedReceipt(randomUUID())).toBeNull();
    });

    it('stores and returns a receipt signature', async () => {
      const id = randomUUID();
      const signature: ReceiptSignature = { alg: 'Ed25519', keyId: 'k_0123456789abcdef', sig: 'c2lnbmF0dXJl' };
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null, signature);
      expect(await store.getSignedReceipt(id)).toEqual({ receipt: sampleReceipt(id), signature });
    });

    it('returns a null signature for unsigned receipts', async () => {
      const id = randomUUID();
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null);
      expect(await store.getSignedReceipt(id)).toEqual({ receipt: sampleReceipt(id), signature: null });
    });

    it('registers, lists and retires public keys', async () => {
      const a = { keyId: `k_${randomUUID().slice(0, 16)}`, alg: 'Ed25519' as const, publicKey: 'QQ==', createdAt: '2026-10-24T10:00:00.000Z', retiredAt: null };
      const b = { ...a, keyId: `k_${randomUUID().slice(0, 16)}`, createdAt: '2026-10-25T10:00:00.000Z' };
      await store.registerPublicKey(a);
      await store.registerPublicKey(b);
      await store.registerPublicKey(a); // idempotent
      const before = (await store.listPublicKeys()).filter((k) => k.keyId === a.keyId || k.keyId === b.keyId);
      expect(before.map((k) => k.keyId)).toEqual([a.keyId, b.keyId]);
      expect(before.every((k) => k.retiredAt === null)).toBe(true);
      await store.retireKey(a.keyId);
      const after = (await store.listPublicKeys()).find((k) => k.keyId === a.keyId);
      expect(after?.retiredAt).not.toBeNull();
    });
```

In `packages/api/test/store.pg.test.ts` change the truncate line to `await sql\`truncate receipts, snapshots, scrapes, api_keys, signing_keys cascade\`;`.

`packages/api/test/signing.test.ts`:
```ts
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey, rotateSigningKey } from '../src/signing';
import { MemoryStore } from '../src/store/memory';

describe('signing key management', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'icecrawl-sign-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('creates a key file on first use and registers its public key', async () => {
    const dir = await tmp();
    const file = join(dir, 'nested', 'signing-key.pem');
    const store = new MemoryStore();
    const key = await loadOrCreateSigningKey(file, store);
    expect(key.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(await readFile(file, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect((await store.listPublicKeys()).map((k) => k.keyId)).toEqual([key.keyId]);
  });

  it('reloads the same key without registering it twice', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const store = new MemoryStore();
    const a = await loadOrCreateSigningKey(file, store);
    const b = await loadOrCreateSigningKey(file, store);
    expect(b.keyId).toBe(a.keyId);
    expect(await store.listPublicKeys()).toHaveLength(1);
  });

  it('registers an existing key file that the store does not know yet', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const first = await loadOrCreateSigningKey(file, new MemoryStore());
    const freshStore = new MemoryStore();
    const again = await loadOrCreateSigningKey(file, freshStore);
    expect(again.keyId).toBe(first.keyId);
    expect(await freshStore.listPublicKeys()).toHaveLength(1);
  });

  it('rotates: keeps the old private key as a backup, retires it, and registers the new one', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const store = new MemoryStore();
    const old = await loadOrCreateSigningKey(file, store);
    const result = await rotateSigningKey(file, store);
    expect(result.oldKeyId).toBe(old.keyId);
    expect(result.newKeyId).not.toBe(old.keyId);
    const keys = await store.listPublicKeys();
    expect(keys.map((k) => k.keyId)).toEqual([old.keyId, result.newKeyId]);
    expect(keys[0].retiredAt).not.toBeNull();
    expect(keys[1].retiredAt).toBeNull();
    expect((await readdir(dir)).some((f) => f.includes(old.keyId))).toBe(true);
    expect((await loadOrCreateSigningKey(file, store)).keyId).toBe(result.newKeyId);
  });

  it('rotate works when no key exists yet', async () => {
    const dir = await tmp();
    const result = await rotateSigningKey(join(dir, 'signing-key.pem'), new MemoryStore());
    expect(result.oldKeyId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api`
Expected: FAIL (store methods and `../src/signing` missing).

- [ ] **Step 3: Implement store changes**

Replace `packages/api/src/store/types.ts` with:
```ts
import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict } from '@icecrawl/core';

export interface ApiKeyRow {
  id: string;
  name: string;
  revoked: boolean;
}

export interface ScrapeRecord {
  id: string;
  apiKeyId: string | null;
  url: string;
  finalUrl: string;
  verdict: Verdict;
  confidence: number;
  engine: string | null;
  statusCode: number | null;
  markdown: string | null;
  metadata: Record<string, unknown>;
  response: Record<string, unknown>;
  createdAt: string;
}

export interface SnapshotMeta {
  sha256: string;
  key: string;
  bytes: number;
}

export const snapshotKey = (sha256: string): string => `${sha256.slice(0, 2)}/${sha256}`;

export interface Store {
  findApiKeyByHash(hash: string): Promise<ApiKeyRow | null>;
  createApiKey(k: { id: string; hash: string; name: string }): Promise<void>;
  revokeApiKey(id: string): Promise<void>;
  saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    snapshot: SnapshotMeta | null,
    signature?: ReceiptSignature | null,
  ): Promise<void>;
  getScrape(id: string): Promise<ScrapeRecord | null>;
  getReceipt(id: string): Promise<Receipt | null>;
  getSignedReceipt(id: string): Promise<SignedReceipt | null>;
  registerPublicKey(entry: PublicKeyEntry): Promise<void>;
  listPublicKeys(): Promise<PublicKeyEntry[]>;
  retireKey(keyId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  put(bytes: Uint8Array): Promise<SnapshotMeta>;
  get(key: string): Promise<Uint8Array | null>;
}
```

Replace `packages/api/src/store/memory.ts` with:
```ts
import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { sha256Hex } from '@icecrawl/trust';
import { snapshotKey, type ApiKeyRow, type ScrapeRecord, type SnapshotMeta, type SnapshotStore, type Store } from './types';

export class MemoryStore implements Store {
  private keys = new Map<string, { id: string; name: string; revoked: boolean }>();
  private scrapes = new Map<string, ScrapeRecord>();
  private receipts = new Map<string, { receipt: Receipt; signature: ReceiptSignature | null }>();
  private publicKeys: PublicKeyEntry[] = [];

  async findApiKeyByHash(hash: string): Promise<ApiKeyRow | null> {
    const k = this.keys.get(hash);
    return k ? { ...k } : null;
  }
  async createApiKey(k: { id: string; hash: string; name: string }): Promise<void> {
    this.keys.set(k.hash, { id: k.id, name: k.name, revoked: false });
  }
  async revokeApiKey(id: string): Promise<void> {
    for (const k of this.keys.values()) if (k.id === id) k.revoked = true;
  }
  async saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    _snapshot: SnapshotMeta | null,
    signature: ReceiptSignature | null = null,
  ): Promise<void> {
    this.scrapes.set(rec.id, structuredClone(rec));
    this.receipts.set(rec.id, structuredClone({ receipt, signature }));
  }
  async getScrape(id: string): Promise<ScrapeRecord | null> {
    const r = this.scrapes.get(id);
    return r ? structuredClone(r) : null;
  }
  async getReceipt(id: string): Promise<Receipt | null> {
    return (await this.getSignedReceipt(id))?.receipt ?? null;
  }
  async getSignedReceipt(id: string): Promise<SignedReceipt | null> {
    const r = this.receipts.get(id);
    return r ? structuredClone(r) : null;
  }
  async registerPublicKey(entry: PublicKeyEntry): Promise<void> {
    if (!this.publicKeys.some((k) => k.keyId === entry.keyId)) this.publicKeys.push({ ...entry });
  }
  async listPublicKeys(): Promise<PublicKeyEntry[]> {
    return this.publicKeys.map((k) => ({ ...k })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async retireKey(keyId: string): Promise<void> {
    const k = this.publicKeys.find((x) => x.keyId === keyId);
    if (k && k.retiredAt === null) k.retiredAt = new Date().toISOString();
  }
  async close(): Promise<void> {}
}

export class MemorySnapshotStore implements SnapshotStore {
  private blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<SnapshotMeta> {
    const sha256 = sha256Hex(bytes);
    const key = snapshotKey(sha256);
    this.blobs.set(key, bytes);
    return { sha256, key, bytes: bytes.length };
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key) ?? null;
  }
}
```

Replace `packages/api/src/store/pg.ts` with:
```ts
import postgres from 'postgres';
import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict } from '@icecrawl/core';
import type { ApiKeyRow, ScrapeRecord, SnapshotMeta, Store } from './types';

export function createSql(url: string): postgres.Sql {
  return postgres(url, { onnotice: () => {}, max: 10 });
}

export class PgStore implements Store {
  constructor(private readonly sql: postgres.Sql) {}

  async findApiKeyByHash(hash: string): Promise<ApiKeyRow | null> {
    const [r] = await this.sql`select id, name, revoked_at from api_keys where hash = ${hash}`;
    return r ? { id: r.id, name: r.name, revoked: r.revoked_at !== null } : null;
  }

  async createApiKey(k: { id: string; hash: string; name: string }): Promise<void> {
    await this.sql`insert into api_keys (id, hash, name) values (${k.id}, ${k.hash}, ${k.name})`;
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.sql`update api_keys set revoked_at = now() where id = ${id}`;
  }

  async saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    snapshot: SnapshotMeta | null,
    signature: ReceiptSignature | null = null,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into scrapes (id, api_key_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata, response, created_at)
        values (${rec.id}, ${rec.apiKeyId}, ${rec.url}, ${rec.finalUrl}, ${rec.verdict}, ${rec.confidence}, ${rec.engine},
                ${rec.statusCode}, ${rec.markdown}, ${tx.json(rec.metadata as never)}, ${tx.json(rec.response as never)}, ${rec.createdAt})`;
      if (snapshot) {
        await tx`insert into snapshots (scrape_id, html_sha256, storage_key, bytes)
                 values (${rec.id}, ${snapshot.sha256}, ${snapshot.key}, ${snapshot.bytes})`;
      }
      await tx`insert into receipts (id, body, signature, key_id)
               values (${rec.id}, ${tx.json(receipt as never)}, ${signature?.sig ?? null}, ${signature?.keyId ?? null})`;
    });
  }

  async getScrape(id: string): Promise<ScrapeRecord | null> {
    const [r] = await this.sql`select * from scrapes where id = ${id}`;
    if (!r) return null;
    return {
      id: r.id,
      apiKeyId: r.api_key_id,
      url: r.url,
      finalUrl: r.final_url,
      verdict: r.verdict as Verdict,
      confidence: r.confidence,
      engine: r.engine,
      statusCode: r.status_code,
      markdown: r.markdown,
      metadata: r.metadata,
      response: r.response,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async getReceipt(id: string): Promise<Receipt | null> {
    return (await this.getSignedReceipt(id))?.receipt ?? null;
  }

  async getSignedReceipt(id: string): Promise<SignedReceipt | null> {
    const [r] = await this.sql`select body, signature, key_id from receipts where id = ${id}`;
    if (!r) return null;
    return {
      receipt: r.body as Receipt,
      signature: r.signature && r.key_id ? { alg: 'Ed25519', keyId: r.key_id, sig: r.signature } : null,
    };
  }

  async registerPublicKey(e: PublicKeyEntry): Promise<void> {
    await this.sql`
      insert into signing_keys (key_id, public_key, created_at, retired_at)
      values (${e.keyId}, ${e.publicKey}, ${e.createdAt}, ${e.retiredAt})
      on conflict (key_id) do nothing`;
  }

  async listPublicKeys(): Promise<PublicKeyEntry[]> {
    const rows = await this.sql`select key_id, public_key, created_at, retired_at from signing_keys order by created_at, key_id`;
    return rows.map((r) => ({
      keyId: r.key_id,
      alg: 'Ed25519' as const,
      publicKey: r.public_key,
      createdAt: new Date(r.created_at).toISOString(),
      retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : null,
    }));
  }

  async retireKey(keyId: string): Promise<void> {
    await this.sql`update signing_keys set retired_at = now() where key_id = ${keyId} and retired_at is null`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
```

`packages/api/migrations/002_signing_keys.sql`:
```sql
create table signing_keys (
  key_id text primary key,
  public_key text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
```

- [ ] **Step 4: Implement the key loader and rotation CLI**

`packages/api/src/signing.ts`:
```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateSigningKey, signingKeyFromPem, type PrivateSigningKey } from '@icecrawl/trust';
import type { Store } from './store/types';

async function readPem(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function register(store: Store, pem: string): Promise<PrivateSigningKey> {
  const { privateKey, publicKey } = signingKeyFromPem(pem);
  await store.registerPublicKey(publicKey);
  return privateKey;
}

export async function loadOrCreateSigningKey(file: string, store: Store): Promise<PrivateSigningKey> {
  let pem = await readPem(file);
  if (pem === null) {
    pem = generateSigningKey().privateKey.privateKeyPem;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pem, { mode: 0o600, flag: 'wx' });
  }
  return register(store, pem);
}

export async function rotateSigningKey(
  file: string,
  store: Store,
): Promise<{ oldKeyId: string | null; newKeyId: string }> {
  const oldPem = await readPem(file);
  let oldKeyId: string | null = null;
  if (oldPem !== null) {
    oldKeyId = signingKeyFromPem(oldPem).privateKey.keyId;
    await rename(file, `${file}.${oldKeyId}.bak`);
  }
  const fresh = generateSigningKey();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, fresh.privateKey.privateKeyPem, { mode: 0o600, flag: 'wx' });
  await store.registerPublicKey(fresh.publicKey);
  if (oldKeyId !== null) await store.retireKey(oldKeyId);
  return { oldKeyId, newKeyId: fresh.privateKey.keyId };
}
```

`packages/api/src/cli/signing.ts`:
```ts
import { loadConfig } from '../config';
import { rotateSigningKey } from '../signing';
import { migrate } from '../store/migrate';
import { PgStore, createSql } from '../store/pg';

const [command] = process.argv.slice(2);
const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);

try {
  if (command === 'rotate') {
    const { oldKeyId, newKeyId } = await rotateSigningKey(config.signingKeyFile, new PgStore(sql));
    console.log(`New signing key ${newKeyId}${oldKeyId ? ` (retired ${oldKeyId}; its private key was kept as a .bak file)` : ''}`);
  } else {
    console.error('Usage: signing rotate');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
```
In `packages/api/package.json` add to `scripts`: `"signing:rotate": "tsx src/cli/signing.ts rotate"`.

In `packages/api/src/config.ts` add `signingKeyFile: string;` to the `AppConfig` interface and `signingKeyFile: env.ICECRAWL_SIGNING_KEY_FILE ?? './data/signing-key.pem',` to the returned object (Task 9 adds the rest of the new settings).

- [ ] **Step 5: Run to verify pass**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test && pnpm typecheck`
Expected: all suites PASS including the Postgres contract (the new `002` migration is applied automatically by the contract's `migrate(sql)`); none skipped.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): persist receipt signatures and public keys, signing key loader and rotation" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `api`: screenshot and action outputs, signing on save, receipt/snapshot/screenshot/keys endpoints

**Files:**
- Modify: `packages/api/src/response.ts`, `packages/api/src/app.ts`
- Modify (tests): `packages/api/test/helpers.ts`, `packages/api/test/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `AppDeps.signer?: PrivateSigningKey` (when set, every saved scrape, including failures, gets a signature).
  - `buildResponse` adds `data.screenshot` (PNG data URI) when `screenshot` is in `formats` and one was produced (otherwise a warning), and `data.actions` `{ screenshots (data URIs), scrapes, javascriptReturns, pdfs (base64) }` whenever the engine returned action outputs.
  - Routes: `GET /v2/receipts/:id` now returns `{ success: true, data: receipt, signature }`; new `GET /v2/receipts/:id/snapshot` (raw bytes, `content-type` from the receipt) and `GET /v2/receipts/:id/screenshot` (`image/png`); new unauthenticated `GET /.well-known/icecrawl-keys.json` returning `{ keys: PublicKeyEntry[] }`. All receipt routes keep the ownership check (other keys get 404).

- [ ] **Step 1: Write the failing tests**

In `packages/api/test/helpers.ts` replace the `makeApp` signature and `buildApp` call so a signer can be passed. Replace

```ts
export async function makeApp(opts: { engine?: Engine; useAuth?: boolean; strict?: boolean } = {}) {
```
with
```ts
export async function makeApp(
  opts: { engine?: Engine; useAuth?: boolean; strict?: boolean; signer?: PrivateSigningKey } = {},
) {
```
and replace `    useAuth: opts.useAuth ?? true,\n  });` with `    useAuth: opts.useAuth ?? true,\n    signer: opts.signer,\n  });`. Change the trust import line to `import { sha256Hex, type PrivateSigningKey } from '@icecrawl/trust';`.

Append to `packages/api/test/app.test.ts`:
```ts
import { featureSet, type Engine } from '@icecrawl/engines';
import { generateSigningKey, verifySignature } from '@icecrawl/trust';
import { snapshotKey } from '../src/store/types';

const PNG = Buffer.from('89504e470d0a1a0a0000deadbeef', 'hex');

function browserEngine(): Engine {
  return {
    name: 'browser',
    quality: 20,
    features: featureSet(['skipTlsVerification', 'waitFor', 'actions', 'screenshot', 'screenshot@fullScreen', 'mobile']),
    maxReasonableTimeMs: 1000,
    scrape: async () => ({
      finalUrl: 'https://example.com/final',
      statusCode: 200,
      headers: {},
      body: Buffer.from(okHtml),
      contentType: 'text/html; charset=utf-8',
      truncated: false,
      screenshot: PNG,
      actions: {
        screenshots: [PNG],
        scrapes: [{ url: 'https://example.com/final', html: '<p>x</p>' }],
        javascriptReturns: [{ type: 'number', value: 42 }],
        pdfs: [Buffer.from('%PDF-1.4')],
      },
    }),
  };
}

describe('screenshots and actions', () => {
  it('returns the screenshot as a PNG data URI and the action outputs', async () => {
    const { app, auth } = await makeApp({ engine: browserEngine() });
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', formats: ['markdown', 'screenshot'], actions: [{ type: 'scrape' }] },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.screenshot).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(d.actions).toEqual({
      screenshots: [`data:image/png;base64,${PNG.toString('base64')}`],
      scrapes: [{ url: 'https://example.com/final', html: '<p>x</p>' }],
      javascriptReturns: [{ type: 'number', value: 42 }],
      pdfs: [Buffer.from('%PDF-1.4').toString('base64')],
    });
  });

  it('does not include a screenshot unless requested', async () => {
    const { app, auth } = await makeApp({ engine: browserEngine() });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    expect(res.json().data.screenshot).toBeUndefined();
  });

  it('warns when a screenshot was requested but the engine produced none', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', formats: ['markdown', 'screenshot'] },
    });
    expect(res.json().data.screenshot).toBeUndefined();
    expect(res.json().data.warning).toContain('screenshot');
  });

  it('serves the stored snapshot and screenshot whose hashes match the receipt', async () => {
    const { app, auth } = await makeApp({ engine: browserEngine() });
    const post = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', formats: ['markdown', 'screenshot'] },
    });
    const id = post.json().data.trust.receiptId as string;
    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: auth })).json().data;
    expect(receipt.screenshotSha256).toBe(sha256Hex(PNG));

    const snap = await app.inject({ method: 'GET', url: `/v2/receipts/${id}/snapshot`, headers: auth });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers['content-type']).toContain('text/html');
    expect(sha256Hex(snap.rawPayload)).toBe(receipt.htmlSha256);

    const shot = await app.inject({ method: 'GET', url: `/v2/receipts/${id}/screenshot`, headers: auth });
    expect(shot.headers['content-type']).toBe('image/png');
    expect(sha256Hex(shot.rawPayload)).toBe(receipt.screenshotSha256);
    expect(snapshotKey(receipt.screenshotSha256)).toMatch(/^[0-9a-f]{2}\//);
  });

  it('answers 404 for a screenshot when none was taken, and hides artifacts from other keys', async () => {
    const { app, auth, store } = await makeApp();
    const post = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = post.json().data.trust.receiptId as string;
    expect((await app.inject({ method: 'GET', url: `/v2/receipts/${id}/screenshot`, headers: auth })).statusCode).toBe(404);
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other2'), name: 'o' });
    const other = { authorization: 'Bearer ic-other2' };
    expect((await app.inject({ method: 'GET', url: `/v2/receipts/${id}/snapshot`, headers: other })).statusCode).toBe(404);
  });
});

describe('signed receipts', () => {
  it('signs every receipt (including failures) and publishes the verifying key', async () => {
    const { privateKey, publicKey } = generateSigningKey();
    const { app, auth, store } = await makeApp({ signer: privateKey });
    await store.registerPublicKey(publicKey);

    const ok = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = ok.json().data.trust.receiptId as string;
    const body = (await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: auth })).json();
    expect(body.signature).toMatchObject({ alg: 'Ed25519', keyId: privateKey.keyId });

    const keys = (await app.inject({ method: 'GET', url: '/.well-known/icecrawl-keys.json' })).json().keys;
    expect(keys).toHaveLength(1);
    expect(verifySignature(body.data, body.signature, keys[0].publicKey)).toBe(true);
    expect(verifySignature({ ...body.data, finalUrl: 'https://evil.example/' }, body.signature, keys[0].publicKey)).toBe(false);

    const failing = await makeApp({ signer: privateKey, engine: fakeEngine({ statusCode: 429, html: '<html>slow down</html>' }) });
    const bad = await failing.app.inject({ method: 'POST', url: '/v2/scrape', headers: failing.auth, payload: { url: 'https://example.com/start' } });
    const badId = bad.json().trust.receiptId as string;
    const badReceipt = (await failing.app.inject({ method: 'GET', url: `/v2/receipts/${badId}`, headers: failing.auth })).json();
    expect(badReceipt.signature).not.toBeNull();
  });

  it('returns a null signature when no signing key is configured, and an empty key list', async () => {
    const { app, auth } = await makeApp();
    const post = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = post.json().data.trust.receiptId as string;
    expect((await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: auth })).json().signature).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/.well-known/icecrawl-keys.json' })).json()).toEqual({ keys: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/test/app.test.ts`
Expected: FAIL (no `data.screenshot`, no new routes, no signature).

- [ ] **Step 3: Implement the response builder**

Replace `packages/api/src/response.ts` with:
```ts
import { ERROR_STATUS, VERDICT_ERROR_CODE, type SupportedFormat, type TrustBlock, type Verdict } from '@icecrawl/core';
import type { ScrapeRun } from '@icecrawl/scraper';

const dataUri = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

export function buildResponse(run: ScrapeRun, formats: SupportedFormat[]): { status: number; payload: Record<string, unknown> } {
  const trust: TrustBlock = {
    verdict: run.verdict,
    confidence: run.confidence,
    reasons: run.reasons,
    receiptId: run.id,
    engine: run.engine,
  };

  if (!run.accepted) {
    const code = VERDICT_ERROR_CODE[run.verdict as Exclude<Verdict, 'ok'>];
    return {
      status: ERROR_STATUS[code],
      payload: {
        success: false,
        code,
        error: `Scrape was not trustworthy: ${run.verdict} (${run.reasons.join(', ')})`,
        trust,
      },
    };
  }

  const warnings = [...run.warnings];
  const data: Record<string, unknown> = {};
  if (formats.includes('markdown')) data.markdown = run.markdown;
  if (formats.includes('html')) data.html = run.cleanHtml;
  if (formats.includes('rawHtml')) data.rawHtml = run.rawHtml;
  if (formats.includes('links')) data.links = run.links;
  if (formats.includes('screenshot')) {
    if (run.screenshot) data.screenshot = dataUri('image/png', run.screenshot);
    else warnings.push('A screenshot was requested but the engine did not produce one.');
  }
  if (run.actions) {
    data.actions = {
      screenshots: run.actions.screenshots.map((b) => dataUri('image/png', b)),
      scrapes: run.actions.scrapes,
      javascriptReturns: run.actions.javascriptReturns,
      pdfs: run.actions.pdfs.map((b) => Buffer.from(b).toString('base64')),
    };
  }
  data.metadata = {
    title: run.title,
    description: run.description,
    language: run.language,
    sourceURL: run.requestedUrl,
    url: run.finalUrl,
    statusCode: run.statusCode,
    contentType: run.contentType,
  };
  if (warnings.length > 0) data.warning = warnings.join(' ');
  data.trust = trust;
  return { status: 200, payload: { success: true, data } };
}
```

- [ ] **Step 4: Implement the app changes**

In `packages/api/src/app.ts` make these edits:
1. Imports: change `import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';` to `import { IceCrawlError, normalizeScrapeRequest, type SignedReceipt } from '@icecrawl/core';`; change `import { sha256Hex } from '@icecrawl/trust';` to `import { sha256Hex, signReceipt, type PrivateSigningKey } from '@icecrawl/trust';`; change `import type { SnapshotStore, Store } from './store/types';` to `import { snapshotKey, type SnapshotStore, type Store } from './store/types';`
2. In `AppDeps` replace `  scraper: ScraperConfig;\n  useAuth: boolean;\n}` with `  scraper: ScraperConfig;\n  useAuth: boolean;\n  signer?: PrivateSigningKey;\n}`
3. After the line `  app.get('/health', async () => ({ ok: true }));` add:
```ts

  app.get('/.well-known/icecrawl-keys.json', async () => ({ keys: await deps.store.listPublicKeys() }));
```
4. In the scrape route, replace `        const snapshot = await deps.snapshots.put(run.snapshot.bytes);` with:
```ts
        const snapshot = await deps.snapshots.put(run.snapshot.bytes);
        if (run.screenshot) await deps.snapshots.put(run.screenshot);
        const signature = deps.signer ? signReceipt(run.receipt, deps.signer) : null;
```
and replace
```ts
          run.receipt,
          snapshot,
        );
```
with
```ts
          run.receipt,
          snapshot,
          signature,
        );
```
5. Replace the whole existing `/receipts/:id` handler (the block that starts `v2.get<{ Params: { id: string } }>('/receipts/:id', async (req) => {` and ends with `return { success: true, data: receipt };\n      });`) with:
```ts
      const loadReceipt = async (req: FastifyRequest, id: string): Promise<SignedReceipt> => {
        const rec = UUID.test(id) ? await deps.store.getScrape(id) : null;
        const signed = rec ? await deps.store.getSignedReceipt(rec.id) : null;
        if (!rec || !signed || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) {
          throw new IceCrawlError('NOT_FOUND', 'Receipt not found');
        }
        return signed;
      };

      v2.get<{ Params: { id: string } }>('/receipts/:id', async (req) => {
        const { receipt, signature } = await loadReceipt(req, req.params.id);
        return { success: true, data: receipt, signature };
      });

      v2.get<{ Params: { id: string } }>('/receipts/:id/snapshot', async (req, reply) => {
        const { receipt } = await loadReceipt(req, req.params.id);
        const bytes = receipt.htmlSha256 ? await deps.snapshots.get(snapshotKey(receipt.htmlSha256)) : null;
        if (!bytes) throw new IceCrawlError('NOT_FOUND', 'Snapshot not found');
        return reply.header('content-type', receipt.contentType || 'application/octet-stream').send(Buffer.from(bytes));
      });

      v2.get<{ Params: { id: string } }>('/receipts/:id/screenshot', async (req, reply) => {
        const { receipt } = await loadReceipt(req, req.params.id);
        const bytes = receipt.screenshotSha256 ? await deps.snapshots.get(snapshotKey(receipt.screenshotSha256)) : null;
        if (!bytes) throw new IceCrawlError('NOT_FOUND', 'Screenshot not found');
        return reply.header('content-type', 'image/png').send(Buffer.from(bytes));
      });
```

- [ ] **Step 5: Run to verify pass**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test && pnpm typecheck`
Expected: PASS everywhere, nothing skipped. (The phase-1 e2e test calls `GET /v2/receipts/:id` and reads `.data`, which is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): screenshots, action outputs, signed receipts and snapshot/screenshot/keys endpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `engines`: SSRF-safe egress proxy for the browser

**Files:**
- Create: `packages/engines/src/egress-proxy.ts`
- Modify: `packages/engines/src/index.ts`
- Test: `packages/engines/test/egress-proxy.test.ts`

**Interfaces:**
- Consumes: `isPrivateAddress` (phase 1).
- Produces:
  - `interface EgressProxy { url: string; onBlocked(cb: (host: string) => void): () => void; close(): Promise<void> }`
  - `startEgressProxy(opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<dns.LookupAddress[]> }): Promise<EgressProxy>` listening on `127.0.0.1:<random>` (`url` is `http://127.0.0.1:<port>`).
  - Behavior: plain HTTP forwarding (absolute-form requests) and `CONNECT` tunnels; every request resolves the target and refuses private addresses (unless `allowPrivate`) *before connecting*, then connects to the validated IP (no second DNS lookup). Blocked HTTP requests answer `403` with header `x-icecrawl-blocked: ssrf`; blocked `CONNECT` answers `403` and closes. `onBlocked` callbacks fire with the host for each block.

- [ ] **Step 1: Write the failing test**

`packages/engines/test/egress-proxy.test.ts`:
```ts
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../src';

let origin: Server;
let originPort: number;

beforeAll(async () => {
  origin = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-host-seen': String(req.headers.host) });
    res.end('hello from origin');
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as AddressInfo).port;
});

afterAll(() => {
  origin.closeAllConnections();
  origin.close();
});

function viaProxy(proxy: EgressProxy, target: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const p = new URL(proxy.url);
  const t = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: 'GET', path: target, headers: { host: t.host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectThroughProxy(proxy: EgressProxy, hostPort: string): Promise<{ status: number; reply: string }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode ?? 0, reply: '' });
      }
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve({ status: 200, reply: data }));
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy', () => {
  it('forwards plain HTTP when private addresses are allowed', async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const r = await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(200);
      expect(r.body).toBe('hello from origin');
      expect(r.headers['x-host-seen']).toBe(`127.0.0.1:${originPort}`);
    } finally {
      await proxy.close();
    }
  });

  it('blocks plain HTTP to private addresses and reports the host', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    proxy.onBlocked((h) => blocked.push(h));
    try {
      const r = await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(403);
      expect(r.headers['x-icecrawl-blocked']).toBe('ssrf');
      expect(r.body).not.toContain('hello from origin');
      expect(blocked).toEqual(['127.0.0.1']);
    } finally {
      await proxy.close();
    }
  });

  it('blocks a public-looking hostname that resolves to a private address (DNS rebinding)', async () => {
    const proxy = await startEgressProxy({
      allowPrivate: false,
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    try {
      const r = await viaProxy(proxy, 'http://rebind.test/ok');
      expect(r.status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('connects to the validated address, not a second DNS answer', async () => {
    let lookups = 0;
    const proxy = await startEgressProxy({
      allowPrivate: true,
      resolve: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    try {
      const r = await viaProxy(proxy, `http://anything.test:${originPort}/ok`);
      expect(r.status).toBe(200);
      expect(lookups).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('tunnels CONNECT when allowed', async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const r = await connectThroughProxy(proxy, `127.0.0.1:${originPort}`);
      expect(r.status).toBe(200);
      expect(r.reply).toContain('hello from origin');
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to private addresses', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    proxy.onBlocked((h) => blocked.push(h));
    try {
      const r = await connectThroughProxy(proxy, `127.0.0.1:${originPort}`);
      expect(r.status).toBe(403);
      expect(blocked).toEqual(['127.0.0.1']);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to bracketed IPv6 loopback and malformed targets', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    try {
      expect((await connectThroughProxy(proxy, '[::1]:443')).status).toBe(403);
      expect((await connectThroughProxy(proxy, 'no-port')).status).toBe(400);
    } finally {
      await proxy.close();
    }
  });

  it('stops notifying after unsubscribe', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    const off = proxy.onBlocked((h) => blocked.push(h));
    off();
    try {
      await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(blocked).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/engines/test/egress-proxy.test.ts`
Expected: FAIL (`startEgressProxy` not exported).

- [ ] **Step 3: Implement**

`packages/engines/src/egress-proxy.ts`:
```ts
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { isPrivateAddress } from './ssrf';

export interface EgressProxy {
  url: string;
  onBlocked(cb: (host: string) => void): () => void;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  allowPrivate: boolean;
  resolve?: (host: string) => Promise<dns.LookupAddress[]>;
}

class BlockedError extends Error {}

const defaultResolve = (host: string) => dns.promises.lookup(host, { all: true });

function splitHostPort(target: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const resolve = opts.resolve ?? defaultResolve;
  const listeners = new Set<(host: string) => void>();

  // Resolve once and connect to this exact address, so a second DNS answer cannot change the target.
  async function checked(host: string): Promise<dns.LookupAddress> {
    const clean = host.replace(/^\[|\]$/g, '');
    const addresses = await resolve(clean);
    if (addresses.length === 0) throw new Error(`no address for ${clean}`);
    if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
      for (const cb of listeners) cb(clean);
      throw new BlockedError(clean);
    }
    return addresses[0];
  }

  const server = http.createServer(async (req, res) => {
    try {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('absolute-form request required');
        return;
      }
      if (target.protocol !== 'http:') {
        res.writeHead(400).end('only http: is proxied here; https uses CONNECT');
        return;
      }
      const address = await checked(target.hostname);
      const headers = { ...req.headers, host: target.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = http.request(
        {
          host: address.address,
          family: address.family,
          port: Number(target.port || 80),
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (err) {
      if (err instanceof BlockedError) {
        res.writeHead(403, { 'x-icecrawl-blocked': 'ssrf', 'content-type': 'text/plain' }).end(`blocked: ${err.message}`);
      } else if (!res.headersSent) {
        res.writeHead(502).end('upstream error');
      }
    }
  });

  server.on('connect', async (req, clientSocket: net.Socket, head: Buffer) => {
    const hp = splitHostPort(req.url ?? '');
    if (!hp) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    try {
      const address = await checked(hp.host);
      const upstream = net.connect(hp.port, address.address, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    } catch (err) {
      clientSocket.end(`HTTP/1.1 ${err instanceof BlockedError ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    onBlocked(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
```

Append `export * from './egress-proxy';` to `packages/engines/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/engines && pnpm typecheck`
Expected: PASS (egress proxy tests plus the existing engines suites). If a CONNECT test hangs, confirm `clientSocket.end(...)` in the 403/400 paths closes the socket and that the test's `socket.destroy()` runs for non-200 replies; do not change the assertions.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engines): SSRF-safe egress proxy for browser traffic" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `engines`: Playwright engine (JS rendering, mobile, waitFor, actions, screenshots)

**Files:**
- Create: `packages/engines/src/playwright.ts`
- Modify: `packages/engines/src/index.ts`, `packages/engines/package.json`
- Test: `packages/engines/test/playwright.test.ts`

**Interfaces:**
- Consumes: `Action`, `ScreenshotOptions`, `IceCrawlError` (core); `startEgressProxy` (Task 6); `assertUrlAllowed` (phase 1); `ActionOutputs`, `Engine`, `EngineContext`, `EngineResult`, `featureSet` (Task 2).
- Produces:
  - `interface PlaywrightEngineOptions { quality?: number; maxConcurrency?: number; noSandbox?: boolean }`
  - `type PlaywrightEngine = Engine & { close(): Promise<void> }`
  - `createPlaywrightEngine(opts?: PlaywrightEngineOptions): PlaywrightEngine`: name `playwright`; quality default 20; features `actions, waitFor, screenshot, screenshot@fullScreen, mobile, skipTlsVerification`; `maxReasonableTimeMs` 30000; launches Chromium lazily on first scrape; one isolated context per scrape; all traffic through the egress proxy (loopback proxied via `bypass: '<-loopback>'`); non-HTML main responses are returned as raw bytes with their content type; HTML responses return the rendered DOM (`page.content()`) as UTF-8.
  - Errors: `TIMEOUT`, `DNS`, `SSL`, `SSRF_BLOCKED`, `ACTION_FAILED`, `RESPONSE_TOO_LARGE`, `TARGET_ERROR` (including "Chromium is not installed" with the install command).

- [ ] **Step 1: Add the dependency and install Chromium**

Run: `pnpm --filter @icecrawl/engines add playwright-core@^1.64.1`
Expected: `packages/engines/package.json` gains `"playwright-core"` under `dependencies` and `pnpm-lock.yaml` updates.

Run: `pnpm --filter @icecrawl/engines exec playwright-core install chromium`
Expected: downloads Chromium (about 150 to 200 MB, from the Playwright CDN) into the user cache (`%LOCALAPPDATA%\ms-playwright` on Windows) and exits 0. If the machine has no network access, stop and report; the tests below skip when Chromium is missing, so the task is not complete until they run.

- [ ] **Step 2: Write the failing test**

`packages/engines/test/playwright.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightEngine, type EngineContext, type PlaywrightEngine } from '../src';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBrowser)('playwright engine', () => {
  let server: Server;
  let port: number;
  let engine: PlaywrightEngine;

  beforeAll(async () => {
    engine = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
    server = createServer((req, res) => {
      const html = (body: string, head = '') =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title>${head}</head><body>${body}</body></html>`,
        );
      switch (req.url) {
        case '/js':
          return html(
            '<div id="root">loading</div><script>setTimeout(()=>{document.getElementById("root").innerHTML="<h1>Rendered by JS</h1>"},50)</script>',
          );
        case '/late':
          return html('<div id="root">early</div><script>setTimeout(()=>{document.getElementById("root").textContent="late text"},400)</script>');
        case '/actions':
          return html(
            '<input id="i"><button id="b" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p id=done>clicked \'+document.getElementById(\'i\').value+\'</p>\')">go</button><div style="height:3000px">tall</div>',
          );
        case '/mobile':
          return html('<script>document.write("<p id=w>width:"+window.innerWidth+"</p>")</script>');
        case '/headers':
          return html(`<p>x-test:${req.headers['x-test']}</p><p>ua:${req.headers['user-agent']}</p>`);
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
          return;
        case '/403':
          res.writeHead(403, { 'content-type': 'text/html' }).end('<html><body>Forbidden</body></html>');
          return;
        case '/hang':
          return; // never respond
        default:
          res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await engine.close();
    server.closeAllConnections();
    server.close();
  });

  const ctx = (path: string, over: Partial<EngineContext> = {}): EngineContext => ({
    url: `http://127.0.0.1:${port}${path}`,
    headers: {},
    timeoutMs: 15000,
    skipTlsVerification: true,
    allowPrivateNetworks: true,
    maxBytes: 5_000_000,
    waitFor: 0,
    mobile: false,
    actions: [],
    screenshot: null,
    ...over,
  });

  const text = (r: { body: Uint8Array }) => Buffer.from(r.body).toString('utf8');

  it('renders JavaScript and returns the final DOM', async () => {
    const r = await engine.scrape(ctx('/js'));
    expect(r.statusCode).toBe(200);
    expect(text(r)).toContain('Rendered by JS');
    expect(r.contentType).toContain('text/html');
    expect(r.finalUrl).toBe(`http://127.0.0.1:${port}/js`);
    expect(r.truncated).toBe(false);
  });

  it('honours waitFor for late content', async () => {
    const r = await engine.scrape(ctx('/late', { waitFor: 700 }));
    expect(text(r)).toContain('late text');
  });

  it('emulates a mobile viewport', async () => {
    const desktop = await engine.scrape(ctx('/mobile'));
    const mobile = await engine.scrape(ctx('/mobile', { mobile: true }));
    expect(text(desktop)).toContain('width:1280');
    expect(text(mobile)).toContain('width:390');
  });

  it('sends custom headers and an honest user agent', async () => {
    const r = await engine.scrape(ctx('/headers', { headers: { 'X-Test': 'abc' } }));
    expect(text(r)).toContain('x-test:abc');
    expect(text(r)).toMatch(/ua:Mozilla\/5\.0 .*Chrome\/.* IceCrawl\/0\.1/);
  });

  it('runs click, write and wait actions', async () => {
    const r = await engine.scrape(
      ctx('/actions', {
        actions: [
          { type: 'click', selector: '#i', all: false },
          { type: 'write', text: 'abc' },
          { type: 'click', selector: '#b', all: false },
          { type: 'wait', selector: '#done' },
        ],
      }),
    );
    expect(text(r)).toContain('clicked abc');
  });

  it('runs press, scroll and wait-for-milliseconds actions', async () => {
    const r = await engine.scrape(
      ctx('/actions', {
        actions: [
          { type: 'click', selector: '#i', all: false },
          { type: 'press', key: 'a' },
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 50 },
        ],
      }),
    );
    expect(r.actions?.screenshots).toEqual([]);
    expect(r.statusCode).toBe(200);
  });

  it('collects screenshot, scrape, executeJavascript and pdf action outputs in order', async () => {
    const r = await engine.scrape(
      ctx('/js', {
        waitFor: 200,
        actions: [
          { type: 'screenshot', fullPage: false },
          { type: 'scrape' },
          { type: 'executeJavascript', script: '6 * 7' },
          { type: 'executeJavascript', script: '"hi"' },
          { type: 'pdf', format: 'A4', landscape: false, scale: 1 },
        ],
      }),
    );
    const out = r.actions!;
    expect(Buffer.from(out.screenshots[0]).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(out.scrapes[0].html).toContain('Rendered by JS');
    expect(out.scrapes[0].url).toBe(`http://127.0.0.1:${port}/js`);
    expect(out.javascriptReturns).toEqual([
      { type: 'number', value: 42 },
      { type: 'string', value: 'hi' },
    ]);
    expect(Buffer.from(out.pdfs[0]).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('takes a PNG screenshot, and a full-page one is taller than the viewport one', async () => {
    const viewport = await engine.scrape(ctx('/actions', { screenshot: { fullPage: false } }));
    const full = await engine.scrape(ctx('/actions', { screenshot: { fullPage: true } }));
    expect(Buffer.from(viewport.screenshot!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const height = (png: Uint8Array) => Buffer.from(png).readUInt32BE(20);
    expect(height(full.screenshot!)).toBeGreaterThan(height(viewport.screenshot!));
  });

  it('honours a screenshot viewport size', async () => {
    const r = await engine.scrape(ctx('/js', { screenshot: { fullPage: false, viewport: { width: 640, height: 480 } } }));
    const png = Buffer.from(r.screenshot!);
    expect(png.readUInt32BE(16)).toBe(640);
    expect(png.readUInt32BE(20)).toBe(480);
  });

  it('returns non-HTML main responses as raw bytes with their content type', async () => {
    const r = await engine.scrape(ctx('/json'));
    expect(r.contentType).toContain('application/json');
    expect(text(r)).toBe('{"hello":"world"}');
  });

  it('reports the real status code of non-2xx pages', async () => {
    const r = await engine.scrape(ctx('/403'));
    expect(r.statusCode).toBe(403);
  });

  it('fails an action on a missing element with ACTION_FAILED', async () => {
    await expect(
      engine.scrape(ctx('/js', { timeoutMs: 3000, actions: [{ type: 'click', selector: '#nope', all: false }] })),
    ).rejects.toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('Action 0 (click)') });
  });

  it('times out on a page that never answers', async () => {
    await expect(engine.scrape(ctx('/hang', { timeoutMs: 1500 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('blocks private targets when private networks are not allowed', async () => {
    await expect(engine.scrape(ctx('/js', { allowPrivateNetworks: false }))).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('enforces the size cap on the rendered document', async () => {
    await expect(engine.scrape(ctx('/js', { maxBytes: 50 }))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('runs scrapes concurrently in isolated contexts', async () => {
    const [a, b] = await Promise.all([engine.scrape(ctx('/js')), engine.scrape(ctx('/late', { waitFor: 700 }))]);
    expect(text(a)).toContain('Rendered by JS');
    expect(text(b)).toContain('late text');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/engines/test/playwright.test.ts`
Expected: FAIL (`createPlaywrightEngine` not exported). Make sure the output shows the tests were collected, not skipped; if they are skipped, Step 1's browser install did not complete.

- [ ] **Step 4: Implement**

`packages/engines/src/playwright.ts`:
```ts
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { IceCrawlError, type Action, type ScreenshotOptions } from '@icecrawl/core';
import { startEgressProxy, type EgressProxy } from './egress-proxy';
import { featureSet } from './flags';
import { assertUrlAllowed } from './ssrf';
import type { ActionOutputs, Engine, EngineContext, EngineResult } from './types';

export interface PlaywrightEngineOptions {
  quality?: number;
  maxConcurrency?: number;
  noSandbox?: boolean;
}

export type PlaywrightEngine = Engine & { close(): Promise<void> };

const INSTALL_HINT = 'Chromium is not installed. Run: pnpm --filter @icecrawl/engines exec playwright-core install chromium';

class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

function browserUnavailable(err: unknown): IceCrawlError {
  const msg = (err as Error).message ?? String(err);
  if (/Executable doesn't exist/i.test(msg)) return new IceCrawlError('TARGET_ERROR', INSTALL_HINT);
  return new IceCrawlError('TARGET_ERROR', `Could not start the browser: ${msg.split('\n')[0]}`);
}

function mapError(err: unknown, s: { timedOut: boolean; blockedHosts: string[] }): IceCrawlError {
  if (s.timedOut) return new IceCrawlError('TIMEOUT', 'Timed out rendering the page');
  if (err instanceof IceCrawlError) return err;
  const e = err as { name?: string; message?: string };
  const msg = e.message ?? String(err);
  if (e.name === 'TimeoutError') return new IceCrawlError('TIMEOUT', 'Timed out rendering the page');
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return new IceCrawlError('DNS', 'Could not resolve the host');
  if (/ERR_CERT|ERR_SSL|SSL_ERROR/.test(msg)) return new IceCrawlError('SSL', `TLS error: ${msg.split('\n')[0]}`);
  // shortcut: a block is attributed to this scrape if the proxy blocked anything while it ran; a concurrent scrape's block can be misattributed, which only changes the error code. Upgrade by tagging proxy requests per context.
  if (s.blockedHosts.length > 0 && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_ABORTED/.test(msg)) {
    return new IceCrawlError('SSRF_BLOCKED', `Blocked request to a private address: ${s.blockedHosts[0]}`);
  }
  if (/Executable doesn't exist/i.test(msg)) return new IceCrawlError('TARGET_ERROR', INSTALL_HINT);
  return new IceCrawlError('TARGET_ERROR', msg.split('\n')[0]);
}

async function takeScreenshot(page: Page, o: ScreenshotOptions): Promise<Uint8Array> {
  const previous = page.viewportSize();
  if (o.viewport) await page.setViewportSize(o.viewport);
  try {
    return await page.screenshot({ type: 'png', fullPage: o.fullPage });
  } finally {
    if (o.viewport && previous) await page.setViewportSize(previous);
  }
}

async function runActions(page: Page, actions: Action[]): Promise<ActionOutputs> {
  const out: ActionOutputs = { screenshots: [], scrapes: [], javascriptReturns: [], pdfs: [] };
  for (const [i, a] of actions.entries()) {
    try {
      switch (a.type) {
        case 'wait':
          if (a.milliseconds !== undefined) await page.waitForTimeout(a.milliseconds);
          else await page.waitForSelector(a.selector!, { state: 'visible' });
          break;
        case 'click':
          if (a.all) for (const el of await page.locator(a.selector).all()) await el.click();
          else await page.locator(a.selector).first().click();
          break;
        case 'write':
          await page.keyboard.type(a.text);
          break;
        case 'press':
          await page.keyboard.press(a.key);
          break;
        case 'scroll': {
          const dir = a.direction === 'up' ? -1 : 1;
          if (a.selector) {
            await page.locator(a.selector).first().evaluate((el, d) => el.scrollBy(0, d * (el as HTMLElement).clientHeight), dir);
          } else {
            await page.evaluate((d) => window.scrollBy(0, d * window.innerHeight), dir);
          }
          break;
        }
        case 'screenshot':
          out.screenshots.push(await takeScreenshot(page, { fullPage: a.fullPage, quality: a.quality, viewport: a.viewport }));
          break;
        case 'scrape':
          out.scrapes.push({ url: page.url(), html: await page.content() });
          break;
        case 'executeJavascript': {
          const value = await page.evaluate(a.script);
          out.javascriptReturns.push({ type: typeof value, value });
          break;
        }
        case 'pdf':
          out.pdfs.push(await page.pdf({ format: a.format, landscape: a.landscape, scale: a.scale }));
          break;
      }
    } catch (err) {
      if (err instanceof IceCrawlError) throw err;
      throw new IceCrawlError('ACTION_FAILED', `Action ${i} (${a.type}) failed: ${((err as Error).message ?? '').split('\n')[0]}`);
    }
  }
  return out;
}

export function createPlaywrightEngine(opts: PlaywrightEngineOptions = {}): PlaywrightEngine {
  const semaphore = new Semaphore(opts.maxConcurrency ?? 4);
  let browserPromise: Promise<Browser> | null = null;
  const proxies = new Map<boolean, Promise<EgressProxy>>();

  const getBrowser = (): Promise<Browser> => {
    browserPromise ??= chromium
      .launch({ headless: true, proxy: { server: 'http://per-context' }, args: opts.noSandbox ? ['--no-sandbox'] : [] })
      .catch((err) => {
        browserPromise = null;
        throw browserUnavailable(err);
      });
    return browserPromise;
  };

  const getProxy = (allowPrivate: boolean): Promise<EgressProxy> => {
    let p = proxies.get(allowPrivate);
    if (!p) {
      p = startEgressProxy({ allowPrivate });
      proxies.set(allowPrivate, p);
    }
    return p;
  };

  async function scrape(ctx: EngineContext): Promise<EngineResult> {
    assertUrlAllowed(ctx.url, ctx.allowPrivateNetworks);
    await semaphore.acquire();
    let context: BrowserContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const blockedHosts: string[] = [];
    let unsubscribe = () => {};
    try {
      const browser = await getBrowser();
      const proxy = await getProxy(ctx.allowPrivateNetworks);
      unsubscribe = proxy.onBlocked((host) => blockedHosts.push(host));

      const chrome = browser.version();
      const userAgent = ctx.mobile
        ? `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36 IceCrawl/0.1`
        : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 IceCrawl/0.1`;
      context = await browser.newContext({
        ignoreHTTPSErrors: ctx.skipTlsVerification,
        userAgent,
        viewport: ctx.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: ctx.mobile,
        hasTouch: ctx.mobile,
        extraHTTPHeaders: ctx.headers,
        serviceWorkers: 'block',
        acceptDownloads: false,
        proxy: { server: proxy.url, bypass: '<-loopback>' },
      });
      const live = context;
      timer = setTimeout(() => {
        timedOut = true;
        void live.close().catch(() => undefined);
      }, ctx.timeoutMs);

      const page = await context.newPage();
      page.setDefaultTimeout(ctx.timeoutMs);
      page.setDefaultNavigationTimeout(ctx.timeoutMs);

      const response = await page.goto(ctx.url, { waitUntil: 'load' });
      if (!response) throw new IceCrawlError('TARGET_ERROR', 'Navigation produced no response');
      const headers = response.headers();
      if (headers['x-icecrawl-blocked']) {
        throw new IceCrawlError('SSRF_BLOCKED', 'Blocked request to a private address');
      }

      const contentType = headers['content-type'] ?? '';
      if (contentType !== '' && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        const raw = await response.body();
        if (raw.length > ctx.maxBytes) throw new IceCrawlError('RESPONSE_TOO_LARGE', `Response exceeds ${ctx.maxBytes} bytes`);
        return { finalUrl: page.url(), statusCode: response.status(), headers, body: raw, contentType, truncated: false };
      }

      await page.waitForLoadState('networkidle', { timeout: Math.min(5000, ctx.timeoutMs) }).catch(() => undefined);
      if (ctx.waitFor > 0) await page.waitForTimeout(ctx.waitFor);
      const actions = ctx.actions.length > 0 ? await runActions(page, ctx.actions) : undefined;
      const screenshot = ctx.screenshot ? await takeScreenshot(page, ctx.screenshot) : undefined;

      const body = Buffer.from(await page.content(), 'utf8');
      if (body.length > ctx.maxBytes) throw new IceCrawlError('RESPONSE_TOO_LARGE', `Rendered page exceeds ${ctx.maxBytes} bytes`);
      return {
        finalUrl: page.url(),
        statusCode: response.status(),
        headers,
        body,
        contentType: 'text/html; charset=utf-8',
        truncated: false,
        screenshot,
        actions,
      };
    } catch (err) {
      throw mapError(err, { timedOut, blockedHosts });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      await context?.close().catch(() => undefined);
      semaphore.release();
    }
  }

  return {
    name: 'playwright',
    quality: opts.quality ?? 20,
    features: featureSet(['actions', 'waitFor', 'screenshot', 'screenshot@fullScreen', 'mobile', 'skipTlsVerification']),
    maxReasonableTimeMs: 30_000,
    scrape,
    async close() {
      const browser = browserPromise ? await browserPromise.catch(() => null) : null;
      browserPromise = null;
      await browser?.close().catch(() => undefined);
      for (const p of proxies.values()) await (await p).close().catch(() => undefined);
      proxies.clear();
    },
  };
}
```

Append `export * from './playwright';` to `packages/engines/src/index.ts`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/engines && pnpm typecheck`
Expected: all engines suites PASS with none skipped (playwright: 16 tests). Run the playwright file three times: `pnpm vitest run packages/engines/test/playwright.test.ts` ×3; expected stable. If the mobile test reports `width:980`, confirm the fixture page includes the viewport meta tag; if `x-test` is missing, check `extraHTTPHeaders`; if the full-page screenshot test fails because heights are equal, verify the `#actions` fixture is taller than 800px. Diagnose from real output before changing code; do not weaken assertions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(engines): Playwright engine with actions, screenshots and egress-proxy SSRF protection" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Verification: `trust` verify, `scraper` replay, and the `icecrawl verify` CLI

**Files:**
- Create: `packages/trust/src/verify.ts`, `packages/scraper/src/render.ts`, `packages/scraper/src/replay.ts`, `packages/cli/package.json`, `packages/cli/src/verify-cmd.ts`, `packages/cli/src/bin.ts`
- Modify: `packages/trust/src/index.ts`, `packages/scraper/src/index.ts`, `packages/scraper/src/pipeline.ts` (use `renderBody`)
- Test: `packages/trust/test/verify.test.ts`, `packages/scraper/test/replay.test.ts`, `packages/cli/test/verify-cmd.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`, `verifySignature`, `sha256Hex` (Tasks 3, phase 1); `convertHtml`, `CONVERTER`, `contentKind`, `decodeBody` (phase 1 scraper).
- Produces:
  - `trust`: `type CheckStatus = 'pass' | 'fail' | 'skipped'`; `interface Check { status: CheckStatus; detail: string }`; `interface VerifyReport { signature: Check; html: Check; screenshot: Check; replay: Check; ok: boolean }`; `type ReplayResult = { markdown: string } | { unavailable: string }`; `interface VerifyInput { signed: SignedReceipt; publicKeys: PublicKeyEntry[]; html: Uint8Array | null; screenshot: Uint8Array | null; replay?: (html: Uint8Array) => ReplayResult }`; `verifyReceipt(input: VerifyInput): VerifyReport` (`ok` is true when no check failed).
  - `scraper`: `renderBody(bytes, contentType, finalUrl, options)` returning `{ kind, text, markdown, cleanHtml, links, title, description, language }` (the single code path used by both the pipeline and replay); `replayMarkdown(receipt: Receipt, htmlBytes: Uint8Array): ReplayResult`.
  - `cli`: `runVerify(args: string[], io: VerifyIo): Promise<number>` (exit codes: 0 = no check failed, 1 = a check failed, 2 = usage or network error); `VerifyIo { fetch: typeof fetch; readFile(path: string): Promise<Uint8Array>; out(line: string): void; err(line: string): void; env: Record<string, string | undefined> }`. Online: `verify <receiptId> [--api URL] [--key KEY]` (defaults from `ICECRAWL_API_URL` / `ICECRAWL_API_KEY`). Offline: `verify --receipt FILE --snapshot FILE [--screenshot FILE] [--keys FILE]`.

- [ ] **Step 1: Write the failing tests**

`packages/trust/test/verify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
import { buildReceipt, generateSigningKey, sha256Hex, signReceipt, verifyReceipt } from '../src';

const html = Buffer.from('<html><body>hello</body></html>');
const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
const markdown = 'hello';

function setup(over: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  const key = generateSigningKey();
  const receipt: Receipt = buildReceipt({
    id: '11111111-1111-4111-8111-111111111111',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.9, reasons: [], durationMs: 3 }],
    htmlBytes: html,
    markdown,
    converter: { name: 'icecrawl-convert', version: '1' },
    contentType: 'text/html',
    screenshot: png,
    options: { onlyMainContent: true, skipTlsVerification: true },
    ...over,
  });
  const signature = signReceipt(receipt, key.privateKey);
  return { key, receipt, signature, publicKeys: [key.publicKey] };
}

const goodReplay = () => ({ markdown });

describe('verifyReceipt', () => {
  it('passes every check for untouched data', () => {
    const { receipt, signature, publicKeys } = setup();
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('pass');
    expect(r.html.status).toBe('pass');
    expect(r.screenshot.status).toBe('pass');
    expect(r.replay.status).toBe('pass');
    expect(r.ok).toBe(true);
  });

  it('fails the snapshot check after a one-byte change and skips replay', () => {
    const { receipt, signature, publicKeys } = setup();
    const tampered = Buffer.from(html);
    tampered[3] ^= 1;
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys, html: tampered, screenshot: png, replay: goodReplay });
    expect(r.html.status).toBe('fail');
    expect(r.replay.status).toBe('skipped');
    expect(r.ok).toBe(false);
  });

  it('fails the screenshot check after a change', () => {
    const { receipt, signature, publicKeys } = setup();
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: Buffer.from('89504e470d0a1a0b0000', 'hex'), replay: goodReplay });
    expect(r.screenshot.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails the signature when the receipt was edited', () => {
    const { receipt, signature, publicKeys } = setup();
    const edited = { ...receipt, finalUrl: 'https://evil.example/' };
    const r = verifyReceipt({ signed: { receipt: edited, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails when the signing key is unknown', () => {
    const { receipt, signature } = setup();
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys: [], html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('fail');
    expect(r.signature.detail).toContain(signature.keyId);
  });

  it('still verifies receipts signed by a retired key', () => {
    const { receipt, signature, key } = setup();
    const retired = { ...key.publicKey, retiredAt: '2026-10-25T00:00:00.000Z' };
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys: [retired], html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('pass');
  });

  it('skips the signature check for unsigned receipts without failing them', () => {
    const { receipt, publicKeys } = setup();
    const r = verifyReceipt({ signed: { receipt, signature: null }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('skipped');
    expect(r.ok).toBe(true);
  });

  it('fails replay when the converter output differs from the recorded output hash', () => {
    const { receipt, signature, publicKeys } = setup();
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: () => ({ markdown: 'something else' }) });
    expect(r.replay.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('skips replay when it is unavailable and skips checks for missing artifacts', () => {
    const { receipt, signature, publicKeys } = setup({ screenshot: null });
    const r1 = verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: null, replay: () => ({ unavailable: 'converter differs' }) });
    expect(r1.replay).toMatchObject({ status: 'skipped', detail: expect.stringContaining('converter differs') });
    expect(r1.screenshot.status).toBe('skipped');
    const r2 = verifyReceipt({ signed: { receipt, signature }, publicKeys, html: null, screenshot: null });
    expect(r2.html.status).toBe('skipped');
    expect(r2.replay.status).toBe('skipped');
    expect(r2.ok).toBe(true);
  });

  it('records the expected digest in details', () => {
    const { receipt, signature, publicKeys } = setup();
    const r = verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.html.detail).toContain(sha256Hex(html).slice(0, 12));
  });
});
```

`packages/scraper/test/replay.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, type Engine } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { replayMarkdown, runScrape } from '../src';

const article = `<article><h1>Replay me</h1>${'<p>Reproducible paragraph about a reproducible topic. </p>'.repeat(20)}</article>`;
const pageHtml = `<html><head><title>R</title></head><body><nav>menu</nav>${article}</body></html>`;

const engine = (html: string, contentType = 'text/html; charset=utf-8'): Engine => ({
  name: 'e',
  quality: 5,
  features: featureSet(['skipTlsVerification']),
  maxReasonableTimeMs: 1000,
  scrape: async () => ({ finalUrl: 'https://example.com/final', statusCode: 200, headers: {}, body: Buffer.from(html), contentType, truncated: false }),
});

const cfg = { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false };
const scrape = (html: string, input: Record<string, unknown> = {}, ct?: string) =>
  runScrape({ engines: [engine(html, ct)], config: cfg }, normalizeScrapeRequest({ url: 'https://example.com/start', ...input }));

describe('replayMarkdown', () => {
  it('reproduces the recorded markdown hash from the stored snapshot', async () => {
    const run = await scrape(pageHtml);
    const r = replayMarkdown(run.receipt, run.snapshot.bytes);
    expect('markdown' in r && sha256Hex(r.markdown)).toBe(run.receipt.outputSha256);
  });

  it('reproduces with non-default conversion options', async () => {
    const run = await scrape(pageHtml, { onlyMainContent: false, excludeTags: ['nav'], removeBase64Images: false });
    const r = replayMarkdown(run.receipt, run.snapshot.bytes);
    expect('markdown' in r && sha256Hex(r.markdown)).toBe(run.receipt.outputSha256);
  });

  it('reproduces JSON bodies', async () => {
    const run = await scrape('{"a":1}', {}, 'application/json');
    const r = replayMarkdown(run.receipt, run.snapshot.bytes);
    expect('markdown' in r && sha256Hex(r.markdown)).toBe(run.receipt.outputSha256);
  });

  it('detects a different snapshot', async () => {
    const run = await scrape(pageHtml);
    const r = replayMarkdown(run.receipt, Buffer.from(pageHtml.replace('Replay me', 'Replay you')));
    expect('markdown' in r && sha256Hex(r.markdown)).not.toBe(run.receipt.outputSha256);
  });

  it('reports unavailable for old receipts and other converter versions', async () => {
    const run = await scrape(pageHtml);
    const { contentType: _ct, ...legacy } = run.receipt;
    expect(replayMarkdown(legacy, run.snapshot.bytes)).toMatchObject({ unavailable: expect.stringContaining('content type') });
    const other = { ...run.receipt, converter: { name: 'icecrawl-convert', version: '999' } };
    expect(replayMarkdown(other, run.snapshot.bytes)).toMatchObject({ unavailable: expect.stringContaining('999') });
  });
});
```

`packages/cli/test/verify-cmd.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReceipt, generateSigningKey, signReceipt } from '@icecrawl/trust';
import { runVerify, type VerifyIo } from '../src/verify-cmd';

const html = Buffer.from('<html><body><article>' + 'Plenty of honest words for the converter to keep. '.repeat(10) + '</article></body></html>');
const key = generateSigningKey();

async function makeReceipt() {
  const { renderBody } = await import('@icecrawl/scraper');
  const rendered = renderBody(html, 'text/html', 'https://example.com/', { onlyMainContent: true, removeBase64Images: true });
  const receipt = buildReceipt({
    id: '22222222-2222-4222-8222-222222222222',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.9, reasons: [], durationMs: 3 }],
    htmlBytes: html,
    markdown: rendered.markdown,
    converter: { name: 'icecrawl-convert', version: '1' },
    contentType: 'text/html',
    screenshot: null,
    options: { onlyMainContent: true, skipTlsVerification: true, removeBase64Images: true },
  });
  return { receipt, signature: signReceipt(receipt, key.privateKey) };
}

function io(over: Partial<VerifyIo> = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const base: VerifyIo = {
    fetch: (async () => new Response('not configured', { status: 500 })) as typeof fetch,
    readFile: async (p) => readFile(p),
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    env: {},
    ...over,
  };
  return { base, lines, errs };
}

function fakeServer(parts: { receipt: unknown; signature: unknown; snapshot: Buffer | null; keys: unknown }, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
    if (url.pathname.endsWith('/icecrawl-keys.json')) return Response.json(parts.keys);
    if (url.pathname.endsWith('/snapshot')) return parts.snapshot ? new Response(parts.snapshot) : new Response('no', { status: 404 });
    if (url.pathname.endsWith('/screenshot')) return new Response('no', { status: 404 });
    if (url.pathname.includes('/receipts/')) return Response.json({ success: true, data: parts.receipt, signature: parts.signature });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
}

describe('icecrawl verify (online)', () => {
  it('passes for an untouched receipt and sends the API key', async () => {
    const { receipt, signature } = await makeReceipt();
    const seen: string[] = [];
    const { base, lines } = io({ fetch: fakeServer({ receipt, signature, snapshot: html, keys: { keys: [key.publicKey] } }, seen) });
    const code = await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://localhost:3002', '--key', 'ic-test'], base);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/signature\s+PASS/);
    expect(text).toMatch(/snapshot\s+PASS/);
    expect(text).toMatch(/replay\s+PASS/);
    expect(seen.some((s) => s.includes('/receipts/22222222') && s.endsWith('Bearer ic-test'))).toBe(true);
  });

  it('reads the API location and key from the environment', async () => {
    const { receipt, signature } = await makeReceipt();
    const { base } = io({
      fetch: fakeServer({ receipt, signature, snapshot: html, keys: { keys: [key.publicKey] } }),
      env: { ICECRAWL_API_URL: 'http://localhost:3002', ICECRAWL_API_KEY: 'ic-env' },
    });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222'], base)).toBe(0);
  });

  it('exits 1 and names the failing check when the snapshot was tampered with', async () => {
    const { receipt, signature } = await makeReceipt();
    const tampered = Buffer.from(html);
    tampered[10] ^= 1;
    const { base, lines } = io({ fetch: fakeServer({ receipt, signature, snapshot: tampered, keys: { keys: [key.publicKey] } }) });
    const code = await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], base);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/snapshot\s+FAIL/);
  });

  it('exits 1 when the receipt was edited after signing', async () => {
    const { receipt, signature } = await makeReceipt();
    const { base, lines } = io({
      fetch: fakeServer({ receipt: { ...receipt, finalUrl: 'https://evil.example/' }, signature, snapshot: html, keys: { keys: [key.publicKey] } }),
    });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], base)).toBe(1);
    expect(lines.join('\n')).toMatch(/signature\s+FAIL/);
  });

  it('exits 2 on usage errors and unreachable servers', async () => {
    const a = io();
    expect(await runVerify([], a.base)).toBe(2);
    expect(a.errs.join('\n')).toContain('Usage');
    const b = io({ fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], b.base)).toBe(2);
    expect(b.errs.join('\n')).toContain('404');
  });
});

describe('icecrawl verify (offline)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('verifies files saved from the API', async () => {
    const { receipt, signature } = await makeReceipt();
    const dir = await mkdtemp(join(tmpdir(), 'icecrawl-verify-'));
    dirs.push(dir);
    await writeFile(join(dir, 'receipt.json'), JSON.stringify({ success: true, data: receipt, signature }));
    await writeFile(join(dir, 'snapshot.html'), html);
    await writeFile(join(dir, 'keys.json'), JSON.stringify({ keys: [key.publicKey] }));
    const { base, lines } = io();
    const code = await runVerify(['--receipt', join(dir, 'receipt.json'), '--snapshot', join(dir, 'snapshot.html'), '--keys', join(dir, 'keys.json')], base);
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/replay\s+PASS/);
  });

  it('fails the signature when no keys file is given (an unverifiable signature is never accepted)', async () => {
    const { receipt, signature } = await makeReceipt();
    const dir = await mkdtemp(join(tmpdir(), 'icecrawl-verify-'));
    dirs.push(dir);
    await writeFile(join(dir, 'receipt.json'), JSON.stringify({ receipt, signature }));
    await writeFile(join(dir, 'snapshot.html'), html);
    const { base, lines } = io();
    const code = await runVerify(['--receipt', join(dir, 'receipt.json'), '--snapshot', join(dir, 'snapshot.html')], base);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/signature\s+FAIL.*unknown signing key/);
  });
});
```
- [ ] **Step 2: Run to verify failure**

Run: `pnpm install` (to link the new `cli` workspace package after Step 3's `package.json` exists; before that the CLI test cannot load) and then `pnpm vitest run packages/trust/test/verify.test.ts packages/scraper/test/replay.test.ts`
Expected: FAIL (`verifyReceipt`, `replayMarkdown`, `renderBody` not exported).

- [ ] **Step 3: Implement `trust` verify**

`packages/trust/src/verify.ts`:
```ts
import type { PublicKeyEntry, SignedReceipt } from '@icecrawl/core';
import { sha256Hex } from './receipt';
import { verifySignature } from './sign';

export type CheckStatus = 'pass' | 'fail' | 'skipped';
export interface Check {
  status: CheckStatus;
  detail: string;
}
export type ReplayResult = { markdown: string } | { unavailable: string };

export interface VerifyInput {
  signed: SignedReceipt;
  publicKeys: PublicKeyEntry[];
  html: Uint8Array | null;
  screenshot: Uint8Array | null;
  replay?: (html: Uint8Array) => ReplayResult;
}

export interface VerifyReport {
  signature: Check;
  html: Check;
  screenshot: Check;
  replay: Check;
  ok: boolean;
}

const check = (status: CheckStatus, detail: string): Check => ({ status, detail });
const short = (hex: string) => hex.slice(0, 12);

function hashCheck(label: string, expected: string | null | undefined, bytes: Uint8Array | null): Check {
  if (!expected) return check('skipped', `receipt records no ${label}`);
  if (!bytes) return check('skipped', `${label} not provided`);
  const actual = sha256Hex(bytes);
  return actual === expected
    ? check('pass', `sha256 ${short(actual)}… matches the receipt`)
    : check('fail', `sha256 ${short(actual)}… but the receipt says ${short(expected)}…`);
}

export function verifyReceipt(i: VerifyInput): VerifyReport {
  const { receipt, signature } = i.signed;

  let sig: Check;
  if (!signature) {
    sig = check('skipped', 'receipt is unsigned');
  } else {
    const key = i.publicKeys.find((k) => k.keyId === signature.keyId);
    if (!key) sig = check('fail', `unknown signing key ${signature.keyId}`);
    else if (verifySignature(receipt, signature, key.publicKey)) {
      sig = check('pass', `Ed25519 signature by ${signature.keyId}${key.retiredAt ? ' (retired key)' : ''} is valid`);
    } else {
      sig = check('fail', `signature by ${signature.keyId} does not match the receipt`);
    }
  }

  const html = hashCheck('snapshot hash', receipt.htmlSha256, i.html);
  const screenshot = hashCheck('screenshot hash', receipt.screenshotSha256, i.screenshot);

  let replay: Check;
  if (!i.replay) replay = check('skipped', 'replay not requested');
  else if (!i.html) replay = check('skipped', 'snapshot not provided');
  else if (html.status === 'fail') replay = check('skipped', 'snapshot does not match the receipt, so replaying it is meaningless');
  else if (!receipt.outputSha256) replay = check('skipped', 'receipt records no output hash');
  else {
    const r = i.replay(i.html);
    if ('unavailable' in r) replay = check('skipped', `replay unavailable: ${r.unavailable}`);
    else {
      const actual = sha256Hex(r.markdown);
      replay =
        actual === receipt.outputSha256
          ? check('pass', `re-running the converter reproduces output ${short(actual)}…`)
          : check('fail', `re-running the converter gives ${short(actual)}… but the receipt says ${short(receipt.outputSha256)}…`);
    }
  }

  return { signature: sig, html, screenshot, replay, ok: [sig, html, screenshot, replay].every((c) => c.status !== 'fail') };
}
```
Append `export * from './verify';` to `packages/trust/src/index.ts`.

- [ ] **Step 4: Implement `scraper` render and replay, and use `renderBody` in the pipeline**

`packages/scraper/src/render.ts`:
```ts
import { convertHtml } from './convert';
import { contentKind, decodeBody, type ContentKind } from './decode';

export interface RenderOptions {
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
}

export interface Rendered {
  kind: ContentKind;
  text: string;
  markdown: string;
  cleanHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
}

/** The one place response bytes become markdown; the pipeline and receipt replay both call it. */
export function renderBody(bytes: Uint8Array, contentType: string, finalUrl: string, o: RenderOptions): Rendered {
  const kind = contentKind(contentType, bytes);
  const text = kind === 'unsupported' ? '' : decodeBody(bytes, contentType);
  if (kind === 'html') {
    const c = convertHtml(text, {
      url: finalUrl,
      onlyMainContent: o.onlyMainContent,
      includeTags: o.includeTags,
      excludeTags: o.excludeTags,
      removeBase64Images: o.removeBase64Images,
    });
    return { kind, text, ...c };
  }
  const base = { kind, text, links: [], title: null, description: null, language: null };
  if (kind === 'json') return { ...base, markdown: `\`\`\`json\n${text.trim()}\n\`\`\``, cleanHtml: text };
  if (kind === 'text') return { ...base, markdown: text.trim(), cleanHtml: text };
  return { ...base, markdown: '', cleanHtml: '' };
}
```

`packages/scraper/src/replay.ts`:
```ts
import type { Receipt } from '@icecrawl/core';
import type { ReplayResult } from '@icecrawl/trust';
import { CONVERTER } from './convert';
import { renderBody } from './render';

export function replayMarkdown(receipt: Receipt, htmlBytes: Uint8Array): ReplayResult {
  if (receipt.converter.name !== CONVERTER.name || receipt.converter.version !== CONVERTER.version) {
    return {
      unavailable: `receipt used ${receipt.converter.name}@${receipt.converter.version}, this build has ${CONVERTER.name}@${CONVERTER.version}`,
    };
  }
  if (!receipt.contentType) return { unavailable: 'receipt does not record the content type (made before replay support)' };
  const r = renderBody(htmlBytes, receipt.contentType, receipt.finalUrl, {
    onlyMainContent: receipt.options.onlyMainContent,
    includeTags: receipt.options.includeTags,
    excludeTags: receipt.options.excludeTags,
    removeBase64Images: receipt.options.removeBase64Images ?? true,
  });
  return { markdown: r.markdown };
}
```
Append to `packages/scraper/src/index.ts`: `export * from './render';` and `export * from './replay';`.

In `packages/scraper/src/pipeline.ts` replace the imports

```ts
import { contentKind, decodeBody } from './decode';
import { CONVERTER, convertHtml } from './convert';
import { buildFeatureFlags } from './flags';
```
with
```ts
import { CONVERTER } from './convert';
import { buildFeatureFlags } from './flags';
import { renderBody } from './render';
```
and replace the whole `analyze` function with:
```ts
function analyze(engine: string, result: EngineResult, n: NormalizedScrape): Analyzed {
  const { kind, text, markdown, cleanHtml, links, title, description, language } = renderBody(
    result.body,
    result.contentType,
    result.finalUrl,
    {
      onlyMainContent: n.request.onlyMainContent,
      includeTags: n.request.includeTags,
      excludeTags: n.request.excludeTags,
      removeBase64Images: n.request.removeBase64Images,
    },
  );

  const c = classify({
    statusCode: result.statusCode,
    headers: result.headers,
    html: kind === 'html' ? text : '',
    markdown,
    truncated: result.truncated,
    unsupportedContentType: kind === 'unsupported' ? result.contentType || 'unknown' : undefined,
  });

  return { engine, result, ...c, markdown, cleanHtml, rawHtml: text, links, title, description, language };
}
```

- [ ] **Step 5: Implement the CLI package**

`packages/cli/package.json`:
```json
{
  "name": "@icecrawl/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/verify-cmd.ts" },
  "scripts": { "icecrawl": "tsx src/bin.ts" },
  "dependencies": {
    "@icecrawl/core": "workspace:*",
    "@icecrawl/scraper": "workspace:*",
    "@icecrawl/trust": "workspace:*"
  }
}
```
Run `pnpm install` so the workspace links.

`packages/cli/src/verify-cmd.ts`:
```ts
import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { replayMarkdown } from '@icecrawl/scraper';
import { verifyReceipt, type Check } from '@icecrawl/trust';

export interface VerifyIo {
  fetch: typeof fetch;
  readFile(path: string): Promise<Uint8Array>;
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const USAGE = [
  'Usage:',
  '  icecrawl verify <receiptId> [--api URL] [--key KEY]',
  '  icecrawl verify --receipt FILE --snapshot FILE [--screenshot FILE] [--keys FILE]',
  'Online mode reads ICECRAWL_API_URL and ICECRAWL_API_KEY when the flags are omitted.',
].join('\n');

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } | null {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return null;
      flags[a.slice(2)] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function line(label: string, c: Check): string {
  const tag = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP';
  return `${label.padEnd(10)} ${tag}  ${c.detail}`;
}

function toSigned(json: unknown): SignedReceipt {
  const o = json as { receipt?: Receipt; data?: Receipt; signature?: ReceiptSignature | null };
  const receipt = o.receipt ?? o.data;
  if (!receipt || typeof receipt !== 'object') throw new Error('file does not contain a receipt');
  return { receipt, signature: o.signature ?? null };
}

export async function runVerify(args: string[], io: VerifyIo): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    io.err(USAGE);
    return 2;
  }
  const { positional, flags } = parsed;

  let signed: SignedReceipt;
  let publicKeys: PublicKeyEntry[] = [];
  let html: Uint8Array | null = null;
  let screenshot: Uint8Array | null = null;

  try {
    if (flags.receipt) {
      signed = toSigned(JSON.parse(Buffer.from(await io.readFile(flags.receipt)).toString('utf8')));
      if (flags.snapshot) html = await io.readFile(flags.snapshot);
      if (flags.screenshot) screenshot = await io.readFile(flags.screenshot);
      if (flags.keys) {
        const k = JSON.parse(Buffer.from(await io.readFile(flags.keys)).toString('utf8')) as { keys?: PublicKeyEntry[] };
        publicKeys = k.keys ?? [];
      }
    } else if (positional.length === 1) {
      const api = (flags.api ?? io.env.ICECRAWL_API_URL ?? '').replace(/\/+$/, '');
      const key = flags.key ?? io.env.ICECRAWL_API_KEY;
      if (!api) {
        io.err('No API URL: pass --api or set ICECRAWL_API_URL.');
        return 2;
      }
      const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
      const get = async (path: string, optional = false): Promise<Response | null> => {
        const res = await io.fetch(`${api}${path}`, { headers });
        if (res.status === 404 && optional) return null;
        if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
        return res;
      };
      const id = positional[0];
      signed = toSigned(await (await get(`/v2/receipts/${id}`))!.json());
      publicKeys = ((await (await get('/.well-known/icecrawl-keys.json'))!.json()) as { keys: PublicKeyEntry[] }).keys;
      const snap = await get(`/v2/receipts/${id}/snapshot`, true);
      if (snap) html = new Uint8Array(await snap.arrayBuffer());
      const shot = await get(`/v2/receipts/${id}/screenshot`, true);
      if (shot) screenshot = new Uint8Array(await shot.arrayBuffer());
    } else {
      io.err(USAGE);
      return 2;
    }
  } catch (err) {
    io.err(`Could not load the verification inputs: ${(err as Error).message}`);
    return 2;
  }

  const report = verifyReceipt({
    signed,
    publicKeys,
    html,
    screenshot,
    replay: (bytes) => replayMarkdown(signed.receipt, bytes),
  });
  io.out(`receipt ${signed.receipt.id}`);
  io.out(line('signature', report.signature));
  io.out(line('snapshot', report.html));
  io.out(line('screenshot', report.screenshot));
  io.out(line('replay', report.replay));
  io.out(report.ok ? 'OK: no check failed.' : 'FAILED: at least one check failed.');
  return report.ok ? 0 : 1;
}
```

`packages/cli/src/bin.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { runVerify } from './verify-cmd';

const [command, ...rest] = process.argv.slice(2);

if (command === 'verify') {
  process.exitCode = await runVerify(rest, {
    fetch,
    readFile,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    env: process.env,
  });
} else {
  console.error('Usage: icecrawl verify ... (run `icecrawl verify` for details)');
  process.exitCode = 2;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: all suites PASS (trust verify 10, scraper replay 5, cli 7, plus every earlier suite; the pipeline tests still pass after the `renderBody` refactor).

Run: `pnpm --filter @icecrawl/cli icecrawl verify`
Expected: prints the usage text and exits 2.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: receipt verification (signature, hashes, converter replay) and the icecrawl verify CLI" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire everything into the server, Docker, end-to-end test with a real browser, docs

**Files:**
- Modify: `packages/api/src/config.ts`, `packages/api/src/server.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `docs/superpowers/specs/2026-10-24-icecrawl-design.md`
- Test: `packages/api/test/e2e.browser.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: env settings `ICECRAWL_BROWSER` (default `true`), `ICECRAWL_PREFER_BROWSER` (default `true`), `ICECRAWL_BROWSER_CONCURRENCY` (default `4`), `ICECRAWL_BROWSER_NO_SANDBOX` (default `false`), `ICECRAWL_SIGNING_KEY_FILE` (default `./data/signing-key.pem`); a server that signs receipts and uses `[playwright, fetch]` engines; a Docker image with Chromium.

- [ ] **Step 1: Write the end-to-end test**

`packages/api/test/e2e.browser.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runVerify, type VerifyIo } from '@icecrawl/cli';
import { createPlaywrightEngine, fetchEngine } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { loadOrCreateSigningKey } from '../src/signing';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';

const url = process.env.DATABASE_URL;
const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const pageHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>JS Page</title></head><body>
<div id="root">loading</div>
<script>setTimeout(()=>{document.getElementById('root').innerHTML='<article><h1>Rendered by JS</h1>'+'<p>Content that only exists after JavaScript runs. </p>'.repeat(20)+'</article>'},50)</script>
</body></html>`;

describe.skipIf(!url || !hasBrowser)('end to end: browser + signing + verify', () => {
  const sql = createSql(url ?? 'postgres://unused');
  const engine = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
  let origin: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-browser-'));
    origin = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml);
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await engine.close();
    origin.closeAllConnections();
    origin.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('renders JS, screenshots it, signs the receipt, and verify passes; tampering is caught', async () => {
    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(join(dir, 'snaps'));
    const signer = await loadOrCreateSigningKey(join(dir, 'signing-key.pem'), store);
    const app = buildApp({
      store,
      snapshots,
      engines: [engine, fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false },
      useAuth: true,
      signer,
    });
    const token = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(token), name: 'e2e-browser' });
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: `http://127.0.0.1:${port}/page`, formats: ['markdown', 'screenshot'], waitFor: 300 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.markdown).toContain('Rendered by JS');
    expect(body.data.trust).toMatchObject({ verdict: 'ok', engine: 'playwright' });
    expect(body.data.screenshot).toMatch(/^data:image\/png;base64,/);
    const id = body.data.trust.receiptId as string;

    // a verify client that talks to the in-process app
    const fetchViaApp = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      const r = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(r.rawPayload, { status: r.statusCode, headers: r.headers as Record<string, string> });
    }) as typeof fetch;
    const run = async (override?: typeof fetch) => {
      const lines: string[] = [];
      const io: VerifyIo = { fetch: override ?? fetchViaApp, readFile: async (p) => readFile(p), out: (l) => lines.push(l), err: (l) => lines.push(l), env: {} };
      const code = await runVerify([id, '--api', 'http://icecrawl.test', '--key', token], io);
      return { code, text: lines.join('\n') };
    };

    const good = await run();
    expect(good.code).toBe(0);
    expect(good.text).toMatch(/signature\s+PASS/);
    expect(good.text).toMatch(/snapshot\s+PASS/);
    expect(good.text).toMatch(/screenshot\s+PASS/);
    expect(good.text).toMatch(/replay\s+PASS/);

    // tamper with the stored snapshot as seen by the verifier
    const tamperedSnapshot = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchViaApp(input, init);
      if (!String(input).endsWith('/snapshot')) return res;
      const bytes = Buffer.from(await res.arrayBuffer());
      bytes[bytes.length - 3] ^= 1;
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const bad = await run(tamperedSnapshot);
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/snapshot\s+FAIL/);

    // tamper with the receipt as seen by the verifier
    const tamperedReceipt = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchViaApp(input, init);
      if (!new URL(String(input)).pathname.endsWith(`/receipts/${id}`)) return res;
      const json = (await res.json()) as { data: { finalUrl: string } };
      json.data.finalUrl = 'https://evil.example/';
      return Response.json(json);
    }) as typeof fetch;
    const forged = await run(tamperedReceipt);
    expect(forged.code).toBe(1);
    expect(forged.text).toMatch(/signature\s+FAIL/);
  });

  it('falls back to fetch when the browser engine fails, and records both attempts', async () => {
    const store = new PgStore(sql);
    const broken = { ...engine, scrape: async () => { throw Object.assign(new Error('boom'), { name: 'Error' }); } };
    const app = buildApp({
      store,
      snapshots: new FileSnapshotStore(join(dir, 'snaps2')),
      engines: [broken, fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false },
      useAuth: false,
    });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', payload: { url: `http://127.0.0.1:${port}/page` } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.trust.receiptId as string;
    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${id}` })).json().data;
    expect(receipt.engineChain.map((a: { engine: string }) => a.engine)).toEqual(['playwright', 'fetch']);
    expect(receipt.engineChain[0].verdict).toBe('error');
  });
});
```
`packages/api/package.json` needs `@icecrawl/cli` and `playwright-core` for this test: add `"@icecrawl/cli": "workspace:*"` under `devDependencies` (create the key if absent) and `"playwright-core": "^1.64.1"` under `devDependencies`, then run `pnpm install`.

- [ ] **Step 2: Run to verify it fails for the right reason**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm vitest run packages/api/test/e2e.browser.test.ts`
Expected: the test should already PASS because all pieces exist (it is the first test wiring them together). If it fails, the failure points at a real integration gap; fix the cause. If it is skipped, `DATABASE_URL` is missing or Chromium is not installed (Task 7, Step 1).

- [ ] **Step 3: Config and server wiring**

Replace `packages/api/src/config.ts` with:
```ts
export interface AppConfig {
  port: number;
  databaseUrl: string;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3002),
    databaseUrl: env.DATABASE_URL ?? 'postgres://icecrawl:icecrawl@localhost:5432/icecrawl',
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
  };
}
```

Replace `packages/api/src/server.ts` with:
```ts
import { createPlaywrightEngine, fetchEngine, type Engine } from '@icecrawl/engines';
import { buildApp } from './app';
import { loadConfig } from './config';
import { loadOrCreateSigningKey } from './signing';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';

const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);
const store = new PgStore(sql);
const signer = await loadOrCreateSigningKey(config.signingKeyFile, store);

const browser = config.browserEnabled
  ? createPlaywrightEngine({
      quality: config.preferBrowser ? 20 : 4,
      maxConcurrency: config.browserConcurrency,
      noSandbox: config.browserNoSandbox,
    })
  : null;
const engines: Engine[] = browser ? [browser, fetchEngine] : [fetchEngine];

const app = buildApp({
  store,
  snapshots: new FileSnapshotStore(config.snapshotDir),
  engines,
  scraper: {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
  },
  useAuth: config.useAuth,
  signer,
});

const shutdown = async () => {
  await app.close();
  await browser?.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'}, engines ${engines.map((e) => e.name).join(' > ')}, signing key ${signer.keyId})`,
);
```

- [ ] **Step 4: Docker, env and docs**

Replace `Dockerfile` with:
```dockerfile
FROM node:20-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @icecrawl/engines exec playwright-core install --with-deps chromium
ENV ICECRAWL_BROWSER_NO_SANDBOX=true
EXPOSE 3002
CMD ["pnpm", "--filter", "@icecrawl/api", "start"]
```

In `docker-compose.yml`, in the `api` service's `environment:` block add:
```yaml
      ICECRAWL_SIGNING_KEY_FILE: /data/signing/signing-key.pem
      ICECRAWL_BROWSER_NO_SANDBOX: "true"
```
and change its `volumes:` to `["snapshots:/data/snapshots", "signing:/data/signing"]`; add `  signing: {}` under the top-level `volumes:`. Also add `    shm_size: "1gb"` to the `api` service (Chromium needs shared memory).

Append to `.env.example`:
```
ICECRAWL_BROWSER=true
ICECRAWL_PREFER_BROWSER=true
ICECRAWL_BROWSER_CONCURRENCY=4
ICECRAWL_BROWSER_NO_SANDBOX=false
ICECRAWL_SIGNING_KEY_FILE=./data/signing-key.pem
```

In `README.md`: change the status line to `> Status: phase 2 (browser + signing). \`POST /v2/scrape\` renders JavaScript pages, runs actions, takes screenshots and returns signed receipts. Crawl, map, batch, search, extract, MCP and the rest follow the roadmap in \`docs/superpowers/specs/2026-10-24-icecrawl-design.md\`.`; in Quick start add a line `pnpm --filter @icecrawl/engines exec playwright-core install chromium   # one-time browser download` before `pnpm dev`; and append this section before `## Tests`:
```markdown
## Verifying a scrape

Every receipt is signed with Ed25519 (RFC 8785 canonical JSON). The public keys are at `/.well-known/icecrawl-keys.json`; retired keys stay listed so old receipts keep verifying.

```bash
pnpm --filter @icecrawl/cli icecrawl verify <receiptId> --api http://localhost:3002 --key $KEY
```
It checks the signature, re-hashes the stored raw HTML (and screenshot), and re-runs the pinned HTML-to-markdown converter on that HTML to confirm it reproduces the recorded output hash. Offline: `icecrawl verify --receipt r.json --snapshot s.html --keys keys.json` using files saved from `GET /v2/receipts/{id}`, `/snapshot` and the keys endpoint.

Rotate the signing key with `pnpm --filter @icecrawl/api signing:rotate` (the old private key is kept as a `.bak` file, its public key is marked retired).

## Browser notes

The browser engine routes all traffic through an internal proxy that blocks private and loopback addresses at connect time, including redirects and subresources. For defence in depth, run the server in a container with restricted egress. Set `ICECRAWL_BROWSER=false` to use plain HTTP fetch only, or `ICECRAWL_PREFER_BROWSER=false` to try fetch first and use the browser only when the fetched page looks empty or blocked.
```
(Use real triple backticks in the README; the fences above are shown nested only for this plan.)

In `docs/superpowers/specs/2026-10-24-icecrawl-design.md` section 8, append a bullet at the end of the "Defaults:" paragraph's list area (new line after that paragraph): `- Browser traffic is forced through an in-process egress proxy that enforces the SSRF guard at connect time (phase 2). Receipts are signed with Ed25519 and carry the content type and conversion options needed to replay the conversion (phase 2).`

- [ ] **Step 5: Verify the Docker image builds**

Run: `docker compose config -q` then `docker compose build api`
Expected: config valid; the image builds, including the Chromium download and `--with-deps` apt step (several minutes, a few hundred MB). If the apt step fails, report the exact error; do not start the container.

- [ ] **Step 6: Live smoke test**

Run: `pnpm db:up`, then `pnpm --filter @icecrawl/api keys:create dev` (note the key), then start the server in the background: `pnpm --filter @icecrawl/api start`.
Expected: `IceCrawl listening on :3002 (auth on, engines playwright > fetch, signing key k_...)`.

Run (replace `KEY`):
```bash
curl -s http://localhost:3002/v2/scrape -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"url":"https://example.com","formats":["markdown","screenshot"]}' | head -c 600
```
Expected: `"success":true`, `"engine":"playwright"`, a `"screenshot":"data:image/png;base64,...` value, and a `receiptId`.

Run: `pnpm --filter @icecrawl/cli icecrawl verify <receiptId> --api http://localhost:3002 --key KEY`
Expected: signature, snapshot, screenshot and replay all `PASS`, exit 0.

Run: `curl -s http://localhost:3002/.well-known/icecrawl-keys.json`
Expected: one key entry with `"retiredAt":null`.

Run: `curl -s http://localhost:3002/v2/scrape -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"url":"http://localhost:3002/health"}'`
Expected: HTTP 400 `SSRF_BLOCKED`.

Stop the server process afterwards (kill only that PID; check `netstat` shows port 3002 free).

- [ ] **Step 7: Run everything and commit**

Run: `DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test && pnpm typecheck`
Expected: all test files PASS with none skipped; typecheck exits 0.

```bash
git add -A
git commit -m "feat: wire browser engine and receipt signing into the server; docs, Docker and e2e" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage for phase 2)

| Phase 2 item (spec section 10) | Task |
|---|---|
| Playwright engine | 7 (+ egress proxy 6) |
| Picker (browser flags) | 2 (flags/context plumbing), 7 (features), 9 (engine order) |
| Actions | 1 (schema), 7 (execution), 5 (response) |
| Screenshots | 1, 2, 5, 7 |
| Ed25519 signing | 3, 4, 5 |
| `verify` | 8 (+ snapshot/screenshot endpoints in 5) |
| Snapshots (stored raw HTML, served for verify) | 5 (endpoints), 8 (replay) |
| Receipt "canonical JSON (RFC 8785)" and "keys served at /.well-known" (spec 3, 6) | 3, 5 |
| SSRF in the browser (spec 8) | 6, 7 |
| Phase-1 limits closed: `NO_ENGINE` for actions/waitFor/screenshot | 7, 9 |

Not in this plan on purpose: overlapped waterfall, `location`, hosted screenshot URLs, JPEG quality, action outputs in receipts, stealth/proxies, PDF/document engines (phase 7/3).

Type consistency: `Action`/`ScreenshotOptions` (Task 1) feed `EngineContext` (Task 2) and the engine (Task 7); `ActionOutputs` (Task 2) is built by the engine and mapped by `buildResponse` (Task 5); `PrivateSigningKey` (Task 3) is the `AppDeps.signer` type (Task 5) and the return of `loadOrCreateSigningKey` (Task 4); `ReplayResult` (Task 8, trust) is returned by `replayMarkdown` (scraper); `SignedReceipt` flows from `Store.getSignedReceipt` (Task 4) through `loadReceipt` (Task 5) to the CLI (Task 8).
