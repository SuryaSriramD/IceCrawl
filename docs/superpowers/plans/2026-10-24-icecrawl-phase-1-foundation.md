# IceCrawl Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running IceCrawl server where `POST /v2/scrape` fetches a URL, converts it to markdown, classifies the result with a trust verdict, stores the raw HTML snapshot, and returns the Firecrawl-v2-shaped response plus a provenance receipt.

**Architecture:** pnpm TypeScript monorepo. `core` holds shared types, zod schemas and the error taxonomy. `engines` holds the SSRF-safe `fetch` engine and the feature-flag picker. `trust` holds the verdict classifier and receipt builder. `scraper` orchestrates flags → picker → engine waterfall → convert → classify → receipt. `api` is a Fastify server with API-key auth and a Postgres store. Scrapes run inline in the API process in this phase; the queue and worker arrive in phase 3.

**Tech Stack:** Node >=20.12, TypeScript 5, pnpm 10 workspaces, vitest 2, zod 3, Fastify 5, undici 6, postgres.js 3, linkedom + @mozilla/readability + turndown, Postgres 16, Redis 7 (provisioned, unused until phase 3).

## Global Constraints

Copied from `docs/superpowers/specs/2026-10-24-icecrawl-design.md`:

- Language TypeScript on Node; license Apache-2.0; clean-room (no Firecrawl code copied).
- Infra: Postgres + Redis in docker-compose.
- Same paths, bearer auth, `success`/`data` envelope as Firecrawl v2; error body is `{success:false, error}` plus a typed `code`.
- Only verdict `ok` is success; `uncertain` is success unless strict mode. Anything else is `success:false` with a typed code.
- Verdicts: `ok | blocked | login_wall | captcha | empty | soft_404 | truncated | uncertain | error`.
- Typed error codes (phase 1 subset): `VALIDATION, UNAUTHORIZED, UNSUPPORTED_OPTION, NO_ENGINE, SSRF_BLOCKED, TIMEOUT, DNS, SSL, RESPONSE_TOO_LARGE, BLOCKED, CAPTCHA, LOGIN_WALL`, plus the verdict-derived codes.
- SSRF guard: block private, loopback and link-local addresses after DNS resolution and on every redirect; response size cap; per-scrape wall-clock limit; API keys stored hashed.
- Engine picker: priorities `actions 20, waitFor 1, screenshot 10, pdf 100, document 100, location 10, mobile 10, skipTlsVerification 10, stealthProxy 20, disableAdblock 10`; support threshold `floor(sum/2)`; drop engines with quality <= 0 when a positive-quality one qualifies; sort by support score then quality.
- Unsupported options are accepted and reported in `warning`.
- Phase 1 formats: `markdown`, `html`, `rawHtml`, `links`.
- Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (second `-m`).

## Deviations from the spec (decided for phase 1)

- No `jobs` table, `worker` or `queue` package yet; scrape runs inline. `scrapes` has no `job_id`; it gets one in phase 3.
- New package `scraper` (shared pipeline library) between `engines`/`trust` and `api`. Phase 3's worker will call it.
- `scrapes` has an extra `response jsonb` column holding the exact response envelope, so `GET /v2/scrape/{id}` can replay it.
- Receipts are unsigned (`signature` null); signing is phase 2.
- Zod schemas are hand-written from the v2 OpenAPI for the scrape subset (not generated). Full OpenAPI conformance testing is phase 6.
- Strict mode is an env setting (`ICECRAWL_STRICT`), not a request field.
- `GET /v2/scrape/{id}` always returns HTTP 200 with the stored envelope; read `success` to tell outcomes apart.

## File Structure

```
icecrawl/
  package.json  pnpm-workspace.yaml  tsconfig.json  vitest.config.ts
  .gitignore  .env.example  docker-compose.yml  Dockerfile  LICENSE  README.md
  packages/
    core/     src/{index,errors,trust,scrape}.ts          test/{errors,scrape}.test.ts
    trust/    src/{index,classify,receipt}.ts             test/{classify,receipt}.test.ts
    engines/  src/{index,types,flags,picker,ssrf,fetch}.ts test/{picker,ssrf,fetch}.test.ts
    scraper/  src/{index,flags,decode,convert,pipeline}.ts test/{flags,decode,convert,pipeline}.test.ts
    api/      src/{config,app,response,server}.ts
              src/store/{types,memory,pg,migrate,snapshots}.ts
              src/cli/{keys,migrate}.ts
              migrations/001_init.sql
              test/{helpers.ts,store.contract.ts,store.memory.test.ts,store.pg.test.ts,
                    snapshots.test.ts,app.test.ts,e2e.test.ts}
```

---

### Task 1: Monorepo scaffold, tooling and local infra

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml`, `LICENSE`
- Create: `packages/{core,trust,engines,scraper,api}/package.json`, `packages/*/src/index.ts` (placeholder export)
- Modify: `docs/superpowers/specs/2026-10-24-icecrawl-design.md` (add `scraper` row)

**Interfaces:**
- Produces: workspace packages `@icecrawl/core`, `@icecrawl/trust`, `@icecrawl/engines`, `@icecrawl/scraper`, `@icecrawl/api`, each exporting from `src/index.ts` (resolved directly as TypeScript by vitest and tsx; no build step in phase 1). Root scripts `pnpm test`, `pnpm typecheck`.

- [ ] **Step 1: Configure git identity for this repo and create root files**

Run (from `D:\1.projects\icecrawl`):
```bash
git config user.name "surya"
git config user.email "duvvurisuryasriram4@gmail.com"
```

`package.json`:
```json
{
  "name": "icecrawl",
  "private": true,
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": ">=20.12" },
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "db:up": "docker compose up -d postgres redis",
    "dev": "pnpm --filter @icecrawl/api dev"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 15000 },
});
```

`.gitignore`:
```
node_modules/
data/
.env
coverage/
*.log
```

`.env.example`:
```
PORT=3002
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl
REDIS_URL=redis://localhost:6379
ICECRAWL_SNAPSHOT_DIR=./data/snapshots
ICECRAWL_USE_AUTH=true
ICECRAWL_ALLOW_PRIVATE_NETWORKS=false
ICECRAWL_STRICT=false
ICECRAWL_MAX_RESPONSE_BYTES=10485760
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: icecrawl
      POSTGRES_PASSWORD: icecrawl
      POSTGRES_DB: icecrawl
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U icecrawl"]
      interval: 5s
      timeout: 3s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata: {}
```

Fetch the license text:
```bash
curl -sSfL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
```
Expected: `LICENSE` is ~11 KB and begins with "Apache License".

- [ ] **Step 2: Create the five package manifests and placeholder entry points**

`packages/core/package.json`:
```json
{
  "name": "@icecrawl/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/trust/package.json`:
```json
{
  "name": "@icecrawl/trust",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@icecrawl/core": "workspace:*" }
}
```

`packages/engines/package.json`:
```json
{
  "name": "@icecrawl/engines",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@icecrawl/core": "workspace:*", "undici": "^6.21.0" }
}
```

`packages/scraper/package.json`:
```json
{
  "name": "@icecrawl/scraper",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@icecrawl/core": "workspace:*",
    "@icecrawl/engines": "workspace:*",
    "@icecrawl/trust": "workspace:*",
    "@mozilla/readability": "^0.5.0",
    "linkedom": "^0.18.5",
    "turndown": "^7.2.0"
  },
  "devDependencies": { "@types/turndown": "^5.0.5" }
}
```

`packages/api/package.json`:
```json
{
  "name": "@icecrawl/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "migrate": "tsx src/cli/migrate.ts",
    "keys:create": "tsx src/cli/keys.ts create"
  },
  "dependencies": {
    "@icecrawl/core": "workspace:*",
    "@icecrawl/engines": "workspace:*",
    "@icecrawl/scraper": "workspace:*",
    "@icecrawl/trust": "workspace:*",
    "fastify": "^5.1.0",
    "postgres": "^3.4.5"
  }
}
```

Create each of `packages/core/src/index.ts`, `packages/trust/src/index.ts`, `packages/engines/src/index.ts`, `packages/scraper/src/index.ts` containing exactly `export {};` and `packages/api/src/app.ts` containing exactly `export {};`.

- [ ] **Step 3: Install and verify the toolchain**

Run: `pnpm install`
Expected: completes without error and creates `pnpm-lock.yaml`.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exits 0; vitest prints "No test files found" and exits 0 (because of `--passWithNoTests`).

- [ ] **Step 4: Amend the spec's package table**

In `docs/superpowers/specs/2026-10-24-icecrawl-design.md`, insert this row immediately after the line that starts with ``| `engines` ``:
```
| `scraper` | Shared scrape pipeline: flags, picker, waterfall, HTML conversion, verdict, receipt. Called by `api` now and `worker` from phase 3. | core, engines, trust |
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo, tooling and local infra" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `core`: error taxonomy, trust types, scrape request schema

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/trust.ts`, `packages/core/src/scrape.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/errors.test.ts`, `packages/core/test/scrape.test.ts`

**Interfaces:**
- Produces:
  - `ERROR_STATUS` (code → HTTP status), `type ErrorCode`, `class IceCrawlError(code, message, details?)` with `.status`.
  - `VERDICTS`, `type Verdict`, `VERDICT_ERROR_CODE`, `interface TrustBlock`, `interface EngineAttempt`, `interface Receipt`.
  - `SUPPORTED_FORMATS`, `type SupportedFormat`, `scrapeRequestSchema`, `type ScrapeRequest`, `interface NormalizedScrape { request; formats; warnings }`, `normalizeScrapeRequest(input: unknown): NormalizedScrape` (throws `IceCrawlError`).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, IceCrawlError, VERDICT_ERROR_CODE, VERDICTS } from '../src';

describe('IceCrawlError', () => {
  it('derives its HTTP status from the code', () => {
    const e = new IceCrawlError('NO_ENGINE', 'nope');
    expect(e.status).toBe(422);
    expect(e.code).toBe('NO_ENGINE');
    expect(e.message).toBe('nope');
  });

  it('maps every non-ok verdict to a known error code', () => {
    for (const v of VERDICTS.filter((x) => x !== 'ok')) {
      const code = VERDICT_ERROR_CODE[v as Exclude<(typeof VERDICTS)[number], 'ok'>];
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
```

`packages/core/test/scrape.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IceCrawlError, normalizeScrapeRequest } from '../src';

describe('normalizeScrapeRequest', () => {
  it('applies v2 defaults', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com' });
    expect(n.request.onlyMainContent).toBe(true);
    expect(n.request.waitFor).toBe(0);
    expect(n.request.timeout).toBe(60000);
    expect(n.request.skipTlsVerification).toBe(true);
    expect(n.request.proxy).toBe('auto');
    expect(n.formats).toEqual(['markdown']);
    expect(n.warnings).toEqual([]);
  });

  it('accepts string and object formats and de-duplicates', () => {
    const n = normalizeScrapeRequest({
      url: 'https://example.com',
      formats: ['markdown', { type: 'links' }, 'markdown'],
    });
    expect(n.formats).toEqual(['markdown', 'links']);
  });

  it('warns about unsupported formats but keeps supported ones', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', formats: ['markdown', 'screenshot'] });
    expect(n.formats).toEqual(['markdown']);
    expect(n.warnings.join(' ')).toContain('screenshot');
  });

  it('rejects a request whose formats are all unsupported', () => {
    expect(() => normalizeScrapeRequest({ url: 'https://example.com', formats: ['screenshot'] })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }),
    );
  });

  it('warns about unknown options', () => {
    const n = normalizeScrapeRequest({ url: 'https://example.com', someFutureOption: 1 });
    expect(n.warnings.join(' ')).toContain('someFutureOption');
  });

  it('rejects invalid input with VALIDATION', () => {
    expect(() => normalizeScrapeRequest({ url: 'not a url' })).toThrowError(IceCrawlError);
    expect(() => normalizeScrapeRequest({ url: 'https://x.com', timeout: 5 })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => normalizeScrapeRequest(null)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core`
Expected: FAIL (modules `../src` exports not found).

- [ ] **Step 3: Implement**

`packages/core/src/errors.ts`:
```ts
export const ERROR_STATUS = {
  VALIDATION: 400,
  UNSUPPORTED_OPTION: 400,
  SSRF_BLOCKED: 400,
  UNAUTHORIZED: 401,
  ROBOTS_DISALLOWED: 403,
  NOT_FOUND: 404,
  TIMEOUT: 408,
  NO_ENGINE: 422,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  DNS: 502,
  SSL: 502,
  RESPONSE_TOO_LARGE: 502,
  BLOCKED: 502,
  CAPTCHA: 502,
  LOGIN_WALL: 502,
  EMPTY_CONTENT: 502,
  SOFT_404: 502,
  TRUNCATED: 502,
  UNCERTAIN: 502,
  TARGET_ERROR: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class IceCrawlError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IceCrawlError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
```

`packages/core/src/trust.ts`:
```ts
import type { ErrorCode } from './errors';

export const VERDICTS = [
  'ok',
  'blocked',
  'login_wall',
  'captcha',
  'empty',
  'soft_404',
  'truncated',
  'uncertain',
  'error',
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_ERROR_CODE: Record<Exclude<Verdict, 'ok'>, ErrorCode> = {
  blocked: 'BLOCKED',
  login_wall: 'LOGIN_WALL',
  captcha: 'CAPTCHA',
  empty: 'EMPTY_CONTENT',
  soft_404: 'SOFT_404',
  truncated: 'TRUNCATED',
  uncertain: 'UNCERTAIN',
  error: 'TARGET_ERROR',
};

export interface TrustBlock {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  receiptId: string;
  engine: string;
}

export interface EngineAttempt {
  engine: string;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  statusCode?: number;
  durationMs: number;
  error?: string;
}

export interface Receipt {
  version: 1;
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  fetchedAt: string;
  engineChain: EngineAttempt[];
  htmlSha256: string | null;
  outputSha256: string | null;
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}
```

`packages/core/src/scrape.ts`:
```ts
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
```

`packages/core/src/index.ts`:
```ts
export * from './errors';
export * from './trust';
export * from './scrape';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: all core tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): error taxonomy, trust types and scrape request schema" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `trust`: verdict classifier

**Files:**
- Create: `packages/trust/src/classify.ts`
- Modify: `packages/trust/src/index.ts`
- Test: `packages/trust/test/classify.test.ts`

**Interfaces:**
- Consumes: `Verdict` from `@icecrawl/core`.
- Produces: `interface ClassifyInput { statusCode: number; headers: Record<string,string> /* lowercase keys */; html: string; markdown: string; truncated?: boolean; unsupportedContentType?: string }`, `interface Classification { verdict: Verdict; confidence: number; reasons: string[] }`, `classify(input: ClassifyInput): Classification`.

- [ ] **Step 1: Write the failing test**

`packages/trust/test/classify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { classify, type ClassifyInput } from '../src';

