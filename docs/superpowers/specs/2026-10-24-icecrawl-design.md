# IceCrawl: design

Status: approved in conversation 2026-10-24. Name: IceCrawl.

## 1. Goal

An open-source (Apache-2.0), clean-room alternative to Firecrawl that:

- exposes the Firecrawl v2 REST API so the official SDKs work by changing the base URL;
- ships an MCP server for Claude and Codex;
- makes every scrape trustworthy: honest failure detection, provenance receipts, signed and replayable receipts, and a prompt-injection scan.

Clean-room: Firecrawl's backend is AGPL-3.0. We implement the public API contract and our own design. No Firecrawl code is copied. The engine-selection idea (flag priorities, support threshold, quality sort, overlapping waterfall) is documented in `D:\1.projects\REA\reports\firecrawl-scrape-engine-selection.md` and is reimplemented from that description.

## 2. Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript on Node |
| Infra | Postgres + Redis (BullMQ), docker-compose |
| v1 API scope | scrape, map, crawl, batch scrape, search, extract (+ stub team routes) |
| Not in v1 | stealth proxies, anti-bot solving, interact, agent, monitor, parse, Alexandria/indexes, billing, dashboard. These return `501 not_implemented` naming the roadmap phase. |
| License | Apache-2.0 |
| Trust | all four: verdicts, receipts, signatures + replay, injection scan |

## 3. Architecture

Monorepo, one clear job per package:

| Package | Job | Depends on |
|---|---|---|
| `core` | Shared types and zod schemas generated from the v2 OpenAPI | none |
| `api` | Fastify server, v2 routes, validation, auth, enqueue | core, queue |
| `queue` | BullMQ wrappers, rate limits, crawl frontier de-dup | core |
| `worker` | Runs the scrape pipeline for jobs | engines, trust, core |
| `engines` | `fetch`, `playwright`, `pdf`, `document`, `search` (SearXNG); each declares `{quality, features, maxTime}`; picker + waterfall | core |
| `trust` | Verdict classifier, receipts, signing, injection scan | core |
| `sdk` | Typed client | none |
| `mcp` | MCP server (stdio + streamable HTTP) | sdk |

Scrape flow: request → feature flags → picker → waterfall → trust pipeline (on every engine result) → v2 response plus `trust` block.

### Trust pipeline

1. **Verdict:** `ok | blocked | login_wall | captcha | empty | soft_404 | truncated | uncertain | error`, with confidence and reasons. Only `ok` is success; anything else advances the waterfall. If no engine yields `ok`, the API returns `success: false` with a typed code. `uncertain` counts as failure in strict mode.
2. **Receipt:** receipt version, scrape ID, requested and final URL, HTTP status, fetch timestamp, engine chain with each rejection reason and verdict, SHA-256 of raw HTML, SHA-256 of output, converter name and version.
3. **Signature:** Ed25519 over RFC 8785 canonical JSON. Raw HTML is stored by hash. `GET /v2/receipts/{id}` returns the receipt and `icecrawl verify` re-hashes the snapshot, re-runs the pinned converter and compares. Public keys at `/.well-known/icecrawl-keys.json`, so receipts survive key rotation.
4. **Injection scan:** flags hidden text and instruction-like content. Default: content returned with `trust.injection` findings. Strict mode: quarantine.

## 4. API compatibility

- Source of truth: Firecrawl's published v2 OpenAPI (copy kept at `D:\1.projects\REA\evidence\firecrawl\v2-openapi.json`); `core` schemas are generated from it.
- Same paths, bearer auth, job-ID polling, `success`/`data` envelope, error shapes. Auth uses our own API keys; no billing.
- Build order: scrape → map → crawl (+ errors, webhooks) → batch scrape → search (SearXNG; optional result scraping) → extract (LLM, bring your own key) → team stubs.
- Formats in v1: markdown, html, rawHtml, links, images, screenshot, json (+schema), summary. Options: onlyMainContent, include/excludeTags, waitFor, timeout, headers, mobile, maxAge cache, actions (Playwright only). Unsupported options are accepted and reported in `warning`.
- **Intentional differences:** (a) `success: false` when the verdict is not `ok`, where Firecrawl may return a block page as success; (b) added `trust` object beside `metadata`. If the official SDKs reject the extra field, `trust` moves behind `?trust=1` or a header.
- Engine picker: flag priorities and half-total threshold; positive-quality filter; sort by support score then quality; overlapping waterfall bounded by per-engine max time; outer retry that re-runs the picker when flags change (e.g. a PDF discovered). Engines in v1: `fetch`, `playwright`, `pdf`, `document`.

