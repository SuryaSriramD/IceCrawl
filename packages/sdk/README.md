# @icecrawl/sdk

Typed client for the [IceCrawl](https://github.com/SuryaSriramD/IceCrawl) API (Firecrawl v2 compatible), plus receipt verification.

```ts
import { IceCrawl } from '@icecrawl/sdk';
import { verifyReceiptRemote } from '@icecrawl/sdk/verify';

const ic = new IceCrawl({ apiUrl: 'http://localhost:3002', apiKey: process.env.ICECRAWL_API_KEY });
const doc = await ic.scrape('https://example.com', { formats: ['markdown'] }); // throws IceCrawlApiError (with .trust) if the page cannot be trusted
const found = await ic.search('open source web scraper', { limit: 5 });
const data = await ic.extract(['https://example.com/blog/*'], { prompt: 'Titles of the posts' });
const report = await verifyReceiptRemote(ic, doc.trust.receiptId); // signature, snapshot hash, converter and scanner replay
```

Methods: `scrape`, `map`, `crawl` / `startCrawl` / `getCrawlStatus`, `batchScrape`, `search`, `extract` / `startExtract` / `getExtractStatus`, `getReceipt`, `getSnapshot`, `getPublicKeys`. See the main README for the server.