const longText = 'This is real article content about a real topic. '.repeat(30);

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    statusCode: 200,
    headers: {},
    html: `<html><head><title>A Real Page</title></head><body><p>${longText}</p></body></html>`,
    markdown: longText,
    ...over,
  };
}

describe('classify', () => {
  it('accepts a normal page with high confidence', () => {
    const c = classify(input({}));
    expect(c.verdict).toBe('ok');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    ['429 is blocked', { statusCode: 429 }, 'blocked', 'http_429'],
    ['403 is blocked', { statusCode: 403 }, 'blocked', 'http_403'],
    ['401 is login_wall', { statusCode: 401 }, 'login_wall', 'http_401'],
    ['404 is error', { statusCode: 404 }, 'error', 'http_404'],
    ['503 is error', { statusCode: 503 }, 'error', 'http_503'],
    ['cloudflare challenge header', { headers: { 'cf-mitigated': 'challenge' } }, 'blocked', 'cf_mitigated_challenge'],
    ['truncated body', { truncated: true }, 'truncated', 'body_shorter_than_content_length'],
    ['binary content type', { unsupportedContentType: 'application/zip' }, 'error', 'unsupported_content_type:application/zip'],
  ] as const)('%s', (_name, over, verdict, reason) => {
    const c = classify(input(over as Partial<ClassifyInput>));
    expect(c.verdict).toBe(verdict);
    expect(c.reasons).toContain(reason);
  });

  it('flags a "Just a moment..." challenge page as blocked', () => {
    const c = classify(
      input({ html: '<html><head><title>Just a moment...</title></head><body>x</body></html>', markdown: 'Checking' }),
    );
    expect(c.verdict).toBe('blocked');
  });

  it('flags a short page with a reCAPTCHA widget as captcha', () => {
    const c = classify(
      input({
        html: '<html><body><div class="g-recaptcha" data-sitekey="k"></div></body></html>',
        markdown: 'Please confirm',
      }),
    );
    expect(c.verdict).toBe('captcha');
    expect(c.reasons[0]).toContain('g-recaptcha');
  });

  it('does not flag a long page that merely embeds a captcha widget', () => {
    const c = classify(input({ html: `<html><body><div class="h-captcha"></div><p>${longText}</p></body></html>` }));
    expect(c.verdict).toBe('ok');
  });

  it('flags "verify you are human" text on a short page as captcha', () => {
    const c = classify(input({ html: '<html><body>x</body></html>', markdown: 'Please verify you are human to continue.' }));
    expect(c.verdict).toBe('captcha');
  });

  it('flags a JavaScript-required shell as empty', () => {
    const c = classify(
      input({ html: '<html><body><noscript>Please enable JavaScript to continue.</noscript></body></html>', markdown: 'Please enable JavaScript to continue.' }),
    );
    expect(c.verdict).toBe('empty');
    expect(c.reasons).toContain('js_required');
  });

  it('flags a password form without content as login_wall', () => {
    const c = classify(
      input({
        html: '<html><body><form><input type="password" name="p"></form></body></html>',
        markdown: 'Sign in to your account to continue reading.',
      }),
    );
    expect(c.verdict).toBe('login_wall');
  });

  it('flags a near-empty page as empty', () => {
    expect(classify(input({ markdown: '   hi  ' })).verdict).toBe('empty');
  });

  it('flags a 200 page that says "Page not found" as soft_404', () => {
    const c = classify(
      input({
        html: '<html><head><title>Page not found</title></head><body><h1>Page not found</h1></body></html>',
        markdown: '# Page not found\n\nSorry, we could not find that page. Try the home page instead.',
      }),
    );
    expect(c.verdict).toBe('soft_404');
  });

  it('does not call a long article that mentions "not found" a soft 404', () => {
    const c = classify(input({ markdown: `${longText} The file was not found. ${longText}${longText}` }));
    expect(c.verdict).toBe('ok');
  });

  it('flags a huge document with almost no text as uncertain', () => {
    const c = classify(
      input({
        html: `<html><body><p>This page has some text.</p><!--${'x'.repeat(60000)}--></body></html>`,
        markdown: 'This page has some text.',
      }),
    );
    expect(c.verdict).toBe('uncertain');
  });

  it('lowers confidence for short but valid pages', () => {
    const c = classify(input({ markdown: 'A short but legitimate page with some words in it.' }));
    expect(c.verdict).toBe('ok');
    expect(c.confidence).toBeLessThan(0.9);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/trust/test/classify.test.ts`
Expected: FAIL (`classify` not exported).

- [ ] **Step 3: Implement**

`packages/trust/src/classify.ts`:
```ts
import type { Verdict } from '@icecrawl/core';

export interface ClassifyInput {
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  markdown: string;
  truncated?: boolean;
  unsupportedContentType?: string;
}

export interface Classification {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
}

const CAPTCHA_MARKERS = [
  'g-recaptcha',
  'h-captcha',
  'hcaptcha.com',
  'cf-turnstile',
  'challenges.cloudflare.com',
  'px-captcha',
  'geo.captcha-delivery.com',
];
const CHALLENGE_TITLE =
  /^(just a moment|attention required|access denied|are you a robot|verify you are human|pardon our interruption|one more step)/i;
const JS_REQUIRED = /(enable javascript|javascript is (required|disabled)|requires javascript|turn on javascript)/i;
const NOT_FOUND = /\b(404|page not found|not found|doesn'?t exist|does not exist|no longer available)\b/i;

const result = (verdict: Verdict, confidence: number, ...reasons: string[]): Classification => ({
  verdict,
  confidence,
  reasons,
});

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function firstHeading(markdown: string): string {
  const m = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : '';
}

export function classify(i: ClassifyInput): Classification {
  if (i.unsupportedContentType) {
    return result('error', 0.95, `unsupported_content_type:${i.unsupportedContentType}`);
  }
  if (i.truncated) return result('truncated', 0.9, 'body_shorter_than_content_length');

  const status = i.statusCode;
  if (i.headers['cf-mitigated'] === 'challenge') return result('blocked', 0.98, 'cf_mitigated_challenge');
  if (status === 401) return result('login_wall', 0.9, 'http_401');
  if (status === 429) return result('blocked', 0.95, 'http_429');
  if (status === 403) return result('blocked', 0.85, 'http_403');
  if (status >= 400) return result('error', 0.95, `http_${status}`);

  const lowerHtml = i.html.toLowerCase();
  const text = i.markdown.trim();
  const len = text.length;
  const title = titleOf(i.html);

  if (CHALLENGE_TITLE.test(title)) return result('blocked', 0.95, `challenge_title:${title.toLowerCase()}`);

  const marker = CAPTCHA_MARKERS.find((m) => lowerHtml.includes(m));
  if (marker && len < 800) return result('captcha', 0.95, `captcha_widget:${marker}`);
  if (/verify you are human|checking your browser/i.test(text) && len < 800) {
    return result('captcha', 0.9, 'human_verification_text');
  }

  if (JS_REQUIRED.test(i.html) && len < 300) return result('empty', 0.85, 'js_required');
  if (/<input[^>]+type=["']?password/i.test(i.html) && len < 600) {
    return result('login_wall', 0.85, 'password_form_without_content');
  }
  if (len < 20) return result('empty', 0.9, 'no_text_content');

  if ((NOT_FOUND.test(title) || NOT_FOUND.test(firstHeading(text))) && len < 1500) {
    return result('soft_404', 0.8, 'not_found_wording_on_short_page');
  }
  if (i.html.length > 50_000 && len < 200) return result('uncertain', 0.6, 'low_text_ratio');

  return result('ok', len >= 500 ? 0.95 : 0.8);
}
```

`packages/trust/src/index.ts`:
```ts
export * from './classify';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/trust && pnpm typecheck`
Expected: all classify tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(trust): rule-based verdict classifier" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `trust`: receipt v1

**Files:**
- Create: `packages/trust/src/receipt.ts`
- Modify: `packages/trust/src/index.ts`
- Test: `packages/trust/test/receipt.test.ts`

**Interfaces:**
- Consumes: `Receipt`, `EngineAttempt` from `@icecrawl/core`.
- Produces: `sha256Hex(data: string | Uint8Array): string`, `interface ReceiptInput`, `buildReceipt(input: ReceiptInput): Receipt`, `checkStoredHashes(receipt: Receipt, htmlBytes: Uint8Array | null, markdown: string | null): { html: boolean; output: boolean }`.

- [ ] **Step 1: Write the failing test**

`packages/trust/test/receipt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildReceipt, checkStoredHashes, sha256Hex } from '../src';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  statusCode: 200,
  fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
  engineChain: [{ engine: 'fetch', verdict: 'ok' as const, confidence: 0.95, reasons: [], durationMs: 12 }],
  htmlBytes: Buffer.from('<html>hi</html>'),
  markdown: 'hi',
  converter: { name: 'icecrawl-convert', version: '1' },
  options: { onlyMainContent: true, skipTlsVerification: true },
};

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildReceipt', () => {
  it('records hashes, chain and timestamps', () => {
    const r = buildReceipt(base);
    expect(r.version).toBe(1);
    expect(r.id).toBe(base.id);
    expect(r.fetchedAt).toBe('2026-10-24T10:00:00.000Z');
    expect(r.htmlSha256).toBe(sha256Hex(base.htmlBytes));
    expect(r.outputSha256).toBe(sha256Hex('hi'));
    expect(r.engineChain).toHaveLength(1);
    expect(r.options.skipTlsVerification).toBe(true);
  });

  it('uses null hashes when there is no body or output', () => {
    const r = buildReceipt({ ...base, htmlBytes: null, markdown: null });
    expect(r.htmlSha256).toBeNull();
    expect(r.outputSha256).toBeNull();
  });
});

describe('checkStoredHashes', () => {
  it('passes for untouched data and fails after a one-byte change', () => {
    const r = buildReceipt(base);
    expect(checkStoredHashes(r, base.htmlBytes, 'hi')).toEqual({ html: true, output: true });
    const tampered = Buffer.from('<html>hj</html>');
    expect(checkStoredHashes(r, tampered, 'hi').html).toBe(false);
    expect(checkStoredHashes(r, base.htmlBytes, 'hI').output).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/trust/test/receipt.test.ts`
Expected: FAIL (`buildReceipt` not exported).

- [ ] **Step 3: Implement**

`packages/trust/src/receipt.ts`:
```ts
import { createHash } from 'node:crypto';
import type { EngineAttempt, Receipt } from '@icecrawl/core';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ReceiptInput {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  fetchedAt: Date;
  engineChain: EngineAttempt[];
  htmlBytes: Uint8Array | null;
  markdown: string | null;
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}

export function buildReceipt(i: ReceiptInput): Receipt {
  return {
    version: 1,
    id: i.id,
    requestedUrl: i.requestedUrl,
    finalUrl: i.finalUrl,
    statusCode: i.statusCode,
    fetchedAt: i.fetchedAt.toISOString(),
    engineChain: i.engineChain,
    htmlSha256: i.htmlBytes ? sha256Hex(i.htmlBytes) : null,
    outputSha256: i.markdown !== null ? sha256Hex(i.markdown) : null,
    converter: i.converter,
    options: i.options,
  };
}

export function checkStoredHashes(
  receipt: Receipt,
  htmlBytes: Uint8Array | null,
  markdown: string | null,
): { html: boolean; output: boolean } {
  return {
    html: htmlBytes !== null && receipt.htmlSha256 === sha256Hex(htmlBytes),
    output: markdown !== null && receipt.outputSha256 === sha256Hex(markdown),
  };
}
```

`packages/trust/src/index.ts`:
```ts
export * from './classify';
export * from './receipt';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/trust && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(trust): receipt v1 builder and hash checks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `engines`: types, flags, picker

**Files:**
- Create: `packages/engines/src/flags.ts`, `packages/engines/src/types.ts`, `packages/engines/src/picker.ts`
- Modify: `packages/engines/src/index.ts`
- Test: `packages/engines/test/picker.test.ts`

**Interfaces:**
- Produces:
  - `FEATURE_FLAG_PRIORITY`, `type FeatureFlag`, `featureSet(on: FeatureFlag[]): Record<FeatureFlag, boolean>`.
  - `interface EngineContext { url; headers: Record<string,string>; timeoutMs: number; skipTlsVerification: boolean; allowPrivateNetworks: boolean; maxBytes: number }`.
  - `interface EngineResult { finalUrl; statusCode: number; headers: Record<string,string>; body: Uint8Array; contentType: string; truncated: boolean }`.
  - `interface Engine { name; quality: number; features: Record<FeatureFlag, boolean>; maxReasonableTimeMs: number; scrape(ctx: EngineContext): Promise<EngineResult> }`.
  - `interface PickedEngine { engine: Engine; supportScore: number; unsupported: Set<FeatureFlag> }`, `pickEngines(flags: ReadonlySet<FeatureFlag>, registry: readonly Engine[]): PickedEngine[]`.

- [ ] **Step 1: Write the failing test**

`packages/engines/test/picker.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { featureSet, pickEngines, type Engine, type FeatureFlag } from '../src';

const fake = (name: string, quality: number, on: FeatureFlag[]): Engine => ({
  name,
  quality,
  features: featureSet(on),
  maxReasonableTimeMs: 1000,
  scrape: async () => {
    throw new Error('unused');
  },
});

const fetchE = fake('fetch', 5, ['skipTlsVerification']);
const browser = fake('browser', 20, ['skipTlsVerification', 'waitFor', 'actions']);
const pdf = fake('pdf', -20, ['pdf', 'skipTlsVerification']);
const names = (flags: FeatureFlag[], reg: Engine[]) => pickEngines(new Set(flags), reg).map((p) => p.engine.name);

describe('pickEngines', () => {
  it('orders equal-score engines by quality', () => {
    expect(names(['skipTlsVerification'], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });

  it('prefers the engine supporting more flag priority', () => {
    expect(names(['waitFor', 'skipTlsVerification'], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });

  it('keeps a lesser engine when the soft flag is unsupported and reports it', () => {
    const [p] = pickEngines(new Set<FeatureFlag>(['waitFor', 'skipTlsVerification']), [fetchE]);
    expect(p.engine.name).toBe('fetch');
    expect([...p.unsupported]).toEqual(['waitFor']);
  });

  it('returns nothing when a heavy flag (actions) is unsupported by every engine', () => {
    expect(names(['actions', 'skipTlsVerification'], [fetchE])).toEqual([]);
  });

  it('routes actions to the engine that supports them', () => {
    expect(names(['actions', 'skipTlsVerification'], [fetchE, browser])).toEqual(['browser']);
  });

  it('routes a pdf request to the pdf engine only', () => {
    expect(names(['pdf', 'skipTlsVerification'], [fetchE, browser, pdf])).toEqual(['pdf']);
  });

  it('drops negative-quality engines when a positive one qualifies', () => {
    const stealthish = fake('stealth', -2, ['skipTlsVerification']);
    expect(names(['skipTlsVerification'], [fetchE, stealthish])).toEqual(['fetch']);
  });

  it('keeps every engine when no flag is set', () => {
    expect(names([], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/engines/test/picker.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`packages/engines/src/flags.ts`:
```ts
export const FEATURE_FLAG_PRIORITY = {
  actions: 20,
  waitFor: 1,
  screenshot: 10,
  'screenshot@fullScreen': 10,
  pdf: 100,
  document: 100,
  location: 10,
  mobile: 10,
  skipTlsVerification: 10,
  stealthProxy: 20,
  disableAdblock: 10,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAG_PRIORITY;

export function featureSet(on: FeatureFlag[]): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>;
  for (const flag of Object.keys(FEATURE_FLAG_PRIORITY) as FeatureFlag[]) out[flag] = on.includes(flag);
  return out;
}
```

`packages/engines/src/types.ts`:
```ts
import type { FeatureFlag } from './flags';

export interface EngineContext {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  skipTlsVerification: boolean;
  allowPrivateNetworks: boolean;
  maxBytes: number;
}

export interface EngineResult {
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
  truncated: boolean;
}

export interface Engine {
  name: string;
  quality: number;
  features: Record<FeatureFlag, boolean>;
  maxReasonableTimeMs: number;
  scrape(ctx: EngineContext): Promise<EngineResult>;
}
```

`packages/engines/src/picker.ts`:
```ts
import { FEATURE_FLAG_PRIORITY, type FeatureFlag } from './flags';
import type { Engine } from './types';

export interface PickedEngine {
  engine: Engine;
  supportScore: number;
  unsupported: Set<FeatureFlag>;
}

export function pickEngines(flags: ReadonlySet<FeatureFlag>, registry: readonly Engine[]): PickedEngine[] {
  const active = [...flags];
  const prioritySum = active.reduce((sum, f) => sum + FEATURE_FLAG_PRIORITY[f], 0);
  const threshold = Math.floor(prioritySum / 2);

  let picked: PickedEngine[] = registry
    .map((engine) => ({
      engine,
      supportScore: active.filter((f) => engine.features[f]).reduce((s, f) => s + FEATURE_FLAG_PRIORITY[f], 0),
      unsupported: new Set(active.filter((f) => !engine.features[f])),
    }))
    .filter((p) => p.supportScore >= threshold);

  if (picked.some((p) => p.engine.quality > 0)) picked = picked.filter((p) => p.engine.quality > 0);

  return picked.sort((a, b) => b.supportScore - a.supportScore || b.engine.quality - a.engine.quality);
}
```

`packages/engines/src/index.ts`:
```ts
export * from './flags';
export * from './types';
export * from './picker';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/engines && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engines): engine types, feature flags and picker" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `engines`: SSRF guard and `fetch` engine

**Files:**
- Create: `packages/engines/src/ssrf.ts`, `packages/engines/src/fetch.ts`
- Modify: `packages/engines/src/index.ts`
- Test: `packages/engines/test/ssrf.test.ts`, `packages/engines/test/fetch.test.ts`

**Interfaces:**
- Consumes: `IceCrawlError` (core); `Engine`, `EngineContext`, `EngineResult`, `featureSet` (Task 5).
- Produces:
  - `isPrivateAddress(ip: string): boolean`, `assertUrlAllowed(raw: string, allowPrivate: boolean): URL`, `createSafeLookup(allowPrivate: boolean, resolver?: typeof dns.lookup)`.
  - `fetchEngine: Engine` (name `fetch`, quality 5, features `skipTlsVerification` only), `USER_AGENT`.
  - Throws `IceCrawlError` with codes `SSRF_BLOCKED`, `VALIDATION`, `TIMEOUT`, `DNS`, `SSL`, `RESPONSE_TOO_LARGE`, `TARGET_ERROR`.

- [ ] **Step 1: Write the failing SSRF tests**

`packages/engines/test/ssrf.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IceCrawlError } from '@icecrawl/core';
import { assertUrlAllowed, createSafeLookup, isPrivateAddress } from '../src';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:7f00:1', '::ffff:10.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it('fails closed on garbage', () => expect(isPrivateAddress('not-an-ip')).toBe(true));
});

describe('assertUrlAllowed', () => {
  it('rejects non-http schemes with VALIDATION', () => {
    expect(() => assertUrlAllowed('ftp://example.com/x', false)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => assertUrlAllowed('file:///etc/passwd', true)).toThrowError(IceCrawlError);
  });

  it('rejects private IP literals, localhost and decimal-encoded IPs unless allowed', () => {
    for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://2130706433/', 'http://169.254.169.254/latest']) {
      expect(() => assertUrlAllowed(u, false)).toThrowError(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
      expect(() => assertUrlAllowed(u, true)).not.toThrow();
    }
  });

  it('accepts public hosts', () => {
    expect(assertUrlAllowed('https://example.com/a?b=1', false).hostname).toBe('example.com');
  });

  it('rejects embedded credentials', () => {
    expect(() => assertUrlAllowed('https://user:pw@example.com/', false)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});

describe('createSafeLookup', () => {
  const resolver = (addrs: { address: string; family: number }[]) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: unknown) => void) => cb(null, addrs)) as never;

  it('blocks a hostname that resolves to a private address (DNS rebinding)', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '10.0.0.5', family: 4 }]));
    const err = await new Promise<unknown>((res) => lookup('evil.test', {}, (e: unknown) => res(e)));
    expect(err).toBeInstanceOf(IceCrawlError);
    expect((err as IceCrawlError).code).toBe('SSRF_BLOCKED');
  });

  it('returns an address array when options.all is set and the host is public', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '93.184.216.34', family: 4 }]));
    const out = await new Promise<unknown>((res) => lookup('ok.test', { all: true }, (_e: unknown, a: unknown) => res(a)));
    expect(out).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns a single address when options.all is not set', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '93.184.216.34', family: 4 }]));
    const out = await new Promise<unknown[]>((res) => lookup('ok.test', {}, (_e: unknown, a: unknown, f: unknown) => res([a, f])));
    expect(out).toEqual(['93.184.216.34', 4]);
  });

  it('allows private addresses when allowPrivate is true', async () => {
    const lookup = createSafeLookup(true, resolver([{ address: '127.0.0.1', family: 4 }]));
    const out = await new Promise<unknown>((res) => lookup('local.test', { all: true }, (_e: unknown, a: unknown) => res(a)));
    expect(out).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/engines/test/ssrf.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement the SSRF guard**

`packages/engines/src/ssrf.ts`:
```ts
import dns from 'node:dns';
import { isIP } from 'node:net';
import { IceCrawlError } from '@icecrawl/core';

function isPrivateV4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (embedded) {
    const p = embedded[1].split('.').map(Number);
    s = `${s.slice(0, -embedded[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip.split('.').map(Number));
  if (family === 6) {
    const g = expandIPv6(ip);
    if (!g) return true;
    if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true; // :: and ::1
    if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
      return isPrivateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // v4-mapped
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
  }
  return true; // not an IP: fail closed
}

export function assertUrlAllowed(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IceCrawlError('VALIDATION', `Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IceCrawlError('VALIDATION', 'Only http and https URLs are supported');
  }
  if (url.username || url.password) {
    throw new IceCrawlError('VALIDATION', 'URLs with embedded credentials are not supported');
  }
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const blocked =
      host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isPrivateAddress(host));
    if (blocked) throw new IceCrawlError('SSRF_BLOCKED', `Blocked request to a private address: ${host}`);
  }
  return url;
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;

export function createSafeLookup(allowPrivate: boolean, resolver: typeof dns.lookup = dns.lookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    (resolver as (h: string, o: dns.LookupOptions, cb: (e: Error | null, a: dns.LookupAddress[]) => void) => void)(
      hostname,
      { ...options, all: true },
      (err, addresses) => {
        if (err) return callback(err);
        if (!allowPrivate) {
          const bad = addresses.find((a) => isPrivateAddress(a.address));
          if (bad) {
            return callback(new IceCrawlError('SSRF_BLOCKED', `Host ${hostname} resolves to a private address ${bad.address}`));
          }
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      },
    );
  };
}
```

- [ ] **Step 4: Run SSRF tests**

Run: `pnpm vitest run packages/engines/test/ssrf.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing fetch-engine tests**

`packages/engines/test/fetch.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine, type EngineContext } from '../src';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-echo-ua': String(req.headers['user-agent']) });
        res.end('<html><body>hello</body></html>');
        break;
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        res.end();
        break;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        break;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(gzipSync('<html>zipped</html>'));
        break;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
        break;
      case '/trunc':
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': '1000' });
        res.write('<html>partial');
        setTimeout(() => res.socket?.destroy(), 20);
        break;
      case '/404':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>nope</html>');
        break;
      case '/hang':
        break; // never respond
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const ctx = (path: string, over: Partial<EngineContext> = {}): EngineContext => ({
  url: `http://127.0.0.1:${port}${path}`,
  headers: {},
  timeoutMs: 2000,
  skipTlsVerification: true,
  allowPrivateNetworks: true,
  maxBytes: 100_000,
  ...over,
});

describe('fetchEngine', () => {
  it('fetches a page and reports status, headers and content type', async () => {
    const r = await fetchEngine.scrape(ctx('/ok'));
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.body).toString()).toContain('hello');
    expect(r.contentType).toContain('text/html');
    expect(r.headers['x-echo-ua']).toContain('IceCrawl');
    expect(r.truncated).toBe(false);
  });

  it('follows redirects and reports the final URL', async () => {
    const r = await fetchEngine.scrape(ctx('/redirect'));
    expect(r.finalUrl).toBe(`http://127.0.0.1:${port}/ok`);
  });

  it('gives up on redirect loops', async () => {
    await expect(fetchEngine.scrape(ctx('/loop'))).rejects.toMatchObject({ code: 'TARGET_ERROR' });
  });

  it('decodes gzip bodies', async () => {
    const r = await fetchEngine.scrape(ctx('/gzip'));
    expect(Buffer.from(r.body).toString()).toBe('<html>zipped</html>');
  });

  it('returns non-2xx responses without throwing (the verdict decides)', async () => {
    const r = await fetchEngine.scrape(ctx('/404'));
    expect(r.statusCode).toBe(404);
  });

  it('enforces the response size cap', async () => {
    await expect(fetchEngine.scrape(ctx('/big', { maxBytes: 1000 }))).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('flags a body cut short as truncated', async () => {
    const r = await fetchEngine.scrape(ctx('/trunc'));
    expect(r.truncated).toBe(true);
  });

  it('times out on a server that never answers', async () => {
    await expect(fetchEngine.scrape(ctx('/hang', { timeoutMs: 300 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('blocks private targets by default', async () => {
    await expect(fetchEngine.scrape(ctx('/ok', { allowPrivateNetworks: false }))).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm vitest run packages/engines/test/fetch.test.ts`
Expected: FAIL (`fetchEngine` not exported).

- [ ] **Step 7: Implement the engine**

`packages/engines/src/fetch.ts`:
```ts
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Agent, request } from 'undici';
import { IceCrawlError } from '@icecrawl/core';
import { featureSet } from './flags';
import { assertUrlAllowed, createSafeLookup } from './ssrf';
import type { Engine, EngineContext, EngineResult } from './types';

const MAX_REDIRECTS = 10;
export const USER_AGENT = 'Mozilla/5.0 (compatible; IceCrawl/0.1; +https://github.com/icecrawl/icecrawl)';

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function decode(body: Buffer, encoding: string | undefined, max: number): Buffer {
  const opts = { maxOutputLength: max };
  try {
    switch ((encoding ?? '').trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body, opts);
      case 'deflate':
        return inflateSync(body, opts);
      case 'br':
        return brotliDecompressSync(body, opts);
      default:
        return body;
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new IceCrawlError('RESPONSE_TOO_LARGE', `Decoded response exceeds ${max} bytes`);
    }
    throw err;
  }
}

async function readBody(
  res: { body: AsyncIterable<Buffer> & { destroy(): void } },
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        res.body.destroy();
        throw new IceCrawlError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof IceCrawlError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' || code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
      truncated = true;
    } else {
      throw err;
    }
  }
  return { body: Buffer.concat(chunks), truncated };
}

function mapError(err: unknown): never {
  if (err instanceof IceCrawlError) throw err;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.cause instanceof IceCrawlError) throw e.cause;
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    throw new IceCrawlError('TIMEOUT', 'Timed out fetching the page');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new IceCrawlError('DNS', 'Could not resolve the host');
  if (code && /CERT|TLS|SSL|SELF_SIGNED/i.test(code)) throw new IceCrawlError('SSL', `TLS error: ${code}`);
  throw new IceCrawlError('TARGET_ERROR', e.message ?? 'Fetch failed');
}

async function scrape(ctx: EngineContext): Promise<EngineResult> {
  const agent = new Agent({
    connect: {
      lookup: createSafeLookup(ctx.allowPrivateNetworks) as never,
      rejectUnauthorized: !ctx.skipTlsVerification,
    },
  });
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  try {
    let url = ctx.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertUrlAllowed(url, ctx.allowPrivateNetworks);
      const res = await request(url, {
        method: 'GET',
        dispatcher: agent,
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          ...lowerKeys(ctx.headers),
        },
      });
      const headers = flattenHeaders(res.headers);
      if (res.statusCode >= 300 && res.statusCode < 400 && headers.location) {
        await res.body.dump();
        url = new URL(headers.location, url).toString();
        continue;
      }
      const { body, truncated } = await readBody(res as never, ctx.maxBytes);
      let decoded: Buffer;
      try {
        decoded = decode(body, headers['content-encoding'], ctx.maxBytes);
      } catch (err) {
        if (err instanceof IceCrawlError) throw err;
        if (!truncated) throw new IceCrawlError('TARGET_ERROR', 'Could not decode the response body');
        decoded = Buffer.alloc(0);
      }
      return {
        finalUrl: url,
        statusCode: res.statusCode,
        headers,
        body: decoded,
        contentType: headers['content-type'] ?? '',
        truncated,
      };
    }
    throw new IceCrawlError('TARGET_ERROR', `Too many redirects (more than ${MAX_REDIRECTS})`);
  } catch (err) {
    return mapError(err);
  } finally {
    await agent.close().catch(() => undefined);
  }
}

export const fetchEngine: Engine = {
  name: 'fetch',
  quality: 5,
  features: featureSet(['skipTlsVerification']),
  maxReasonableTimeMs: 15_000,
  scrape,
};
```

`packages/engines/src/index.ts`:
```ts
export * from './flags';
export * from './types';
export * from './picker';
export * from './ssrf';
export * from './fetch';
```

- [ ] **Step 8: Run to verify pass**

Run: `pnpm vitest run packages/engines && pnpm typecheck`
Expected: all engines tests PASS. If the `/trunc` test fails because undici reports a different error code, print `err.code` in `readBody`'s catch, add that code to the truncation list, and re-run; do not weaken the assertion.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(engines): SSRF guard and fetch engine" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `scraper`: flags, body decoding, HTML conversion

**Files:**
- Create: `packages/scraper/src/flags.ts`, `packages/scraper/src/decode.ts`, `packages/scraper/src/convert.ts`
- Test: `packages/scraper/test/flags.test.ts`, `packages/scraper/test/decode.test.ts`, `packages/scraper/test/convert.test.ts`

**Interfaces:**
- Consumes: `ScrapeRequest` (core), `FeatureFlag` (engines).
- Produces:
  - `buildFeatureFlags(request: ScrapeRequest): Set<FeatureFlag>`.
  - `decodeBody(bytes: Uint8Array, contentType: string): string`, `contentKind(contentType: string, bytes: Uint8Array): 'html' | 'text' | 'json' | 'unsupported'`.
  - `CONVERTER = { name: 'icecrawl-convert', version: '1' }`, `interface ConvertOptions { url; onlyMainContent; includeTags?; excludeTags?; removeBase64Images }`, `interface Converted { markdown; cleanHtml; links: string[]; title: string | null; description: string | null; language: string | null }`, `convertHtml(html: string, o: ConvertOptions): Converted`.

- [ ] **Step 1: Write the failing tests**

`packages/scraper/test/flags.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeScrapeRequest } from '@icecrawl/core';
import { buildFeatureFlags } from '../src/flags';

const flags = (input: Record<string, unknown>) =>
  [...buildFeatureFlags(normalizeScrapeRequest({ url: 'https://example.com/page', ...input }).request)].sort();

describe('buildFeatureFlags', () => {
  it('defaults to skipTlsVerification only', () => {
    expect(flags({})).toEqual(['skipTlsVerification']);
  });

  it('adds flags from options', () => {
    expect(flags({ waitFor: 500, mobile: true, actions: [{ type: 'wait' }], proxy: 'enhanced', blockAds: false })).toEqual(
      ['actions', 'disableAdblock', 'mobile', 'skipTlsVerification', 'stealthProxy', 'waitFor'].sort(),
    );
  });

  it('does not add skipTlsVerification when disabled', () => {
    expect(flags({ skipTlsVerification: false })).toEqual([]);
  });

  it('detects pdf and document URLs by path extension', () => {
    expect(flags({ url: 'https://example.com/a.PDF' })).toContain('pdf');
    expect(flags({ url: 'https://example.com/a.docx?x=1' })).toContain('document');
    expect(flags({ url: 'https://example.com/a.html' })).not.toContain('pdf');
  });

  it('detects screenshot formats', () => {
    expect(flags({ formats: ['markdown', { type: 'screenshot' }] })).toContain('screenshot');
    expect(flags({ formats: ['markdown', { type: 'screenshot', fullPage: true }] })).toContain('screenshot@fullScreen');
  });
});
```

`packages/scraper/test/decode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { contentKind, decodeBody } from '../src/decode';

describe('decodeBody', () => {
  it('decodes utf-8 by default', () => {
    expect(decodeBody(Buffer.from('héllo'), 'text/html')).toBe('héllo');
  });

  it('honours the charset in the content type', () => {
    expect(decodeBody(Buffer.from([0x68, 0xe9]), 'text/html; charset=iso-8859-1')).toBe('hé');
  });

  it('falls back to a meta charset', () => {
    const bytes = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), Buffer.from([0xe9])]);
    expect(decodeBody(bytes, 'text/html')).toContain('é');
  });

  it('survives an unknown charset label', () => {
    expect(decodeBody(Buffer.from('ok'), 'text/html; charset=bogus-999')).toBe('ok');
  });
});

