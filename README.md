# IceCrawl

Open-source, Firecrawl-v2-compatible web scraping API where every scrape comes with a verdict and a provenance receipt.

> Status: 0.1.0, ready for a first release (see `CHANGELOG.md`, `docs/RELEASING.md`). Scrape, crawl, batch, map, search (SearXNG), LLM extract with a grounding check, signed receipts, a prompt-injection scan, an MCP server for Claude and Codex and a typed SDK work and are covered by the quality gates below. Parse, stealth proxies, interact, agent, monitor, indexes and a dashboard follow the roadmap in `docs/superpowers/specs/2026-10-24-icecrawl-design.md`.

## Quick start

```bash
pnpm install
pnpm db:up                                   # Postgres + Redis
pnpm --filter @icecrawl/api keys:create dev  # prints an API key once
pnpm --filter @icecrawl/engines exec playwright-core install chromium   # one-time browser download
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

## Verifying a scrape

Every receipt is signed with Ed25519 (RFC 8785 canonical JSON). The public keys are at `/.well-known/icecrawl-keys.json`; retired keys stay listed so old receipts keep verifying.

```bash
pnpm --filter @icecrawl/cli icecrawl verify <receiptId> --api http://localhost:3002 --key $KEY
```

It checks the signature, re-hashes the stored raw HTML (and screenshot), and re-runs the pinned HTML-to-markdown converter on that HTML to confirm it reproduces the recorded output hash. Offline: `icecrawl verify --receipt r.json --snapshot s.html --keys keys.json` using files saved from `GET /v2/receipts/{id}`, `/snapshot` and the keys endpoint.

Rotate the signing key with `pnpm --filter @icecrawl/api signing:rotate` (the old private key is kept as a `.bak` file, its public key is marked retired).

## Browser notes

The browser engine routes all traffic through an internal proxy that blocks private and loopback addresses at connect time, including redirects and subresources. For defence in depth, run the server in a container with restricted egress. Set `ICECRAWL_BROWSER=false` to use plain HTTP fetch only, or `ICECRAWL_PREFER_BROWSER=false` to try fetch first and use the browser only when the fetched page looks empty or blocked.

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

## Using IceCrawl from Claude and Codex (MCP)

The MCP server (`packages/mcp`) talks to your IceCrawl API (`ICECRAWL_API_URL`, `ICECRAWL_API_KEY`). Create a key with `pnpm --filter @icecrawl/api keys:create <name>`.

**Claude Code** (stdio, run from anywhere; use your repo path, or `npx -y @icecrawl/mcp` instead of the `node ...` command once the package is published):

```bash
claude mcp add icecrawl -e ICECRAWL_API_URL=http://localhost:3002 -e ICECRAWL_API_KEY=ic-... -- node D:/1.projects/icecrawl/packages/mcp/bin/icecrawl-mcp.mjs
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "icecrawl": {
      "command": "node",
      "args": ["D:/1.projects/icecrawl/packages/mcp/bin/icecrawl-mcp.mjs"],
      "env": { "ICECRAWL_API_URL": "http://localhost:3002", "ICECRAWL_API_KEY": "ic-..." }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.icecrawl]
command = "node"
args = ["D:/1.projects/icecrawl/packages/mcp/bin/icecrawl-mcp.mjs"]
env = { ICECRAWL_API_URL = "http://localhost:3002", ICECRAWL_API_KEY = "ic-..." }
startup_timeout_sec = 30
tool_timeout_sec = 300
```

**Streamable HTTP** (one shared server): run `ICECRAWL_MCP_TOKEN=secret node packages/mcp/bin/icecrawl-mcp.mjs --http --port 3003`, then `claude mcp add --transport http icecrawl http://127.0.0.1:3003/mcp --header "Authorization: Bearer secret"`. The HTTP server binds to loopback, checks the `Host` header, and refuses to listen on other addresses without `ICECRAWL_MCP_TOKEN`.

