<div align="center">

# 🧊 IceCrawl

**Open-source web scraping for AI agents, where every page comes with a verdict and a signed receipt.**

Firecrawl v2 compatible · self-hosted · MCP server for Claude and Codex

[![ci](https://github.com/SuryaSriramD/IceCrawl/actions/workflows/ci.yml/badge.svg)](https://github.com/SuryaSriramD/IceCrawl/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.12-339933.svg)](package.json)

[Quick start](#-quick-start) · [Claude and Codex](#-use-it-from-claude-and-codex) · [What it can do](#-what-it-can-do) · [Trust](#-why-you-can-trust-a-scrape) · [Docs](#-documentation)

</div>

---

## ✨ Why IceCrawl

Most scrapers hand you whatever came back, including bot walls, captcha pages and login screens, and your agent reads it as if it were the page. IceCrawl checks first.

| | |
| --- | --- |
| 🛡️ **Honest failures** | Captchas, bot walls, login walls, empty, soft-404 and truncated pages come back as typed errors, never as page text. |
| 🧾 **Signed receipts** | Every scrape has an Ed25519-signed receipt with the engines tried and hashes of the raw HTML and the markdown. Anyone can re-check it. |
| 🧪 **Injection scan** | Hidden text, "ignore previous instructions" and encoded payloads are flagged or quarantined before an agent sees them. |
| 🔌 **Firecrawl v2 API** | Same paths, same shapes. The official Node and Python SDKs work against it. |
| 🤖 **Built for agents** | MCP server for Claude and Codex, a research agent, scriptable browser sessions, scheduled change monitors. |
| 🏠 **Yours to run** | Docker compose, your own Postgres, your own model. Nothing leaves your machine unless you point it somewhere. |

> **Status:** 0.1.0 plus every roadmap phase built since (see [CHANGELOG](CHANGELOG.md) and [docs/RELEASING.md](docs/RELEASING.md)). Not built: billing, a captcha solver, email notifications. Each guide in `docs/` says what its feature does not do.

## 🚀 Quick start

**With Docker** (API, worker, Postgres, Redis and a browser in containers):

```bash
git clone https://github.com/SuryaSriramD/IceCrawl.git && cd IceCrawl
docker compose --profile search up -d --build        # "search" adds SearXNG for web search
docker compose exec api pnpm --filter @icecrawl/api keys:create me     # prints an API key once
```

Open **http://localhost:3002/dashboard/**, paste the key, and try the Playground. Or from a terminal:

```bash
curl -s http://localhost:3002/v2/scrape \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown","links"]}'
```

**On a Mac with Claude and Codex:** `./scripts/setup-mac.sh --search` does all of the above and prints the settings to paste into both apps. See [docs/macos.md](docs/macos.md).

**From source** (Node 20.12+, pnpm, Docker for Postgres and Redis):

```bash
pnpm install
pnpm db:up                                   # Postgres + Redis
pnpm --filter @icecrawl/api keys:create dev  # prints an API key once
pnpm --filter @icecrawl/engines exec playwright-core install chromium   # one-time browser download
pnpm dev                                     # server on :3002
```

<details>
<summary><b>Settings</b> (<code>.env</code>, model, search)</summary>

Settings come from the environment or a `.env` file next to `docker-compose.yml` (see `.env.example`). To search, set `ICECRAWL_SEARXNG_URL=http://searxng:8080` (and `SEARXNG_PORT` if 8080 is taken on the host). For a model on your own machine, for example Ollama: `ICECRAWL_LLM_PROVIDER=openai`, `ICECRAWL_LLM_BASE_URL=http://host.docker.internal:11434/v1`, `ICECRAWL_LLM_MODEL=<model>`; raise `ICECRAWL_LLM_TIMEOUT_MS` for slow or reasoning models.

</details>

## 🔌 Use it from Claude and Codex

The MCP server (`packages/mcp`) talks to your IceCrawl API (`ICECRAWL_API_URL`, `ICECRAWL_API_KEY`). Create a key with `pnpm --filter @icecrawl/api keys:create <name>` (or let `./scripts/setup-mac.sh` do it and print these settings for you).

> **Apps opened from the Dock or Finder** do not see the `node` from your shell. Use the full path to node (`which node`) as the `command` in the Claude desktop app and Codex settings.

### Claude Code

Stdio, run from anywhere. Replace `/path/to/IceCrawl` with where you cloned the repo (or use `npx -y @icecrawl/mcp` once the package is published):

```bash
claude mcp add icecrawl -e ICECRAWL_API_URL=http://localhost:3002 -e ICECRAWL_API_KEY=ic-... -- node /path/to/IceCrawl/packages/mcp/bin/icecrawl-mcp.mjs
```

### Claude desktop app

`~/Library/Application Support/Claude/claude_desktop_config.json` on a Mac:

```json
{
  "mcpServers": {
    "icecrawl": {
      "command": "node",
      "args": ["/path/to/IceCrawl/packages/mcp/bin/icecrawl-mcp.mjs"],
      "env": { "ICECRAWL_API_URL": "http://localhost:3002", "ICECRAWL_API_KEY": "ic-..." }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.icecrawl]
command = "node"
args = ["/path/to/IceCrawl/packages/mcp/bin/icecrawl-mcp.mjs"]
env = { ICECRAWL_API_URL = "http://localhost:3002", ICECRAWL_API_KEY = "ic-..." }
startup_timeout_sec = 30
tool_timeout_sec = 300
```

### Streamable HTTP

One shared server: run `ICECRAWL_MCP_TOKEN=secret node packages/mcp/bin/icecrawl-mcp.mjs --http --port 3003`, then `claude mcp add --transport http icecrawl http://127.0.0.1:3003/mcp --header "Authorization: Bearer secret"`. The HTTP server binds to loopback, checks the `Host` header, and refuses to listen on other addresses without `ICECRAWL_MCP_TOKEN`.

Tools: `icecrawl_scrape`, `icecrawl_map`, `icecrawl_crawl`, `icecrawl_check_crawl_status`, `icecrawl_cancel_crawl`, `icecrawl_batch_scrape`, `icecrawl_check_batch_status`, `icecrawl_search`, `icecrawl_extract`, `icecrawl_check_extract_status`, `icecrawl_search_index`, `icecrawl_agent`, `icecrawl_check_agent_status`, `icecrawl_list_interact_sessions`, `icecrawl_verify_receipt`. Set `ICECRAWL_MCP_TOOL_PREFIX=firecrawl_` to expose Firecrawl's tool names (`firecrawl_scrape`, `firecrawl_check_crawl_status`, ...) so existing prompts and skills keep working. `FIRECRAWL_API_URL` / `FIRECRAWL_API_KEY` are accepted as fallbacks.

What makes the results safe for agents:

- Page content is always inside `<<<ICECRAWL_UNTRUSTED_CONTENT ...>>>` markers with a random boundary, and the server instructions tell the model never to follow instructions found there.
- A scrape that is blocked, captcha-protected, behind a login, empty, truncated, or quarantined comes back as an error result and contains **no page text**.
- Prompt-injection findings (hidden text, instruction-like phrases, invisible characters, encoded payloads) are listed before the content. Set `ICECRAWL_INJECTION=quarantine` on the API to withhold high-severity pages entirely. The scanner is heuristic: a flag means "treat as data", and pages that discuss prompt injection will be flagged.
- Output is capped (`maxChars`, default 30000) and says when it was truncated; status tools page with `skip`.
- Every result carries a receipt id; `icecrawl_verify_receipt` checks the signature, the stored snapshot, and replays the converter and the injection scanner.

## 🧰 What it can do

| Feature | Endpoint | Guide |
| --- | --- | --- |
| Scrape a page to markdown, html, links, screenshot, JSON, summary | `POST /v2/scrape` | [Trust](#-why-you-can-trust-a-scrape) |
| Crawl a site, batch scrape, map URLs, signed webhooks | `/v2/crawl`, `/v2/batch/scrape`, `/v2/map` | [Guides](#-guides) |
| Parse files: pdf, docx, xlsx, pptx, odt, epub, rtf, csv | `POST /v2/parse` | [docs/stealth.md](docs/stealth.md) |
| Search the web, optionally scraping the results | `POST /v2/search` | [Guides](#-guides) |
| Extract structured data with your own model, with a grounding check | `POST /v2/extract` | [Guides](#-guides) |
| Research agent with a step trace | `POST /v2/agent` | [docs/agent.md](docs/agent.md) |
| Scriptable browser sessions | `/v2/interact` | [docs/interact.md](docs/interact.md) |
| Watch pages for changes, with diffs | `/v2/monitor` | [docs/monitor.md](docs/monitor.md) |
| Search what you already scraped, plus your own data sources | `POST /v2/index/search` | [docs/index.md](docs/index.md) |
| Retry blocked pages through your own proxies | `proxy: auto` | [docs/stealth.md](docs/stealth.md) |
| Web dashboard | `/dashboard/` | [docs/dashboard.md](docs/dashboard.md) |

## 🔐 Why you can trust a scrape

A trimmed scrape response:

```json
{
  "success": true,
  "data": {
    "markdown": "# Example Domain\n\nThis domain is for use in documentation examples...",
    "metadata": { "title": "Example Domain", "sourceURL": "https://example.com/", "statusCode": 200 },
    "trust": {
      "verdict": "ok",
      "confidence": 0.95,
      "reasons": [],
      "engine": "playwright",
      "receiptId": "17c14ed7-8b45-4822-91fe-64b79ed7c9d0",
      "injection": { "flagged": false, "count": 0 }
    }
  }
}
```

- A scrape only succeeds if its content is verified: bot-walls, captchas, login walls, empty, soft-404 and truncated pages come back as `success:false` with a typed `code`, not as page text.
- Every scrape (including failures) has a receipt: `GET /v2/receipts/{id}` returns URLs, status, the engines tried and why each was accepted or rejected, and SHA-256 hashes of the raw HTML and the markdown. The raw HTML is stored by hash.
- Private and loopback addresses are blocked (SSRF guard), including after redirects and DNS resolution. Set `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true` only for local testing.

### Verifying a scrape

Every receipt is signed with Ed25519 (RFC 8785 canonical JSON). The public keys are at `/.well-known/icecrawl-keys.json`; retired keys stay listed so old receipts keep verifying.

```bash
pnpm --filter @icecrawl/cli icecrawl verify <receiptId> --api http://localhost:3002 --key $KEY
```

It checks the signature, re-hashes the stored raw HTML (and screenshot), and re-runs the pinned HTML-to-markdown converter on that HTML to confirm it reproduces the recorded output hash. Offline: `icecrawl verify --receipt r.json --snapshot s.html --keys keys.json` using files saved from `GET /v2/receipts/{id}`, `/snapshot` and the keys endpoint.

Rotate the signing key with `pnpm --filter @icecrawl/api signing:rotate` (the old private key is kept as a `.bak` file, its public key is marked retired).

## 💻 Use it from code

```ts
import { IceCrawl } from '@icecrawl/sdk';
import { verifyReceiptRemote } from '@icecrawl/sdk/verify';

const ic = new IceCrawl({ apiUrl: 'http://localhost:3002', apiKey: process.env.ICECRAWL_API_KEY });
const doc = await ic.scrape('https://example.com', { formats: ['markdown'] });   // throws IceCrawlApiError (with .trust) if the page cannot be trusted
const site = await ic.crawl('https://docs.example.com', { limit: 20 });            // waits and collects every page
const report = await verifyReceiptRemote(ic, doc.trust.receiptId);
```

## 📚 Guides

<details>
<summary><b>Crawling, batch and webhooks</b></summary>

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

</details>

<details>
<summary><b>Search</b></summary>

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

</details>

<details>
<summary><b>Extract (with the grounding check)</b></summary>

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

</details>

<details>
<summary><b>Browser notes</b></summary>

The browser engine routes all traffic through an internal proxy that blocks private and loopback addresses at connect time, including redirects and subresources. For defence in depth, run the server in a container with restricted egress. Set `ICECRAWL_BROWSER=false` to use plain HTTP fetch only, or `ICECRAWL_PREFER_BROWSER=false` to try fetch first and use the browser only when the fetched page looks empty or blocked.

</details>

Short pages for the rest: [parse and proxies](docs/stealth.md) · [interact](docs/interact.md) · [agent](docs/agent.md) · [monitors](docs/monitor.md) · [index](docs/index.md) · [dashboard](docs/dashboard.md).

## ⚙️ Operations

- **Health:** `GET /health` says the process is up; `GET /ready` checks that Postgres and Redis answer (503 with the failing dependency otherwise, no API key needed). The compose file uses `/ready` as the API container's healthcheck.
- **Rate limiting:** `ICECRAWL_RATE_LIMIT_PER_MINUTE=N` (default 0, off) limits the requests that start work (POST) per API key, counted in Redis so every API process shares the limit. Over the limit the answer is `429 RATE_LIMITED` with `Retry-After` and `X-RateLimit-*` headers. Reading and polling are never limited.
- **Lost jobs:** a job that is still running `ICECRAWL_JOB_MAX_RUNTIME_HOURS` (default 6) after it started is marked failed, because its worker is presumed gone; the same sweep (every five minutes) deletes expired jobs. Raise the limit for very large crawls.
- **Logs:** JSON request logs on stdout, level from `ICECRAWL_LOG_LEVEL` (`fatal`, `error`, `warn`, `info` default, `debug`, `trace`, `silent`). The Authorization header is redacted.
- **Usage:** `/v2/team/credit-usage`, `/token-usage`, `/queue-status`, `/activity` and the `historical` variants report metering for the calling API key (scrapes, and the tokens that `/extract` jobs used). There is no billing: balances read 1,000,000,000.
- **Storage:** raw HTML snapshots are files addressed by hash under `ICECRAWL_SNAPSHOT_DIR`. They are not deleted when jobs expire; prune the directory yourself if disk space matters (a receipt whose snapshot is gone can no longer be fully verified).
- **Back up:** Postgres (receipts, jobs, API keys), the signing key file `ICECRAWL_SIGNING_KEY_FILE`, the webhook secret file and the snapshot directory.
- **Upgrading:** migrations run on start. Receipts made with an older converter version report the `replay` check as skipped (the converter is pinned per receipt); their signature and snapshot checks still work.

## ✅ Quality gates and tests

<details>
<summary><b>Quality gates</b></summary>

- **Verdict benchmark** (`pnpm bench:verdicts`, also a test): about sixty labelled pages (articles, docs, forums, other languages, pages that merely talk about captchas or 404s, bot walls, captchas, login walls, empty and JavaScript-only pages, soft 404s, error statuses, redirect loops, truncated bodies). The target is zero pages wrongly accepted, zero good pages wrongly refused and every verdict exactly as labelled. Weaknesses that are known and not yet fixed are marked `knownGap` in `packages/fixtures/src/corpus.ts`, printed by the report and not counted; when one gets fixed the test says so.
- **Injection-scan benchmark:** the same corpus has six attack pages (visible, hidden, comment, zero-size, base64, role marker) that must be flagged and thirteen clean pages that must not.
- **OpenAPI conformance:** the responses of every implemented endpoint are validated against Firecrawl's published v2 OpenAPI document, which `node scripts/fetch-openapi.mjs` downloads (it is not part of this repository). IceCrawl's own error codes (for example 502 for an untrustworthy page) are intentional differences and must keep the `{success:false, code, error}` shape.
- **Official SDKs:** `@mendable/firecrawl-js` (pinned) runs in the test suite and `firecrawl-py` in CI, both against the real server code.
- **Packaging:** `node scripts/pack-smoke.mjs` builds the publishable packages, installs the tarballs in an empty project and uses the SDK, the MCP server (through a real MCP client) and the CLI.

The corpus is synthetic and was written with the classifier's rules in mind: it guards against regressions and documents behaviour, it does not measure accuracy on the real web.

</details>

```bash
pnpm test                                    # unit tests; Postgres, Redis and browser tests are skipped without them
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test   # everything
node scripts/fetch-openapi.mjs               # once: enables the OpenAPI conformance tests
pnpm bench:verdicts                          # verdict and injection-scan report
pnpm release:check                           # type check, all tests, build, pack and use the packages
```

## 📖 Documentation

| | |
| --- | --- |
| [docs/macos.md](docs/macos.md) | Setup on a Mac for Claude and Codex |
| [docs/dashboard.md](docs/dashboard.md) | The web dashboard and its security model |
| [docs/stealth.md](docs/stealth.md) | File parsing, proxy pools, `proxy: auto` |
| [docs/interact.md](docs/interact.md) | Browser sessions and code execution |
| [docs/agent.md](docs/agent.md) | The research agent |
| [docs/monitor.md](docs/monitor.md) | Change monitors |
| [docs/index.md](docs/index.md) | Index search and data providers |
| [docs/RELEASING.md](docs/RELEASING.md) | Publishing the packages |
| [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) | Project housekeeping |

## 📄 License

Apache-2.0