describe('contentKind', () => {
  it.each([
    ['text/html; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['application/json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['text/plain', 'text'],
    ['text/xml', 'text'],
    ['application/pdf', 'unsupported'],
    ['image/png', 'unsupported'],
  ] as const)('%s -> %s', (ct, kind) => expect(contentKind(ct, Buffer.from('x'))).toBe(kind));

  it('sniffs a missing content type', () => {
    expect(contentKind('', Buffer.from('  <!doctype html><html>'))).toBe('html');
    expect(contentKind('', Buffer.from('plain words'))).toBe('text');
  });
});
```

`packages/scraper/test/convert.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { convertHtml } from '../src/convert';

const article = `<article><h1>The Big Story</h1>${'<p>This paragraph contains real reporting about an important subject. </p>'.repeat(12)}</article>`;
const page = `<!doctype html><html lang="en"><head>
<title>Example Title</title><meta name="description" content="An example page.">
<script>var secret = 1;</script><style>.x{}</style></head>
<body><nav><a href="/about">About us navigation</a></nav>${article}
<footer><a href="https://other.example/x">Elsewhere</a> <a href="/about">About again</a> <a href="javascript:void(0)">js</a> <a href="mailto:a@b.c">mail</a></footer></body></html>`;

const opts = { url: 'https://example.com/post/1', onlyMainContent: true, removeBase64Images: true };

describe('convertHtml', () => {
  it('extracts metadata', () => {
    const c = convertHtml(page, opts);
    expect(c.title).toBe('Example Title');
    expect(c.description).toBe('An example page.');
    expect(c.language).toBe('en');
  });

  it('keeps main content and drops navigation, scripts and styles when onlyMainContent', () => {
    const c = convertHtml(page, opts);
    expect(c.markdown).toContain('# The Big Story');
    expect(c.markdown).toContain('important subject');
    expect(c.markdown).not.toContain('navigation');
    expect(c.markdown).not.toContain('secret');
  });

  it('keeps navigation when onlyMainContent is false but still drops scripts', () => {
    const c = convertHtml(page, { ...opts, onlyMainContent: false });
    expect(c.markdown).toContain('About us navigation');
    expect(c.markdown).not.toContain('secret');
  });

  it('collects absolute, de-duplicated http(s) links from the whole page', () => {
    const c = convertHtml(page, opts);
    expect(c.links).toEqual(['https://example.com/about', 'https://other.example/x']);
  });

  it('applies excludeTags', () => {
    const c = convertHtml(page, { ...opts, onlyMainContent: false, excludeTags: ['nav'] });
    expect(c.markdown).not.toContain('About us navigation');
  });

  it('applies includeTags exclusively', () => {
    const c = convertHtml(page, { ...opts, includeTags: ['h1'] });
    expect(c.markdown.trim()).toBe('# The Big Story');
  });

  it('falls back to the whole body for short pages', () => {
    const c = convertHtml('<html><body><nav>Menu</nav><p>Tiny page text.</p></body></html>', opts);
    expect(c.markdown).toContain('Tiny page text.');
  });

  it('strips base64 images when asked', () => {
    const html = `<html><body><p>${'text '.repeat(60)}</p><img src="data:image/png;base64,AAAA" alt="x"></body></html>`;
    expect(convertHtml(html, { ...opts, onlyMainContent: false }).markdown).not.toContain('data:image');
  });

  it('does not throw on empty or garbage input', () => {
    expect(() => convertHtml('', opts)).not.toThrow();
    expect(() => convertHtml('<<<not html>>>', opts)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/scraper`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement flags and decode**

`packages/scraper/src/flags.ts`:
```ts
import type { ScrapeRequest } from '@icecrawl/core';
import type { FeatureFlag } from '@icecrawl/engines';

const DOCUMENT_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

export function buildFeatureFlags(request: ScrapeRequest): Set<FeatureFlag> {
  const flags = new Set<FeatureFlag>();
  if (request.actions && request.actions.length > 0) flags.add('actions');
  if (request.waitFor > 0) flags.add('waitFor');
  if (request.mobile) flags.add('mobile');
  if (request.skipTlsVerification) flags.add('skipTlsVerification');
  if (request.proxy === 'enhanced' || request.proxy === 'stealth') flags.add('stealthProxy');
  if (request.blockAds === false) flags.add('disableAdblock');

  for (const f of request.formats) {
    if (typeof f === 'string' ? f === 'screenshot' : f.type === 'screenshot') {
      const full = typeof f !== 'string' && (f as { fullPage?: unknown }).fullPage === true;
      flags.add(full ? 'screenshot@fullScreen' : 'screenshot');
    }
  }

  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // URL was validated upstream; ignore here
  }
  if (DOCUMENT_EXT.test(pathname)) flags.add('document');
  else if (/\.pdf$/i.test(pathname)) flags.add('pdf');

  return flags;
}
```

`packages/scraper/src/decode.ts`:
```ts
function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return m ? m[1] : null;
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  const label = m?.[1] ?? sniffMetaCharset(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export type ContentKind = 'html' | 'text' | 'json' | 'unsupported';

export function contentKind(contentType: string, bytes: Uint8Array): ContentKind {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === '') {
    const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<') ? 'html' : 'text';
  }
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct.startsWith('text/')) return 'text';
  return 'unsupported';
}
```

- [ ] **Step 4: Implement the converter**

`packages/scraper/src/convert.ts`:
```ts
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const CONVERTER = { name: 'icecrawl-convert', version: '1' } as const;

export interface ConvertOptions {
  url: string;
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
}

export interface Converted {
  markdown: string;
  cleanHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.remove(['script', 'style']);

function toMarkdown(html: string, removeBase64: boolean): string {
  let md = turndown.turndown(html);
  if (removeBase64) md = md.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

function absolutize(doc: Document, base: string): void {
  for (const [selector, attr] of [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
    ['source[src]', 'src'],
  ] as const) {
    doc.querySelectorAll(selector).forEach((el) => {
      const value = el.getAttribute(attr);
      if (!value) return;
      try {
        el.setAttribute(attr, new URL(value, base).toString());
      } catch {
        // leave unparseable values alone
      }
    });
  }
}

function collectLinks(doc: Document): string[] {
  const seen = new Set<string>();
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    try {
      const u = new URL(href);
      if (u.protocol === 'http:' || u.protocol === 'https:') seen.add(u.toString());
    } catch {
      // ignore
    }
  });
  return [...seen];
}

function mainContent(doc: Document): string | null {
  try {
    const article = new Readability(doc, { charThreshold: 100 }).parse();
    if (article && (article.textContent ?? '').trim().length >= 200) return article.content ?? null;
  } catch {
    // fall through to the whole body
  }
  return null;
}

export function convertHtml(html: string, o: ConvertOptions): Converted {
  const { document } = parseHTML(html) as unknown as { document: Document };

  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
  const title = document.title?.trim() || meta('meta[property="og:title"]');
  const description = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const language = document.documentElement?.getAttribute('lang') || null;

  document.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  for (const selector of o.excludeTags ?? []) {
    try {
      document.querySelectorAll(selector).forEach((n) => n.remove());
    } catch {
      // ignore invalid selectors
    }
  }
  absolutize(document, o.url);
  const links = collectLinks(document);

  let contentHtml = document.body?.innerHTML ?? '';
  if (o.includeTags && o.includeTags.length > 0) {
    const parts: string[] = [];
    for (const selector of o.includeTags) {
      try {
        document.querySelectorAll(selector).forEach((n) => parts.push(n.outerHTML));
      } catch {
        // ignore invalid selectors
      }
    }
    contentHtml = parts.join('\n');
  } else if (o.onlyMainContent) {
    contentHtml = mainContent(document) ?? contentHtml;
  }

  return { markdown: toMarkdown(contentHtml, o.removeBase64Images), cleanHtml: contentHtml, links, title, description, language };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/scraper && pnpm typecheck`
Expected: PASS. If `new Readability(doc)` throws under linkedom, the `try/catch` returns `null` and the fallback tests still pass; but the "drops navigation" test would then fail. In that case adjust `mainContent` to pass `document.cloneNode(true) as Document` and re-run, keeping the same assertions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(scraper): feature flags, body decoding and HTML to markdown conversion" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `scraper`: pipeline (waterfall + verdict + receipt)

**Files:**
- Create: `packages/scraper/src/pipeline.ts`
- Modify: `packages/scraper/src/index.ts`
- Test: `packages/scraper/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `normalizeScrapeRequest`/`NormalizedScrape`, `IceCrawlError`, `EngineAttempt`, `Receipt`, `Verdict` (core); `pickEngines`, `Engine`, `EngineResult`, `featureSet` (engines); `classify`, `buildReceipt` (trust); `buildFeatureFlags`, `decodeBody`, `contentKind`, `convertHtml`, `CONVERTER` (Task 7).
- Produces:
  - `interface ScraperConfig { allowPrivateNetworks: boolean; maxResponseBytes: number; strict: boolean }`
  - `interface ScrapeDeps { engines: readonly Engine[]; config: ScraperConfig; now?: () => Date }`
  - `interface ScrapeRun { id; requestedUrl; finalUrl; statusCode: number; contentType: string; verdict: Verdict; confidence: number; reasons: string[]; engine: string; accepted: boolean; markdown: string; cleanHtml: string; rawHtml: string; links: string[]; title: string|null; description: string|null; language: string|null; receipt: Receipt; snapshot: { bytes: Uint8Array; sha256: string }; warnings: string[] }`
  - `runScrape(deps: ScrapeDeps, normalized: NormalizedScrape): Promise<ScrapeRun>`; throws `IceCrawlError` (`NO_ENGINE`, or the last engine error when every engine failed without a response, or any fatal code).

- [ ] **Step 1: Write the failing test**

`packages/scraper/test/pipeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, type Engine, type EngineResult } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { runScrape, type ScraperConfig } from '../src';

const article = `<article><h1>Hello world</h1>${'<p>Some real content about things that matter. </p>'.repeat(30)}</article>`;
const okHtml = `<html><head><title>T</title></head><body>${article}</body></html>`;

function reply(html: string, over: Partial<EngineResult> = {}): EngineResult {
  return {
    finalUrl: 'https://example.com/final',
    statusCode: 200,
    headers: {},
    body: Buffer.from(html),
    contentType: 'text/html; charset=utf-8',
    truncated: false,
    ...over,
  };
}

function engine(name: string, quality: number, outcome: EngineResult | Error, calls: string[] = []): Engine {
  return {
    name,
    quality,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async () => {
      calls.push(name);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const config: ScraperConfig = { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false };
const run = (engines: Engine[], input: Record<string, unknown> = {}, cfg = config) =>
  runScrape({ engines, config: cfg }, normalizeScrapeRequest({ url: 'https://example.com/start', ...input }));

describe('runScrape', () => {
  it('accepts a good page and records a receipt whose hashes match', async () => {
    const r = await run([engine('a', 10, reply(okHtml))]);
    expect(r.verdict).toBe('ok');
    expect(r.accepted).toBe(true);
    expect(r.engine).toBe('a');
    expect(r.markdown).toContain('Hello world');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.receipt.id).toBe(r.id);
    expect(r.receipt.htmlSha256).toBe(sha256Hex(Buffer.from(okHtml)));
    expect(r.receipt.outputSha256).toBe(sha256Hex(r.markdown));
    expect(r.snapshot.sha256).toBe(r.receipt.htmlSha256);
    expect(r.receipt.engineChain).toHaveLength(1);
    expect(r.finalUrl).toBe('https://example.com/final');
  });

  it('rejects a captcha page (not accepted) and keeps its receipt', async () => {
    const html = '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>';
    const r = await run([engine('a', 10, reply(html))]);
    expect(r.verdict).toBe('captcha');
    expect(r.accepted).toBe(false);
    expect(r.receipt.engineChain[0].verdict).toBe('captcha');
  });

  it('waterfalls to the next engine when the first is blocked', async () => {
    const calls: string[] = [];
    const r = await run([
      engine('first', 20, reply('<html>denied</html>', { statusCode: 403 }), calls),
      engine('second', 5, reply(okHtml), calls),
    ]);
    expect(calls).toEqual(['first', 'second']);
    expect(r.engine).toBe('second');
    expect(r.accepted).toBe(true);
    expect(r.receipt.engineChain.map((a) => a.verdict)).toEqual(['blocked', 'ok']);
  });

  it('continues after a thrown engine error and records it', async () => {
    const r = await run([
      engine('first', 20, new IceCrawlError('TIMEOUT', 'slow')),
      engine('second', 5, reply(okHtml)),
    ]);
    expect(r.receipt.engineChain[0]).toMatchObject({ engine: 'first', verdict: 'error', reasons: ['TIMEOUT'] });
    expect(r.engine).toBe('second');
  });

  it('throws the last error when every engine fails without a response', async () => {
    await expect(run([engine('a', 10, new IceCrawlError('DNS', 'nx'))])).rejects.toMatchObject({ code: 'DNS' });
  });

  it('rethrows fatal errors immediately without trying other engines', async () => {
    const calls: string[] = [];
    await expect(
      run([engine('a', 20, new IceCrawlError('SSRF_BLOCKED', 'no'), calls), engine('b', 5, reply(okHtml), calls)]),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(calls).toEqual(['a']);
  });

  it('throws NO_ENGINE when no engine supports a required feature', async () => {
    await expect(run([engine('a', 10, reply(okHtml))], { actions: [{ type: 'click', selector: '#x' }] })).rejects.toMatchObject({
      code: 'NO_ENGINE',
    });
  });

  it('warns when the chosen engine ignores a soft option', async () => {
    const r = await run([engine('a', 10, reply(okHtml))], { waitFor: 500 });
    expect(r.warnings.join(' ')).toContain('waitFor');
  });

  it('treats uncertain as success unless strict', async () => {
    const html = `<html><body><p>This page has some text.</p><!--${'x'.repeat(60000)}--></body></html>`;
    const lenient = await run([engine('a', 10, reply(html))]);
    expect(lenient.verdict).toBe('uncertain');
    expect(lenient.accepted).toBe(true);
    const strict = await run([engine('a', 10, reply(html))], {}, { ...config, strict: true });
    expect(strict.accepted).toBe(false);
  });

  it('wraps JSON bodies as a fenced markdown block', async () => {
    const r = await run([engine('a', 10, reply('{"hello":"world","n":[1,2,3]}', { contentType: 'application/json' }))]);
    expect(r.markdown).toContain('```json');
    expect(r.accepted).toBe(true);
  });

  it('marks binary content types as error', async () => {
    const r = await run([engine('a', 10, reply('PK..', { contentType: 'application/zip' }))]);
    expect(r.verdict).toBe('error');
    expect(r.reasons[0]).toContain('unsupported_content_type');
  });

  it('marks a truncated body as truncated', async () => {
    const r = await run([engine('a', 10, reply(okHtml, { truncated: true }))]);
    expect(r.verdict).toBe('truncated');
    expect(r.accepted).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/scraper/test/pipeline.test.ts`
Expected: FAIL (`runScrape` not exported).

- [ ] **Step 3: Implement**

`packages/scraper/src/pipeline.ts`:
```ts
import { randomUUID } from 'node:crypto';
import {
  IceCrawlError,
  type EngineAttempt,
  type ErrorCode,
  type NormalizedScrape,
  type Receipt,
  type Verdict,
} from '@icecrawl/core';
import { pickEngines, type Engine, type EngineResult } from '@icecrawl/engines';
import { buildReceipt, classify, sha256Hex } from '@icecrawl/trust';
import { contentKind, decodeBody } from './decode';
import { CONVERTER, convertHtml } from './convert';
import { buildFeatureFlags } from './flags';

export interface ScraperConfig {
  allowPrivateNetworks: boolean;
  maxResponseBytes: number;
  strict: boolean;
}

export interface ScrapeDeps {
  engines: readonly Engine[];
  config: ScraperConfig;
  now?: () => Date;
}

export interface ScrapeRun {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  engine: string;
  accepted: boolean;
  markdown: string;
  cleanHtml: string;
  rawHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
  receipt: Receipt;
  snapshot: { bytes: Uint8Array; sha256: string };
  warnings: string[];
}

const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'SSRF_BLOCKED',
  'VALIDATION',
  'UNSUPPORTED_OPTION',
  'RESPONSE_TOO_LARGE',
]);

interface Analyzed {
  engine: string;
  result: EngineResult;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  markdown: string;
  cleanHtml: string;
  rawHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
}

function analyze(engine: string, result: EngineResult, n: NormalizedScrape): Analyzed {
  const kind = contentKind(result.contentType, result.body);
  const text = kind === 'unsupported' ? '' : decodeBody(result.body, result.contentType);
  let markdown = '';
  let cleanHtml = '';
  let links: string[] = [];
  let title: string | null = null;
  let description: string | null = null;
  let language: string | null = null;

  if (kind === 'html') {
    const c = convertHtml(text, {
      url: result.finalUrl,
      onlyMainContent: n.request.onlyMainContent,
      includeTags: n.request.includeTags,
      excludeTags: n.request.excludeTags,
      removeBase64Images: n.request.removeBase64Images,
    });
    ({ markdown, cleanHtml, links, title, description, language } = c);
  } else if (kind === 'json') {
    markdown = `\`\`\`json\n${text.trim()}\n\`\`\``;
    cleanHtml = text;
  } else if (kind === 'text') {
    markdown = text.trim();
    cleanHtml = text;
  }

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

export async function runScrape(deps: ScrapeDeps, n: NormalizedScrape): Promise<ScrapeRun> {
  const { request } = n;
  const warnings = [...n.warnings];
  const flags = buildFeatureFlags(request);
  const picks = pickEngines(flags, deps.engines);
  if (picks.length === 0) {
    throw new IceCrawlError('NO_ENGINE', `No available engine supports: ${[...flags].join(', ')}`);
  }

  const ignored = [...picks[0].unsupported].filter((f) => !f.startsWith('screenshot'));
  if (ignored.length > 0) {
    warnings.push(`Engine "${picks[0].engine.name}" does not support: ${ignored.join(', ')}; those options were ignored.`);
  }

  const attempts: EngineAttempt[] = [];
  let last: Analyzed | null = null;
  let lastError: IceCrawlError | null = null;

  for (const pick of picks) {
    const started = Date.now();
    let result: EngineResult;
    try {
      result = await pick.engine.scrape({
        url: request.url,
        headers: request.headers ?? {},
        timeoutMs: request.timeout,
        skipTlsVerification: request.skipTlsVerification,
        allowPrivateNetworks: deps.config.allowPrivateNetworks,
        maxBytes: deps.config.maxResponseBytes,
      });
    } catch (err) {
      const e = err instanceof IceCrawlError ? err : new IceCrawlError('TARGET_ERROR', String(err));
      if (FATAL.has(e.code)) throw e;
      attempts.push({
        engine: pick.engine.name,
        verdict: 'error',
        confidence: 1,
        reasons: [e.code],
        durationMs: Date.now() - started,
        error: e.message,
      });
      lastError = e;
      continue;
    }

    const analyzed = analyze(pick.engine.name, result, n);
    attempts.push({
      engine: analyzed.engine,
      verdict: analyzed.verdict,
      confidence: analyzed.confidence,
      reasons: analyzed.reasons,
      statusCode: result.statusCode,
      durationMs: Date.now() - started,
    });
    last = analyzed;
    if (analyzed.verdict === 'ok' || (analyzed.verdict === 'uncertain' && !deps.config.strict)) break;
  }

  if (!last) throw lastError ?? new IceCrawlError('NO_ENGINE', 'No engine produced a result');

  const id = randomUUID();
  const receipt = buildReceipt({
    id,
    requestedUrl: request.url,
    finalUrl: last.result.finalUrl,
    statusCode: last.result.statusCode,
    fetchedAt: (deps.now ?? (() => new Date()))(),
    engineChain: attempts,
    htmlBytes: last.result.body,
    markdown: last.markdown,
    converter: CONVERTER,
    options: { onlyMainContent: request.onlyMainContent, skipTlsVerification: request.skipTlsVerification },
  });

  return {
    id,
    requestedUrl: request.url,
    finalUrl: last.result.finalUrl,
    statusCode: last.result.statusCode,
    contentType: last.result.contentType,
    verdict: last.verdict,
    confidence: last.confidence,
    reasons: last.reasons,
    engine: last.engine,
    accepted: last.verdict === 'ok' || (last.verdict === 'uncertain' && !deps.config.strict),
    markdown: last.markdown,
    cleanHtml: last.cleanHtml,
    rawHtml: last.rawHtml,
    links: last.links,
    title: last.title,
    description: last.description,
    language: last.language,
    receipt,
    snapshot: { bytes: last.result.body, sha256: sha256Hex(last.result.body) },
    warnings,
  };
}
```

`packages/scraper/src/index.ts`:
```ts
export * from './flags';
export * from './decode';
export * from './convert';
export * from './pipeline';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/scraper && pnpm typecheck`
Expected: all scraper tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scraper): scrape pipeline with waterfall, verdicts and receipts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `api`: store layer (memory + Postgres), migrations, snapshots

**Files:**
- Create: `packages/api/migrations/001_init.sql`, `packages/api/src/store/{types,memory,pg,migrate,snapshots}.ts`, `packages/api/src/cli/migrate.ts`, `packages/api/src/config.ts`
- Test: `packages/api/test/store.contract.ts`, `packages/api/test/store.memory.test.ts`, `packages/api/test/store.pg.test.ts`, `packages/api/test/snapshots.test.ts`

**Interfaces:**
- Consumes: `Receipt`, `Verdict` (core).
- Produces:
  - `interface ApiKeyRow { id; name; revoked: boolean }`
  - `interface ScrapeRecord { id; apiKeyId: string | null; url; finalUrl; verdict: Verdict; confidence: number; engine: string | null; statusCode: number | null; markdown: string | null; metadata: Record<string, unknown>; response: Record<string, unknown>; createdAt: string }`
  - `interface SnapshotMeta { sha256: string; key: string; bytes: number }`
  - `interface Store { findApiKeyByHash(hash): Promise<ApiKeyRow | null>; createApiKey(k: {id; hash; name}): Promise<void>; revokeApiKey(id): Promise<void>; saveScrape(rec: ScrapeRecord, receipt: Receipt, snapshot: SnapshotMeta | null): Promise<void>; getScrape(id): Promise<ScrapeRecord | null>; getReceipt(id): Promise<Receipt | null>; close(): Promise<void> }`
  - `interface SnapshotStore { put(bytes: Uint8Array): Promise<SnapshotMeta>; get(key: string): Promise<Uint8Array | null> }`
  - `MemoryStore`, `MemorySnapshotStore`, `PgStore(sql)`, `FileSnapshotStore(dir)`, `createSql(url)`, `migrate(sql, dir?)`, `loadConfig(env?)`.

- [ ] **Step 1: Write the shared contract test and the memory/snapshot tests**

`packages/api/test/store.contract.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
import type { ScrapeRecord, Store } from '../src/store/types';

export function sampleReceipt(id: string): Receipt {
  return {
    version: 1,
    id,
    requestedUrl: 'https://example.com/a',
    finalUrl: 'https://example.com/b',
    statusCode: 200,
    fetchedAt: '2026-10-24T10:00:00.000Z',
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.95, reasons: [], durationMs: 5 }],
    htmlSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    converter: { name: 'icecrawl-convert', version: '1' },
    options: { onlyMainContent: true, skipTlsVerification: true },
  };
}

export function sampleScrape(id: string, apiKeyId: string | null): ScrapeRecord {
  return {
    id,
    apiKeyId,
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/b',
    verdict: 'ok',
    confidence: 0.95,
    engine: 'fetch',
    statusCode: 200,
    markdown: '# hi',
    metadata: { title: 'T' },
    response: { success: true, data: { markdown: '# hi' } },
    createdAt: new Date().toISOString(),
  };
}

export function describeStoreContract(name: string, make: () => Promise<Store>) {
  describe(`${name} store contract`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
    });

    it('finds an API key by hash and reports revocation', async () => {
      const id = randomUUID();
      await store.createApiKey({ id, hash: `hash-${id}`, name: 'dev' });
      expect(await store.findApiKeyByHash(`hash-${id}`)).toEqual({ id, name: 'dev', revoked: false });
      await store.revokeApiKey(id);
      expect((await store.findApiKeyByHash(`hash-${id}`))?.revoked).toBe(true);
      expect(await store.findApiKeyByHash('missing')).toBeNull();
    });

    it('round-trips a scrape, its receipt and snapshot metadata', async () => {
      const keyId = randomUUID();
      await store.createApiKey({ id: keyId, hash: `h-${keyId}`, name: 'k' });
      const id = randomUUID();
      const rec = sampleScrape(id, keyId);
      await store.saveScrape(rec, sampleReceipt(id), { sha256: 'a'.repeat(64), key: 'aa/aaa', bytes: 42 });
      const got = await store.getScrape(id);
      expect(got).toMatchObject({ id, apiKeyId: keyId, verdict: 'ok', engine: 'fetch', statusCode: 200, markdown: '# hi' });
      expect(got?.response).toEqual(rec.response);
      expect(got?.metadata).toEqual({ title: 'T' });
      expect(await store.getReceipt(id)).toEqual(sampleReceipt(id));
    });

    it('stores a scrape without a snapshot or key', async () => {
      const id = randomUUID();
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null);
      expect((await store.getScrape(id))?.apiKeyId).toBeNull();
    });

    it('returns null for unknown ids', async () => {
      expect(await store.getScrape(randomUUID())).toBeNull();
      expect(await store.getReceipt(randomUUID())).toBeNull();
    });
  });
}
```

`packages/api/test/store.memory.test.ts`:
```ts
import { MemoryStore } from '../src/store/memory';
import { describeStoreContract } from './store.contract';