## 5. MCP

Package `@icecrawl/mcp`, transports stdio and streamable HTTP, implemented over `sdk`.

Tools (names mirror Firecrawl's): `scrape`, `search`, `map`, `crawl_start`, `crawl_status`, `extract`, plus new `verify_receipt`.

Agent-safety defaults:
- Content is wrapped in a labeled "untrusted web content" block; injection findings appear in the result text.
- `blocked`, `captcha`, `login_wall` return an MCP error result, never page text.
- Output capped by token budget with a `truncated` flag.

Setup docs ship with it:
```bash
claude mcp add icecrawl -e ICECRAWL_API_URL=http://localhost:3002 -e ICECRAWL_API_KEY=... -- npx -y @icecrawl/mcp
```
```toml
[mcp_servers.icecrawl]
command = "npx"
args = ["-y", "@icecrawl/mcp"]
env = { ICECRAWL_API_URL = "http://localhost:3002", ICECRAWL_API_KEY = "..." }
```

## 6. Data model (Postgres)

- `api_keys(id, hash, name, created_at, revoked_at)`
- `jobs(id, type, status, request jsonb, team_id, parent_id, created_at, finished_at)`: scrape, crawl, batch, extract share one table; crawl children use `parent_id`.
- `scrapes(id, job_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata jsonb)`
- `snapshots(id, scrape_id, html_sha256, storage_key, bytes)`: raw HTML in object storage (local volume by default, S3-compatible optional), addressed by hash.
- `receipts(id, scrape_id, body jsonb, signature, key_id)`
- `signing_keys(key_id, public_key, created_at, retired_at)`
- `cache(url_hash, options_hash, scrape_id, fetched_at)`: serves `maxAge`.

Redis: BullMQ queues, per-key rate limits, crawl frontier de-dup only.

## 7. Verdict detection

Rule-based in v1, no LLM in the loop.
- Status/header signals: 403/429, `cf-mitigated`, Cloudflare/Akamai/DataDome markers.
- Body signals: captcha widgets, "enable JavaScript", login form without article body, very low text-to-markup ratio, title/content mismatch, soft-404 phrase set, content-length cliff between engines.
- Output `verdict + confidence + reasons[]`. Thresholds are set against a labeled fixture corpus; ambiguous cases become `uncertain`.

## 8. Errors and security

Typed codes: `BLOCKED, LOGIN_WALL, CAPTCHA, TIMEOUT, DNS, SSL, UNSUPPORTED_OPTION, NO_ENGINE, ROBOTS_DISALLOWED, SSRF_BLOCKED, RESPONSE_TOO_LARGE`, mapped to Firecrawl-style `{success:false, error}` plus a `code` field.

Defaults: SSRF guard (block private, loopback, link-local after DNS resolution and on every redirect), response size caps, robots.txt respected for crawl, per-scrape wall-clock limit, API keys stored hashed.

## 9. Testing

1. Unit: picker (table-driven from the engine report's worked examples), verdict classifier, receipt canonicalization.
2. Fixture-site container serving: bot-wall, captcha, login wall, soft 404, JS-rendered page, PDF, redirect loop, injection page. Verdict suite must meet precision/recall targets set when the corpus is built.
3. Conformance: responses validated against the v2 OpenAPI; official Python and Node SDKs run against the server.
4. Receipt round-trip: scrape → verify passes; one-byte snapshot tamper → verify fails.
5. MCP: SDK client over stdio and HTTP, including captcha page → error result.

## 10. Build phases

Each phase gets its own implementation plan.
1. **Foundation:** monorepo, `core` schemas, compose (Postgres, Redis), API keys, `fetch` engine, `/scrape` markdown, verdict + receipt v1.
2. **Browser + signing:** Playwright engine, picker, actions, screenshots, Ed25519 signing, verify, snapshots.
3. **Crawl layer:** `/map`, `/crawl`, `/batch/scrape`, webhooks, robots, frontier.
4. **MCP + SDK:** `@icecrawl/mcp`, `sdk`, injection scan, Claude/Codex docs.
5. **Search + extract:** SearXNG adapter; LLM extract with schema validation and a check that extracted values appear in the source.
6. **Hardening:** SDK conformance in CI, fixture benchmarks, docs, public release.

## 11. Open items (do not block the plan)

- Whether the official SDKs accept the extra `trust` field.
- HTML-to-Markdown library choice.
- Verdict precision/recall targets (set when the fixture corpus exists).
- Exact v2 response shapes per endpoint: confirm against the OpenAPI during phase 1.
