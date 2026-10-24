# IceCrawl

Open-source, Firecrawl-v2-compatible web scraping API where every scrape comes with a verdict and a provenance receipt.

> Status: phase 3 (crawl layer). Scrape, crawl, batch scrape and map work, with signed webhooks. Search, extract, MCP and the rest follow the roadmap in `docs/superpowers/specs/2026-10-24-icecrawl-design.md`.

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

## Tests

```bash
pnpm test                                    # unit tests, no services needed
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl pnpm test   # also Postgres + e2e
```

## License

Apache-2.0
