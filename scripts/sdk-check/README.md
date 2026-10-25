# SDK tolerance check

Result (2026-10-24): `@mendable/firecrawl-js` 4.51.0 accepts a successful `/v2/scrape` response containing `data.trust`; `doc.trust` is passed through intact.

To repeat: in a scratch folder outside the repo run `npm install @mendable/firecrawl-js`, then construct `new Firecrawl({ apiKey, apiUrl: 'http://localhost:3002' })`, call `app.scrape('https://example.com', { formats: ['markdown'] })` and print `doc.trust`.

## Automated checks

- **Node:** `packages/api/test/sdk-conformance.test.ts` runs the pinned `@mendable/firecrawl-js` (scrape, map, crawl, batchScrape, search, extract) against the real server code on every test run.
- **Python:** start the conformance server and run the script (needs `pip install firecrawl-py==4.54.0`):

  ```bash
  PORT=3010 pnpm tsx packages/api/test/support/conformance-server.ts &
  python scripts/sdk-check/check_python.py
  ```

  The conformance server is a self-contained IceCrawl (in-memory store and queue, scripted pages, a fake search provider and a fake language model), so no database or network is needed. CI runs the same two commands.
