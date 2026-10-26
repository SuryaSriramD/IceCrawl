# Changelog

All notable changes to IceCrawl. The project follows semantic versioning once 1.0 is released; until then minor versions may change behaviour.

## Unreleased

- Documents are converted in a worker thread with a time and memory limit, so a hostile file cannot stall the server; PDF and XML parts are bounded. Receipt replay in the CLI and SDK still converts in-process.
- Session browsers cannot reach their own debugging port through the egress proxy.
- Fixes found by running the Docker stack: an empty `ICECRAWL_INJECTION` (what compose passes for an unset setting) no longer stops the server from starting, compose forwards the model, proxy, monitor and interact settings to the worker as well, and the published `sdk`, `mcp` and `cli` packages declare the document libraries they need (the pack smoke test failed in CI without them).

- Dashboard at `/dashboard/`: overview, playground, jobs, receipts (in-browser signature and snapshot checks), monitors with diffs. No build step; strict content security policy; `ICECRAWL_DASHBOARD=false` turns it off. Stored snapshots are now served with `Content-Security-Policy: sandbox`. See docs/dashboard.md.

- Index: `POST /v2/index/search` (full-text search over your stored scrapes, latest copy of each URL, with receipts) and `GET /v2/index/providers`; operator-defined HTTP data providers via `ICECRAWL_PROVIDERS_FILE`. SDK `searchIndex()`, MCP `search_index`. See docs/index.md.

- Monitors: `/v2/monitor` CRUD, runs, checks and per-page change reports with diffs, cron schedules, webhooks. Blocked pages are errors, never changes. See docs/monitor.md.

- MCP: `agent`, `check_agent_status` and `list_interact_sessions` tools (14 in total). Code execution in interact sessions is deliberately not exposed.

- Agent: `POST/GET /v2/agent`, `GET/DELETE /v2/agent/{id}`, trace and snapshots. A search/read/answer loop on your own model, with every page read through the trust pipeline. SDK `agent()`. See docs/agent.md.

- Interact sessions: `POST/GET /v2/interact`, `POST /v2/interact/{id}/execute`, `DELETE /v2/interact/{id}`, `POST/DELETE /v2/scrape/{id}/interact`. Node code against a persistent browser; off by default (`ICECRAWL_INTERACT_CODE`), not a sandbox. See docs/interact.md.

- `POST /v2/parse` and `GET /v2/parse/formats`: pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, csv, html and txt to markdown with a receipt; the same converters read documents behind URLs. SDK `parse()` / `getParseFormats()`.
- Operator proxy pools (`ICECRAWL_PROXIES_ENHANCED`, `ICECRAWL_PROXIES_STEALTH`), `proxy: enhanced | stealth`, and `proxy: auto` escalation on blocked or captcha verdicts; receipts record the proxy tier. Per-host pacing for proxied traffic. See docs/stealth.md.
- Converter 3: HTML tables become markdown tables (receipts made with converter 2 report replay as skipped).
- `verifyReceipt`, `renderBody` and `replayMarkdown` are now async.

## 0.1.0

First release. Everything below ships in this version.

**API (Firecrawl v2 compatible)**
- `POST /v2/scrape` with markdown, html, rawHtml, links, screenshot, json and summary formats, browser actions, mobile emulation and `waitFor`; `GET /v2/scrape/{id}`.
- `POST /v2/map`, `POST /v2/crawl` (+ status, errors, active, cancel), `POST /v2/batch/scrape` (+ status, errors, cancel), signed webhooks, robots.txt (RFC 9309), sitemap seeding, de-duplication.
- `POST /v2/search` (SearXNG, optional result scraping) and `POST /v2/extract` with `GET /v2/extract/{id}` (language model of your choice, JSON-Schema validation, grounding check).
- `GET /v2/team/*` usage endpoints (metering only; no billing).
- Bearer API keys (stored hashed), per-key rate limiting (optional), `/health` and `/ready`.

**Trust**
- Every scrape gets a verdict (ok, blocked, login_wall, captcha, empty, soft_404, truncated, uncertain, error); only `ok` is returned as content.
- Signed provenance receipts (Ed25519 over RFC 8785 canonical JSON), content-addressed snapshots, `icecrawl verify` replays the converter and the injection scanner.
- Prompt-injection scanner with `flag` and `quarantine` modes; search snippets are screened too.
- SSRF guard (DNS-rebinding safe, applied to the browser through an egress proxy).
- Extraction results carry a grounding report: which extracted values occur in the source pages.

**Integrations**
- `@icecrawl/mcp`: MCP server (stdio and streamable HTTP) with 11 tools; page-derived text is always inside untrusted-content markers and failures never contain page text.
- `@icecrawl/sdk`: typed client plus `@icecrawl/sdk/verify` for receipt verification.
- `@icecrawl/cli`: `icecrawl verify`.

**Quality gates**
- Labelled verdict and injection-scan benchmark (`pnpm bench:verdicts`).
- Responses validated against Firecrawl's published OpenAPI; the official `@mendable/firecrawl-js` and `firecrawl-py` SDKs run against the server.
- Packaging smoke test: the built tarballs are installed in an empty project and used.

**Known limits**
- Extracted data is not covered by the receipt signature (only the source pages are).
- The verdict classifier is rule-based and the benchmark corpus is synthetic: it guards against regressions, it does not measure accuracy on the real web. Known gaps are listed by the benchmark.
- No billing, plans or credit charging by design. Parse, stealth/proxy pools, interact, agent, monitor, indexes and the dashboard are planned (see the roadmap in `docs/superpowers/specs/`).
- Snapshots are not deleted when jobs expire.