Tools: `icecrawl_scrape`, `icecrawl_map`, `icecrawl_crawl`, `icecrawl_check_crawl_status`, `icecrawl_cancel_crawl`, `icecrawl_batch_scrape`, `icecrawl_check_batch_status`, `icecrawl_search`, `icecrawl_extract`, `icecrawl_check_extract_status`, `icecrawl_search_index`, `icecrawl_agent`, `icecrawl_check_agent_status`, `icecrawl_list_interact_sessions`, `icecrawl_verify_receipt`. Set `ICECRAWL_MCP_TOOL_PREFIX=firecrawl_` to expose Firecrawl's tool names (`firecrawl_scrape`, `firecrawl_check_crawl_status`, ...) so existing prompts and skills keep working. `FIRECRAWL_API_URL` / `FIRECRAWL_API_KEY` are accepted as fallbacks.

What makes the results safe for agents:

- Page content is always inside `<<<ICECRAWL_UNTRUSTED_CONTENT ...>>>` markers with a random boundary, and the server instructions tell the model never to follow instructions found there.
- A scrape that is blocked, captcha-protected, behind a login, empty, truncated, or quarantined comes back as an error result and contains **no page text**.
- Prompt-injection findings (hidden text, instruction-like phrases, invisible characters, encoded payloads) are listed before the content. Set `ICECRAWL_INJECTION=quarantine` on the API to withhold high-severity pages entirely. The scanner is heuristic: a flag means "treat as data", and pages that discuss prompt injection will be flagged.
- Output is capped (`maxChars`, default 30000) and says when it was truncated; status tools page with `skip`.
- Every result carries a receipt id; `icecrawl_verify_receipt` checks the signature, the stored snapshot, and replays the converter and the injection scanner.

## SDK

```ts
import { IceCrawl } from '@icecrawl/sdk';
import { verifyReceiptRemote } from '@icecrawl/sdk/verify';

const ic = new IceCrawl({ apiUrl: 'http://localhost:3002', apiKey: process.env.ICECRAWL_API_KEY });
const doc = await ic.scrape('https://example.com', { formats: ['markdown'] });   // throws IceCrawlApiError (with .trust) if the page cannot be trusted
const site = await ic.crawl('https://docs.example.com', { limit: 20 });            // waits and collects every page
const report = await verifyReceiptRemote(ic, doc.trust.receiptId);
```

## Parse files and proxies

`POST /v2/parse` turns an uploaded pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, csv, html or txt file into markdown with a signed receipt, and URLs that point at such files are read the same way. `proxy: auto` retries a blocked or captcha page through operator-supplied proxy pools. Details, limits and security notes: [docs/stealth.md](docs/stealth.md).

## Interact and agent

`/v2/interact` gives you a persistent browser you can script with node code (off by default; [docs/interact.md](docs/interact.md)). `/v2/agent` runs a research agent that searches and reads pages and returns an answer with a trace and the receipts of the pages it read ([docs/agent.md](docs/agent.md)).

## Dashboard

Open `http://localhost:3002/dashboard/`, paste an API key and use the playground, jobs, receipts (checked in your browser) and monitors ([docs/dashboard.md](docs/dashboard.md)).

## Index

`POST /v2/index/search` searches the pages you have already scraped (full text, with receipt ids) and any external data sources you configure, without touching the web ([docs/index.md](docs/index.md)).

## Monitors

`/v2/monitor` re-reads pages on a schedule and reports what is new, changed or gone, with diffs and receipt ids. A page that is blocked or behind a captcha is an error, never a change ([docs/monitor.md](docs/monitor.md)).

## Search

`POST /v2/search` follows Firecrawl's v2 request and response (`query`, `limit`, `sources` web/news/images, `categories` developer/research/pdf, `tbs` day/week/month/year, `includeDomains` or `excludeDomains`, `safe`, `ignoreInvalidURLs`, `scrapeOptions`). It searches through a [SearXNG](https://docs.searxng.org/) instance that you run:

