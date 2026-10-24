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
