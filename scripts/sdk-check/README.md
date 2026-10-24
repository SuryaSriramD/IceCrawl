# SDK tolerance check

Result (2026-10-24): `@mendable/firecrawl-js` 4.51.0 accepts a successful `/v2/scrape` response containing `data.trust`; `doc.trust` is passed through intact.

To repeat: in a scratch folder outside the repo run `npm install @mendable/firecrawl-js`, then construct `new Firecrawl({ apiKey, apiUrl: 'http://localhost:3002' })`, call `app.scrape('https://example.com', { formats: ['markdown'] })` and print `doc.trust`.