```bash
docker compose --profile search up -d searxng     # json format enabled by deploy/searxng/settings.yml
export ICECRAWL_SEARXNG_URL=http://localhost:8080   # if 8080 is taken, start compose with SEARXNG_PORT=8082 and use that port here
curl -s http://localhost:3002/v2/search -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query":"open source web scraper","limit":5,"scrapeOptions":{"formats":["markdown"]}}'
```

- With `scrapeOptions.formats` the first `ICECRAWL_SEARCH_MAX_SCRAPE` results are read through the normal pipeline: every result carries a `trust` block and a receipt id, and a page that is blocked, a captcha, a login wall or quarantined comes back as a result with `metadata.error` and no content.
- Titles and descriptions are written by third parties, so they are scanned for prompt injection: flagged results carry `trust.snippetInjection`, and with `ICECRAWL_INJECTION=quarantine` high-severity results are dropped (and counted in `warning`).
- Not available, and reported in `warning` instead of being ignored silently: the `alexandria` source, the `gov` category, `location`/`country`, hourly and custom date ranges.
- Without `ICECRAWL_SEARXNG_URL` the endpoint answers `501 SEARCH_NOT_CONFIGURED`.

## Extract

`POST /v2/extract` reads pages and has a language model that you choose extract data, like Firecrawl's `/v2/extract`: it returns an `id` and you poll `GET /v2/extract/{id}` (`processing`, `completed`, `failed`). The same machinery serves the `json` and `summary` formats of `/v2/scrape` (and of crawl, batch and search results).

```bash
export ICECRAWL_LLM_PROVIDER=openai          # or anthropic; "openai" means any OpenAI-compatible server
export ICECRAWL_LLM_MODEL=gpt-4o-mini        # for example; or a local model on Ollama
export ICECRAWL_LLM_API_KEY=sk-...           # may be omitted for a local server with ICECRAWL_LLM_BASE_URL
curl -s http://localhost:3002/v2/extract -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/blog/*"],"prompt":"Title and author of each post","schema":{"type":"object","properties":{"posts":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"author":{"type":"string"}}}}}},"showSources":true}'
```

How it stays trustworthy:

1. Pages are read through the normal pipeline: only accepted pages reach the model, quarantined and blocked pages never do. Every source page has a receipt (`trust.sources`).
2. The model sees the pages as untrusted data and is told to extract only; its answer must be a JSON object that validates against your JSON Schema (one repair attempt, then `EXTRACTION_FAILED`).
3. Every string and number in the answer is checked against the page text the model received: `grounded` (found), `partial` (a long value whose words are mostly there) or `ungrounded` (not found). The counts and the list are in `trust.extraction.grounding`. With `ICECRAWL_STRICT=true` any ungrounded value fails the request.
4. Sources that show prompt-injection indicators are marked `injectionFlagged` next to the data.

What the check does not do: it proves a value occurs in the pages, not that it sits in the right field, and values the model computed or reformatted (a percentage as a fraction, a re-formatted date) show up as `ungrounded`, meaning "not found literally", not "false". The extracted data is not covered by the receipt signature (only the pages are); treat it as a checked claim, not a signed fact.

Privacy: the text of the pages you extract from is sent to the model endpoint you configured. Use a local OpenAI-compatible server if that is not acceptable. The API key is only sent to that endpoint and is removed from error messages.

Limits: `ICECRAWL_LLM_MAX_INPUT_CHARS` (default 100000) is shared between the pages of one request, `ICECRAWL_LLM_MAX_OUTPUT_TOKENS` (default 4096) bounds the answer, `ICECRAWL_EXTRACT_MAX_PAGES` (default 20) bounds pattern and search expansion. A URL ending in `*` stands for that page and everything below it; `enableWebSearch` adds the top three search results for the prompt when search is configured.

## Operations