describeStoreContract('memory', async () => new MemoryStore());
```

`packages/api/test/store.pg.test.ts`:
```ts
import { afterAll, describe } from 'vitest';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { describeStoreContract } from './store.contract';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('postgres', () => {
  const sql = createSql(url ?? 'postgres://unused');
  afterAll(async () => {
    await sql.end();
  });
  describeStoreContract('postgres', async () => {
    await migrate(sql);
    await sql`truncate receipts, snapshots, scrapes, api_keys cascade`;
    return new PgStore(sql);
  });
});
```

`packages/api/test/snapshots.test.ts`:
```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { FileSnapshotStore } from '../src/store/snapshots';

describe('FileSnapshotStore', () => {
  const dirs: string[] = [];
  const make = async () => {
    const d = await mkdtemp(join(tmpdir(), 'icecrawl-snap-'));
    dirs.push(d);
    return { dir: d, store: new FileSnapshotStore(d) };
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('stores bytes by SHA-256 and reads them back', async () => {
    const { store } = await make();
    const bytes = Buffer.from('<html>snapshot</html>');
    const meta = await store.put(bytes);
    expect(meta.sha256).toBe(sha256Hex(bytes));
    expect(meta.bytes).toBe(bytes.length);
    expect(Buffer.from((await store.get(meta.key))!).toString()).toBe('<html>snapshot</html>');
  });

  it('is idempotent for identical content', async () => {
    const { dir, store } = await make();
    const a = await store.put(Buffer.from('same'));
    const b = await store.put(Buffer.from('same'));
    expect(a.key).toBe(b.key);
    expect((await readdir(dir)).length).toBe(1);
  });

  it('returns null for a missing key and rejects path traversal', async () => {
    const { store } = await make();
    expect(await store.get('ab/' + 'c'.repeat(64))).toBeNull();
    expect(await store.get('../../etc/passwd')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api`
Expected: FAIL (store modules missing).

- [ ] **Step 3: Implement types, memory store and snapshots**

`packages/api/src/store/types.ts`:
```ts
import type { Receipt, Verdict } from '@icecrawl/core';

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

export interface Store {
  findApiKeyByHash(hash: string): Promise<ApiKeyRow | null>;
  createApiKey(k: { id: string; hash: string; name: string }): Promise<void>;
  revokeApiKey(id: string): Promise<void>;
  saveScrape(rec: ScrapeRecord, receipt: Receipt, snapshot: SnapshotMeta | null): Promise<void>;
  getScrape(id: string): Promise<ScrapeRecord | null>;
  getReceipt(id: string): Promise<Receipt | null>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  put(bytes: Uint8Array): Promise<SnapshotMeta>;
  get(key: string): Promise<Uint8Array | null>;
}
```

`packages/api/src/store/memory.ts`:
```ts
import type { Receipt } from '@icecrawl/core';
import { sha256Hex } from '@icecrawl/trust';
import type { ApiKeyRow, ScrapeRecord, SnapshotMeta, SnapshotStore, Store } from './types';

export class MemoryStore implements Store {
  private keys = new Map<string, { id: string; name: string; revoked: boolean }>();
  private scrapes = new Map<string, ScrapeRecord>();
  private receipts = new Map<string, Receipt>();

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
  async saveScrape(rec: ScrapeRecord, receipt: Receipt): Promise<void> {
    this.scrapes.set(rec.id, structuredClone(rec));
    this.receipts.set(rec.id, structuredClone(receipt));
  }
  async getScrape(id: string): Promise<ScrapeRecord | null> {
    const r = this.scrapes.get(id);
    return r ? structuredClone(r) : null;
  }
  async getReceipt(id: string): Promise<Receipt | null> {
    const r = this.receipts.get(id);
    return r ? structuredClone(r) : null;
  }
  async close(): Promise<void> {}
}

export class MemorySnapshotStore implements SnapshotStore {
  private blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<SnapshotMeta> {
    const sha256 = sha256Hex(bytes);
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    this.blobs.set(key, bytes);
    return { sha256, key, bytes: bytes.length };
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key) ?? null;
  }
}
```

`packages/api/src/store/snapshots.ts`:
```ts
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '@icecrawl/trust';
import type { SnapshotMeta, SnapshotStore } from './types';

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly dir: string) {}

  async put(bytes: Uint8Array): Promise<SnapshotMeta> {
    const sha256 = sha256Hex(bytes);
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const path = join(this.dir, key);
    try {
      await access(path);
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return { sha256, key, bytes: bytes.length };
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!KEY_PATTERN.test(key)) return null;
    try {
      return await readFile(join(this.dir, key));
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Implement migrations, Postgres store, config and migrate CLI**

`packages/api/migrations/001_init.sql`:
```sql
create table api_keys (
  id uuid primary key,
  hash text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table scrapes (
  id uuid primary key,
  api_key_id uuid references api_keys(id),
  url text not null,
  final_url text,
  verdict text not null,
  confidence real not null,
  engine text,
  status_code int,
  markdown text,
  metadata jsonb not null default '{}',
  response jsonb not null,
  created_at timestamptz not null default now()
);

create table snapshots (
  id uuid primary key default gen_random_uuid(),
  scrape_id uuid not null references scrapes(id) on delete cascade,
  html_sha256 text not null,
  storage_key text not null,
  bytes bigint not null
);
create index snapshots_html_sha256_idx on snapshots (html_sha256);

create table receipts (
  id uuid primary key references scrapes(id) on delete cascade,
  body jsonb not null,
  signature text,
  key_id text
);
```

`packages/api/src/store/pg.ts`:
```ts
import postgres from 'postgres';
import type { Receipt, Verdict } from '@icecrawl/core';
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

  async saveScrape(rec: ScrapeRecord, receipt: Receipt, snapshot: SnapshotMeta | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into scrapes (id, api_key_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata, response, created_at)
        values (${rec.id}, ${rec.apiKeyId}, ${rec.url}, ${rec.finalUrl}, ${rec.verdict}, ${rec.confidence}, ${rec.engine},
                ${rec.statusCode}, ${rec.markdown}, ${tx.json(rec.metadata as never)}, ${tx.json(rec.response as never)}, ${rec.createdAt})`;
      if (snapshot) {
        await tx`insert into snapshots (scrape_id, html_sha256, storage_key, bytes)
                 values (${rec.id}, ${snapshot.sha256}, ${snapshot.key}, ${snapshot.bytes})`;
      }
      await tx`insert into receipts (id, body) values (${rec.id}, ${tx.json(receipt as never)})`;
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
    const [r] = await this.sql`select body from receipts where id = ${id}`;
    return r ? (r.body as Receipt) : null;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
```

`packages/api/src/store/migrate.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type postgres from 'postgres';

const DEFAULT_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export async function migrate(sql: postgres.Sql, dir: string = DEFAULT_DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
```

`packages/api/src/config.ts`:
```ts
export interface AppConfig {
  port: number;
  databaseUrl: string;
  snapshotDir: string;
  useAuth: boolean;
  allowPrivateNetworks: boolean;
  strict: boolean;
  maxResponseBytes: number;
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
  };
}
```

`packages/api/src/cli/migrate.ts`:
```ts
import { loadConfig } from '../config';
import { migrate } from '../store/migrate';
import { createSql } from '../store/pg';

const sql = createSql(loadConfig().databaseUrl);
const ran = await migrate(sql);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await sql.end();
```

- [ ] **Step 5: Run memory and snapshot tests**

Run: `pnpm vitest run packages/api && pnpm typecheck`
Expected: memory contract and snapshot tests PASS; the postgres suite is SKIPPED (no `DATABASE_URL`).

- [ ] **Step 6: Run the Postgres contract against a real database**

Run:
```bash
pnpm db:up
```
Expected: `postgres` and `redis` containers start healthy (`docker compose ps` shows "healthy" within ~15 s).

PowerShell:
```powershell
$env:DATABASE_URL = "postgres://icecrawl:icecrawl@localhost:5432/icecrawl"; pnpm vitest run packages/api/test/store.pg.test.ts
```
Expected: the 4 postgres contract tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): store layer with memory and Postgres backends, migrations and snapshots" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `api`: Fastify app, auth, `/v2/scrape`, receipts, 501 routes

**Files:**
- Create: `packages/api/src/response.ts`, `packages/api/src/app.ts` (replace placeholder), `packages/api/test/helpers.ts`
- Test: `packages/api/test/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces:
  - `interface AppDeps { store: Store; snapshots: SnapshotStore; engines: readonly Engine[]; scraper: ScraperConfig; useAuth: boolean }`
  - `buildApp(deps: AppDeps): FastifyInstance` with routes: `GET /health`, `POST /v2/scrape`, `GET /v2/scrape/:id`, `GET /v2/receipts/:id`, and `501 NOT_IMPLEMENTED` for `/v2/{map,crawl,batch,search,extract,parse,interact,agent,monitor}...`.
  - `buildResponse(run: ScrapeRun, formats: SupportedFormat[]): { status: number; payload: Record<string, unknown> }`.

- [ ] **Step 1: Write the test helpers and the failing app tests**

`packages/api/test/helpers.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { featureSet, type Engine, type EngineResult } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { MemorySnapshotStore, MemoryStore } from '../src/store/memory';

export const article = `<article><h1>Hello world</h1>${'<p>Some real content about things that matter. </p>'.repeat(30)}</article>`;
export const okHtml = `<html lang="en"><head><title>Test Page</title><meta name="description" content="d"></head><body>${article}<a href="/next">next</a></body></html>`;

export function fakeEngine(result: Partial<EngineResult> & { html?: string }): Engine {
  const { html, ...rest } = result;
  return {
    name: 'fake',
    quality: 10,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async () => ({
      finalUrl: 'https://example.com/final',
      statusCode: 200,
      headers: {},
      body: Buffer.from(html ?? okHtml),
      contentType: 'text/html; charset=utf-8',
      truncated: false,
      ...rest,
    }),
  };
}

export async function makeApp(opts: { engine?: Engine; useAuth?: boolean; strict?: boolean } = {}) {
  const store = new MemoryStore();
  const snapshots = new MemorySnapshotStore();
  const keyId = randomUUID();
  await store.createApiKey({ id: keyId, hash: sha256Hex('ic-test'), name: 'test' });
  const app = buildApp({
    store,
    snapshots,
    engines: [opts.engine ?? fakeEngine({})],
    scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: opts.strict ?? false },
    useAuth: opts.useAuth ?? true,
  });
  return { app, store, snapshots, keyId, auth: { authorization: 'Bearer ic-test' } };
}
```

`packages/api/test/app.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { fakeEngine, makeApp, okHtml } from './helpers';

describe('auth', () => {
  it('rejects a missing token with 401 UNAUTHORIZED', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', payload: { url: 'https://example.com' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
  });

  it('rejects an unknown or revoked token', async () => {
    const { app, store, keyId } = await makeApp();
    const bad = await app.inject({ method: 'POST', url: '/v2/scrape', headers: { authorization: 'Bearer ic-nope' }, payload: { url: 'https://example.com' } });
    expect(bad.statusCode).toBe(401);
    await store.revokeApiKey(keyId);
    const revoked = await app.inject({ method: 'POST', url: '/v2/scrape', headers: { authorization: 'Bearer ic-test' }, payload: { url: 'https://example.com' } });
    expect(revoked.statusCode).toBe(401);
  });

  it('skips auth when disabled', async () => {
    const { app } = await makeApp({ useAuth: false });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', payload: { url: 'https://example.com' } });
    expect(res.statusCode).toBe(200);
  });

  it('serves /health without auth', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });
});

describe('POST /v2/scrape', () => {
  it('returns a v2-shaped success envelope with metadata and a trust block', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.markdown).toContain('Hello world');
    expect(body.data.html).toBeUndefined();
    expect(body.data.metadata).toMatchObject({
      title: 'Test Page',
      description: 'd',
      language: 'en',
      sourceURL: 'https://example.com/start',
      url: 'https://example.com/final',
      statusCode: 200,
    });
    expect(body.data.trust).toMatchObject({ verdict: 'ok', engine: 'fake' });
    expect(body.data.trust.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns only the requested formats', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', formats: ['html', 'rawHtml', 'links'] },
    });
    const d = res.json().data;
    expect(d.markdown).toBeUndefined();
    expect(d.rawHtml).toBe(okHtml);
    expect(typeof d.html).toBe('string');
    expect(d.links).toEqual(['https://example.com/next']);
  });

  it('adds a warning for unsupported formats and ignored options', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', formats: ['markdown', 'screenshot'], waitFor: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warning).toContain('screenshot');
    expect(res.json().data.warning).toContain('waitFor');
  });

  it('answers 400 VALIDATION for a bad body', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, code: 'VALIDATION' });
  });

  it('answers 400 for malformed JSON', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: { ...auth, 'content-type': 'application/json' }, payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('answers 422 NO_ENGINE when actions are requested but no engine supports them', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: 'https://example.com/start', actions: [{ type: 'click', selector: '#a' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('NO_ENGINE');
  });

  it('fails honestly on a captcha page: success false, typed code, trust block', async () => {
    const engine = fakeEngine({ html: '<html><body><div class="g-recaptcha"></div><p>Hold on</p></body></html>' });
    const { app, auth } = await makeApp({ engine });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toMatchObject({ success: false, code: 'CAPTCHA' });
    expect(body.trust).toMatchObject({ verdict: 'captcha' });
    expect(body.data).toBeUndefined();
  });

  it('fails a 403 page as BLOCKED instead of returning the block page as content', async () => {
    const { app, auth } = await makeApp({ engine: fakeEngine({ statusCode: 403, html: '<html>Forbidden</html>' }) });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    expect(res.json()).toMatchObject({ success: false, code: 'BLOCKED' });
  });

  it('applies strict mode to uncertain pages', async () => {
    const html = `<html><body><p>This page has some text.</p><!--${'x'.repeat(60000)}--></body></html>`;
    const lenient = await makeApp({ engine: fakeEngine({ html }) });
    expect((await lenient.app.inject({ method: 'POST', url: '/v2/scrape', headers: lenient.auth, payload: { url: 'https://example.com/s' } })).json().data.trust.verdict).toBe('uncertain');
    const strict = await makeApp({ engine: fakeEngine({ html }), strict: true });
    const res = await strict.app.inject({ method: 'POST', url: '/v2/scrape', headers: strict.auth, payload: { url: 'https://example.com/s' } });
    expect(res.json()).toMatchObject({ success: false, code: 'UNCERTAIN' });
  });
});

describe('persistence and retrieval', () => {
  it('stores the snapshot whose hash is in the receipt and serves receipt + replay', async () => {
    const { app, auth, snapshots } = await makeApp();
    const post = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = post.json().data.trust.receiptId as string;

    const receipt = await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: auth });
    expect(receipt.statusCode).toBe(200);
    const r = receipt.json().data;
    expect(r.htmlSha256).toBe(sha256Hex(Buffer.from(okHtml)));
    expect(r.engineChain[0]).toMatchObject({ engine: 'fake', verdict: 'ok' });
    expect(await snapshots.get(`${r.htmlSha256.slice(0, 2)}/${r.htmlSha256}`)).not.toBeNull();

    const replay = await app.inject({ method: 'GET', url: `/v2/scrape/${id}`, headers: auth });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(post.json());
  });

  it('stores failed scrapes too, so failures are auditable', async () => {
    const { app, auth } = await makeApp({ engine: fakeEngine({ statusCode: 429, html: '<html>slow down</html>' }) });
    const post = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = post.json().trust.receiptId as string;
    const receipt = await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: auth });
    expect(receipt.json().data.engineChain[0].verdict).toBe('blocked');
  });

  it('returns 404 for unknown or malformed ids and hides other keys\' scrapes', async () => {
    const { app, auth, store } = await makeApp();
    expect((await app.inject({ method: 'GET', url: `/v2/scrape/${randomUUID()}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v2/scrape/not-a-uuid', headers: auth })).statusCode).toBe(404);

    const post = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/start' } });
    const id = post.json().data.trust.receiptId as string;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'other' });
    const other = { authorization: 'Bearer ic-other' };
    expect((await app.inject({ method: 'GET', url: `/v2/scrape/${id}`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v2/receipts/${id}`, headers: other })).statusCode).toBe(404);
  });
});

describe('planned endpoints', () => {
  it.each([['crawl', 3], ['map', 3], ['batch/scrape', 3], ['search', 5], ['extract', 5], ['parse', 7], ['interact', 8], ['agent', 8], ['monitor', 9]])(
    '/v2/%s answers 501 naming phase %i',
    async (path, phase) => {
      const { app, auth } = await makeApp();
      const res = await app.inject({ method: 'POST', url: `/v2/${path}`, headers: auth, payload: {} });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED' });
      expect(res.json().error).toContain(`phase ${phase}`);
    },
  );

  it('answers 404 for anything else', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v2/nothing-here', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/test/app.test.ts`
Expected: FAIL (`buildApp` not exported).

- [ ] **Step 3: Implement the response builder**

`packages/api/src/response.ts`:
```ts
import { ERROR_STATUS, VERDICT_ERROR_CODE, type SupportedFormat, type TrustBlock, type Verdict } from '@icecrawl/core';
import type { ScrapeRun } from '@icecrawl/scraper';

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

  const data: Record<string, unknown> = {};
  if (formats.includes('markdown')) data.markdown = run.markdown;
  if (formats.includes('html')) data.html = run.cleanHtml;
  if (formats.includes('rawHtml')) data.rawHtml = run.rawHtml;
  if (formats.includes('links')) data.links = run.links;
  data.metadata = {
    title: run.title,
    description: run.description,
    language: run.language,
    sourceURL: run.requestedUrl,
    url: run.finalUrl,
    statusCode: run.statusCode,
    contentType: run.contentType,
  };
  if (run.warnings.length > 0) data.warning = run.warnings.join(' ');
  data.trust = trust;
  return { status: 200, payload: { success: true, data } };
}
```

- [ ] **Step 4: Implement the app**

`packages/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import type { Engine } from '@icecrawl/engines';
import { runScrape, type ScraperConfig } from '@icecrawl/scraper';
import { sha256Hex } from '@icecrawl/trust';
import { buildResponse } from './response';
import type { SnapshotStore, Store } from './store/types';

export interface AppDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  useAuth: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLANNED: Record<string, number> = {
  crawl: 3,
  map: 3,
  batch: 3,
  search: 5,
  extract: 5,
  parse: 7,
  interact: 8,
  agent: 8,
  monitor: 9,
};

function errorHandler(err: unknown, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof IceCrawlError) {
    return reply.status(err.status).send({ success: false, code: err.code, error: err.message });
  }
  const fe = err as { statusCode?: number; message?: string };
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ success: false, code: 'VALIDATION', error: fe.message ?? 'Bad request' });
  }
  console.error(err);
  return reply.status(500).send({ success: false, code: 'INTERNAL', error: 'Internal server error' });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.decorateRequest('apiKeyId', null);
  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler((req, reply) => {
    const segment = req.url.split('?')[0].split('/')[2];
    if (req.url.startsWith('/v2/') && segment && PLANNED[segment] !== undefined) {
      return reply.status(501).send({
        success: false,
        code: 'NOT_IMPLEMENTED',
        error: `/v2/${segment} is planned for phase ${PLANNED[segment]} of the IceCrawl roadmap.`,
      });
    }
    return reply.status(404).send({ success: false, code: 'NOT_FOUND', error: 'Route not found' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.register(
    async (v2) => {
      v2.addHook('preHandler', async (req) => {
        if (!deps.useAuth) return;
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!match) throw new IceCrawlError('UNAUTHORIZED', 'Missing bearer token');
        const row = await deps.store.findApiKeyByHash(sha256Hex(match[1]));
        if (!row || row.revoked) throw new IceCrawlError('UNAUTHORIZED', 'Invalid API key');
        req.apiKeyId = row.id;
      });

      v2.post('/scrape', async (req, reply) => {
        const normalized = normalizeScrapeRequest(req.body);
        const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
        const { status, payload } = buildResponse(run, normalized.formats);
        const snapshot = await deps.snapshots.put(run.snapshot.bytes);
        await deps.store.saveScrape(
          {
            id: run.id,
            apiKeyId: req.apiKeyId,
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
        );
        return reply.status(status).send(payload);
      });

      v2.get<{ Params: { id: string } }>('/scrape/:id', async (req) => {
        const rec = UUID.test(req.params.id) ? await deps.store.getScrape(req.params.id) : null;
        if (!rec || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) throw new IceCrawlError('NOT_FOUND', 'Scrape not found');
        return rec.response;
      });

      v2.get<{ Params: { id: string } }>('/receipts/:id', async (req) => {
        const rec = UUID.test(req.params.id) ? await deps.store.getScrape(req.params.id) : null;
        const receipt = rec ? await deps.store.getReceipt(rec.id) : null;
        if (!rec || !receipt || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) {
          throw new IceCrawlError('NOT_FOUND', 'Receipt not found');
        }
        return { success: true, data: receipt };
      });
    },
    { prefix: '/v2' },
  );

  return app;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/api && pnpm typecheck`
Expected: all app tests PASS. The 501 test for `/v2/batch/scrape` relies on the segment being `batch`, which the handler extracts. If Fastify answers a POST to an unknown path with its own 404 before the not-found handler, confirm `setNotFoundHandler` was registered on the root instance (it is) before re-running.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): Fastify app with auth, /v2/scrape, receipts and planned-route 501s" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Server entry, key CLI, Docker image, end-to-end test, SDK tolerance check, docs

**Files:**
- Create: `packages/api/src/server.ts`, `packages/api/src/cli/keys.ts`, `Dockerfile`, `README.md`, `packages/api/test/e2e.test.ts`, `scripts/sdk-check/README.md`
- Modify: `docker-compose.yml` (add `api` service), `docs/superpowers/specs/2026-10-24-icecrawl-design.md` (open item result)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: runnable server on port 3002; `pnpm --filter @icecrawl/api keys:create <name>` printing a key of the form `ic-<48 hex>` once; a documented result for the "do official SDKs accept `data.trust`" open item.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/api/test/e2e.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine } from '@icecrawl/engines';
import { checkStoredHashes, sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';

const url = process.env.DATABASE_URL;
const article = `<article><h1>E2E Page</h1>${'<p>Genuine paragraph about genuine things. </p>'.repeat(30)}</article>`;
const pageHtml = `<html><head><title>E2E</title></head><body>${article}</body></html>`;

describe.skipIf(!url)('end to end: real fetch engine + Postgres + file snapshots', () => {
  const sql = createSql(url ?? 'postgres://unused');
  let origin: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-'));
    origin = createServer((req, res) => {
      if (req.url === '/blocked') {
        res.writeHead(403, { 'content-type': 'text/html' }).end('<html>Access denied</html>');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml);
      }
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    origin.closeAllConnections();
    origin.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('scrapes a page, persists it, and the stored snapshot matches the receipt hash', async () => {
    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(dir);
    const keyId = randomUUID();
    await store.createApiKey({ id: keyId, hash: sha256Hex('ic-e2e'), name: 'e2e' });
    const app = buildApp({
      store,
      snapshots,
      engines: [fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 1_000_000, strict: false },
      useAuth: true,
    });
    const auth = { authorization: 'Bearer ic-e2e' };

    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/page`, formats: ['markdown', 'links'] } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.markdown).toContain('# E2E Page');
    expect(body.data.trust.verdict).toBe('ok');

    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${body.data.trust.receiptId}`, headers: auth })).json().data;
    const stored = await snapshots.get(`${receipt.htmlSha256.slice(0, 2)}/${receipt.htmlSha256}`);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).toString()).toBe(pageHtml);
    expect(checkStoredHashes(receipt, stored, body.data.markdown)).toEqual({ html: true, output: true });

    // tamper with one byte: the check must fail
    const tampered = Buffer.from(stored!);
    tampered[10] = tampered[10] ^ 1;
    expect(checkStoredHashes(receipt, tampered, body.data.markdown).html).toBe(false);
  });

  it('reports a blocked origin honestly and refuses private targets by default', async () => {
    const store = new PgStore(sql);
    const keyId = randomUUID();
    await store.createApiKey({ id: keyId, hash: sha256Hex('ic-e2e2'), name: 'e2e2' });
    const auth = { authorization: 'Bearer ic-e2e2' };
    const permissive = buildApp({
      store, snapshots: new FileSnapshotStore(dir), engines: [fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 1_000_000, strict: false }, useAuth: true,
    });
    const blocked = await permissive.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/blocked` } });
    expect(blocked.statusCode).toBe(502);
    expect(blocked.json()).toMatchObject({ success: false, code: 'BLOCKED' });

    const strictNet = buildApp({
      store, snapshots: new FileSnapshotStore(dir), engines: [fetchEngine],
      scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false }, useAuth: true,
    });
    const ssrf = await strictNet.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/page` } });
    expect(ssrf.statusCode).toBe(400);
    expect(ssrf.json().code).toBe('SSRF_BLOCKED');
  });
});
```

- [ ] **Step 2: Run to verify it fails or skips for the right reason**

Run (PowerShell, with `pnpm db:up` already running):
```powershell
$env:DATABASE_URL = "postgres://icecrawl:icecrawl@localhost:5432/icecrawl"; pnpm vitest run packages/api/test/e2e.test.ts
```
Expected: PASS already, because the pieces exist; if it fails, fix the cause shown (it is the first test that wires the real engine, Postgres and the snapshot store together). Without `DATABASE_URL` the suite is skipped.

- [ ] **Step 3: Implement the server entry and the key CLI**

`packages/api/src/server.ts`:
```ts
import { fetchEngine } from '@icecrawl/engines';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';

