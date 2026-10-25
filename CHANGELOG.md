# Changelog

All notable changes to IceCrawl. The project follows semantic versioning once 1.0 is released; until then minor versions may change behaviour.

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