- **Health:** `GET /health` says the process is up; `GET /ready` checks that Postgres and Redis answer (503 with the failing dependency otherwise, no API key needed). The compose file uses `/ready` as the API container's healthcheck.
- **Rate limiting:** `ICECRAWL_RATE_LIMIT_PER_MINUTE=N` (default 0, off) limits the requests that start work (POST) per API key, counted in Redis so every API process shares the limit. Over the limit the answer is `429 RATE_LIMITED` with `Retry-After` and `X-RateLimit-*` headers. Reading and polling are never limited.
- **Lost jobs:** a job that is still running `ICECRAWL_JOB_MAX_RUNTIME_HOURS` (default 6) after it started is marked failed, because its worker is presumed gone; the same sweep (every five minutes) deletes expired jobs. Raise the limit for very large crawls.
- **Logs:** JSON request logs on stdout, level from `ICECRAWL_LOG_LEVEL` (`fatal`, `error`, `warn`, `info` default, `debug`, `trace`, `silent`). The Authorization header is redacted.
- **Usage:** `/v2/team/credit-usage`, `/token-usage`, `/queue-status`, `/activity` and the `historical` variants report metering for the calling API key (scrapes, and the tokens that `/extract` jobs used). There is no billing: balances read 1,000,000,000.
- **Storage:** raw HTML snapshots are files addressed by hash under `ICECRAWL_SNAPSHOT_DIR`. They are not deleted when jobs expire; prune the directory yourself if disk space matters (a receipt whose snapshot is gone can no longer be fully verified).
- **Back up:** Postgres (receipts, jobs, API keys), the signing key file `ICECRAWL_SIGNING_KEY_FILE`, the webhook secret file and the snapshot directory.
- **Upgrading:** migrations run on start. Receipts made with an older converter version report the `replay` check as skipped (the converter is pinned per receipt); their signature and snapshot checks still work.

## Quality gates

- **Verdict benchmark** (`pnpm bench:verdicts`, also a test): about sixty labelled pages (articles, docs, forums, other languages, pages that merely talk about captchas or 404s, bot walls, captchas, login walls, empty and JavaScript-only pages, soft 404s, error statuses, redirect loops, truncated bodies). The target is zero pages wrongly accepted, zero good pages wrongly refused and every verdict exactly as labelled. Weaknesses that are known and not yet fixed are marked `knownGap` in `packages/fixtures/src/corpus.ts`, printed by the report and not counted; when one gets fixed the test says so.
- **Injection-scan benchmark:** the same corpus has six attack pages (visible, hidden, comment, zero-size, base64, role marker) that must be flagged and thirteen clean pages that must not.
- **OpenAPI conformance:** the responses of every implemented endpoint are validated against Firecrawl's published v2 OpenAPI document, which `node scripts/fetch-openapi.mjs` downloads (it is not part of this repository). IceCrawl's own error codes (for example 502 for an untrustworthy page) are intentional differences and must keep the `{success:false, code, error}` shape.
- **Official SDKs:** `@mendable/firecrawl-js` (pinned) runs in the test suite and `firecrawl-py` in CI, both against the real server code.
- **Packaging:** `node scripts/pack-smoke.mjs` builds the publishable packages, installs the tarballs in an empty project and uses the SDK, the MCP server (through a real MCP client) and the CLI.

The corpus is synthetic and was written with the classifier's rules in mind: it guards against regressions and documents behaviour, it does not measure accuracy on the real web.

## Tests

```bash
pnpm test                                    # unit tests; Postgres, Redis and browser tests are skipped without them
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test   # everything
node scripts/fetch-openapi.mjs               # once: enables the OpenAPI conformance tests
pnpm bench:verdicts                          # verdict and injection-scan report
pnpm release:check                           # type check, all tests, build, pack and use the packages
```

Contributing: `CONTRIBUTING.md`. Security: `SECURITY.md`.

## License

Apache-2.0