const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);

const app = buildApp({
  store: new PgStore(sql),
  snapshots: new FileSnapshotStore(config.snapshotDir),
  engines: [fetchEngine],
  scraper: {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
  },
  useAuth: config.useAuth,
});

const shutdown = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'})`);
```

`packages/api/src/cli/keys.ts`:
```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256Hex } from '@icecrawl/trust';
import { loadConfig } from '../config';
import { migrate } from '../store/migrate';
import { PgStore, createSql } from '../store/pg';

const [command, arg] = process.argv.slice(2);
const sql = createSql(loadConfig().databaseUrl);
await migrate(sql);
const store = new PgStore(sql);

try {
  if (command === 'create') {
    const name = arg ?? 'default';
    const key = `ic-${randomBytes(24).toString('hex')}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(key), name });
    console.log(`Created API key "${name}". It is shown only once:\n${key}`);
  } else if (command === 'revoke' && arg) {
    await store.revokeApiKey(arg);
    console.log(`Revoked key ${arg}`);
  } else {
    console.error('Usage: keys create <name> | keys revoke <key-id>');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
```

- [ ] **Step 4: Add the Dockerfile and the `api` service**

`Dockerfile`:
```dockerfile
FROM node:20-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 3002
CMD ["pnpm", "--filter", "@icecrawl/api", "start"]
```

Append this service to `docker-compose.yml` under `services:` (same indentation as `postgres`):
```yaml
  api:
    build: .
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      PORT: "3002"
      DATABASE_URL: postgres://icecrawl:icecrawl@postgres:5432/icecrawl
      REDIS_URL: redis://redis:6379
      ICECRAWL_SNAPSHOT_DIR: /data/snapshots
    ports: ["3002:3002"]
    volumes: ["snapshots:/data/snapshots"]
```
and add `  snapshots: {}` under the top-level `volumes:`.

- [ ] **Step 5: Smoke test the live server with a real key**

Run:
```bash
pnpm db:up
pnpm --filter @icecrawl/api keys:create dev
```
Expected: prints `ic-` followed by 48 hex characters. Copy it.

Run (second terminal): `pnpm dev`
Expected: `IceCrawl listening on :3002 (auth on)`.

Run (replace `KEY`):
```bash
curl -s http://localhost:3002/v2/scrape -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"url":"https://example.com","formats":["markdown","links"]}'
```
Expected: JSON with `"success":true`, `data.markdown` containing "Example Domain", `data.trust.verdict` `"ok"` and a `receiptId`.

Run: `curl -s http://localhost:3002/v2/scrape -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"url":"http://169.254.169.254/latest/meta-data"}'`
Expected: HTTP 400 with `"code":"SSRF_BLOCKED"`.

- [ ] **Step 6: Check whether the official SDK accepts `data.trust` (spec open item)**

Run in a scratch folder outside the repo:
```bash
mkdir -p ../icecrawl-sdk-check && cd ../icecrawl-sdk-check && npm init -y && npm view @mendable/firecrawl-js version && npm install @mendable/firecrawl-js
```
Expected: prints a version number, then installs. If `npm view` fails, search npm for the current official Firecrawl JS package name and use that instead.

Create `check.mjs` in that folder (adjust the constructor/method names to the installed package's README if they differ; the goal is only to see whether a successful `/v2/scrape` response containing `data.trust` is accepted):
```js
import Firecrawl from '@mendable/firecrawl-js';

const app = new Firecrawl({ apiKey: process.env.ICECRAWL_KEY, apiUrl: 'http://localhost:3002' });
const doc = await app.scrape('https://example.com', { formats: ['markdown'] });
console.log('markdown length:', doc.markdown?.length);
console.log('metadata:', doc.metadata);
console.log('trust passed through:', JSON.stringify(doc.trust ?? doc.metadata?.trust ?? 'dropped'));
```
Run (PowerShell): `$env:ICECRAWL_KEY = "KEY"; node check.mjs`
Expected: either prints markdown and a `trust` value or `dropped` (both mean the SDK tolerates the extra field), or throws a parse/validation error (the SDK rejects it).

Record the result in the spec: in section 11 of `docs/superpowers/specs/2026-10-24-icecrawl-design.md`, replace the bullet that begins `- Whether the official SDKs accept the extra` with one of:
- `- Official Node SDK (version X) accepts the extra \`data.trust\` field: verified 2026-10-24.`
- `- Official Node SDK (version X) rejects \`data.trust\`; \`trust\` must move behind \`?trust=1\` or a header (tracked for phase 4).`

Put the exact installed version in place of `X`. If it rejects, add the same note to `scripts/sdk-check/README.md` created in this step with the failing error text; do not change the response shape in this phase.

- [ ] **Step 7: Write the README**

`README.md`:
```markdown
# IceCrawl

Open-source, Firecrawl-v2-compatible web scraping API where every scrape comes with a verdict and a provenance receipt.

> Status: phase 1 (foundation). `POST /v2/scrape` works. Crawl, map, batch, search, extract, MCP and the rest follow the roadmap in `docs/superpowers/specs/2026-10-24-icecrawl-design.md`.

## Quick start

```bash
pnpm install
pnpm db:up                                   # Postgres + Redis
pnpm --filter @icecrawl/api keys:create dev  # prints an API key once
pnpm dev                                     # server on :3002
```

```bash
curl -s http://localhost:3002/v2/scrape \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown","links"]}'
```

## What "trustworthy" means here

- A scrape only succeeds if its content is verified: bot-walls, captchas, login walls, empty, soft-404 and truncated pages come back as `success:false` with a typed `code`, not as page text.
- Every scrape (including failures) has a receipt: `GET /v2/receipts/{id}` returns URLs, status, the engines tried and why each was accepted or rejected, and SHA-256 hashes of the raw HTML and the markdown. The raw HTML is stored by hash.
- Private and loopback addresses are blocked (SSRF guard), including after redirects and DNS resolution. Set `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true` only for local testing.

## Tests

```bash
pnpm test                                    # unit tests, no services needed
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test   # also Postgres + e2e
```

## License

Apache-2.0
```

- [ ] **Step 8: Run the whole suite and commit**

Run (PowerShell): `$env:DATABASE_URL = "postgres://icecrawl:icecrawl@localhost:5432/icecrawl"; pnpm test; pnpm typecheck`
Expected: every test file PASSES (none skipped), typecheck exits 0.

```bash
git add -A
git commit -m "feat: server entry, key CLI, Docker image, e2e test and docs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage for phase 1)

| Spec phase 1 item | Task |
|---|---|
| Monorepo | 1 |
| `core` schemas from the OpenAPI | 2 (hand-written scrape subset; deviation listed) |
| compose (Postgres, Redis) | 1, 11 |
| API keys | 9 (store), 10 (auth), 11 (CLI) |
| `fetch` engine | 6 |
| `/scrape` markdown | 7, 8, 10 |
| Verdict | 3, 8 |
| Receipt v1 | 4, 8, 10 |
| SSRF guard, size cap, per-scrape timeout, hashed keys (spec section 8) | 6, 9, 10 |
| Picker (spec section 4) | 5, 8 |
| 501 for later phases (spec section 2) | 10 |
| Snapshots stored by hash (spec section 6) | 9, 10 |
| SDK `trust` field open item | 11 |

Not in this plan on purpose: `maxAge` cache, robots.txt (crawl only), Ed25519 signing, `verify` CLI, Playwright (phase 2), jobs/queue/worker (phase 3).

Type consistency check: `Engine`, `EngineContext`, `EngineResult` (Task 5) are used unchanged in Tasks 6 and 8; `ScrapeRun` fields used by `buildResponse` (Task 10) match Task 8; `ScrapeRecord`/`Store` (Task 9) match their use in `app.ts`; `NormalizedScrape.formats` is `SupportedFormat[]` in Tasks 2, 8 and 10.
