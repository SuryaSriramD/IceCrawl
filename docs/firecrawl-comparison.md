# IceCrawl vs Firecrawl: a side-by-side test

Run on 2026-11-01. IceCrawl: a local Docker stack (browser engine, no proxies, a CPU-only local model). Firecrawl: the hosted API through its MCP scrape and search tools, `maxAge: 0` (no cache), default settings. Both asked for markdown with the default "main content" setting unless noted.

**What this is not.** One run of 15 pages and 2 searches, not a benchmark. Firecrawl's side was read through the tool output, so content is compared by probes (phrases, authors, tags, link targets taken from what Firecrawl returned), not by a full diff. Firecrawl's latency is not visible through the tool, so only IceCrawl's is reported. Crawl, map, batch, extract, agent, interact, monitor and file upload could not be compared: the Firecrawl tools available here only scrape and search.

## Results

| Page | Firecrawl | IceCrawl (default) | IceCrawl (`onlyMainContent: false`) |
| --- | --- | --- | --- |
| example.com | text and link complete | identical | identical |
| httpbin `/html` (static article) | complete | identical (5/5 probes) | identical |
| quotes.toscrape.com `/js/` (rendered by JavaScript) | all 10 quotes, authors and tags (tags run together: `changedeep-thoughts`) | all quotes, but **tags missing and the first quote's author missing** (27/39) | complete, tags separated (39/39) |
| quotes `/tableful/` (table layout) | pipe table with `<br>` | 40/40 probes, 35 links (Firecrawl 35) | same |
| RFC 1149 (preformatted text) | complete, plus "Light / Dark / Auto" theme noise | 11/12 | 12/12 |
| sqlite.org/about | complete, including the "Executive Summary" list | **Executive Summary list missing** (8/15) | 14/15 |
| one-page PDF | text complete, `##` headings | same text, plain | n/a |
| bot.sannysoft.com | every fingerprint test passes (real-looking Chrome on real hardware) | **fails headless checks** (webdriver, `window.chrome`, plugins) | same |
| paulgraham.com essay | returned as a noisy layout table with images and `<br>` | **clean article** (2.6k characters) | essay kept with paragraphs (after fix) |
| `/this-page-does-not-exist` (404) | returns the page body as content, status 404 in metadata | typed error `TARGET_ERROR (http_404)` | n/a |
| httpbin `/status/403` | retried through a stealth proxy, returned empty markdown | typed error `BLOCKED` (no proxy pools configured) | n/a |
| nowsecure.nl (Cloudflare Turnstile) | returned the "Verify you are human" widget text as page content | typed error `CAPTCHA` | n/a |
| github.com/settings/profile (login redirect) | returned the sign-in page as content | accepted as `ok` (**missed**, fixed below) | n/a |

Search ("open source alternative to firecrawl web scraping API", 8 results each): 3 of 8 URLs in common (usestring, gumloop, nimbleway). Firecrawl returned page excerpts inside each result; IceCrawl (SearXNG) returned titles and snippets. Both returned the number asked for.

Structured extraction (10 quotes into a JSON schema): Firecrawl returned all 10 with authors (5 credits). IceCrawl's request timed out after 300 s because the only model available was a 30B reasoning model running mostly on CPU (about 24 s for "Say OK"); a smaller extraction on the same model had worked earlier with every value grounded. This says nothing about IceCrawl's extraction quality.

IceCrawl latency (warm, browser engine): 1.4 to 5 s per page; the first scrape after start took 12 s. Firecrawl credits used: 1 per scrape, 5 for the JSON scrape, 2 for the search.

## What the test showed

**Where IceCrawl was better**
- It refused to pass off a captcha page, a 403 and a 404 as content. Firecrawl returned a Cloudflare challenge widget and a 404 page as content with a 200-style success (the status is in the metadata, but a caller has to look).
- Clean article extraction on essay-style pages.
- Receipts: every IceCrawl result carries a signed receipt that can be re-checked; Firecrawl has no equivalent.

**Where Firecrawl was better**
- **Completeness on non-article pages.** IceCrawl's default main-content mode used a reading-mode algorithm (Readability) that dropped link-dense lists, tag rows and some table content. It dropped sqlite's summary list and the quotes' tags. Firecrawl kept more. This was reworked afterwards: see the last section.
- **Looking like a person.** In direct mode IceCrawl's browser fails the usual headless checks (and says so in its user agent, by design). Firecrawl passes them. IceCrawl only hides those markers for requests that go through a configured proxy pool, which was not set up here.
- **Getting through blocks.** Firecrawl escalated the 403 to a stealth proxy by itself. IceCrawl can escalate only to proxies you supply.
- Search results with page excerpts, and a hosted extraction model.

**Defects found in IceCrawl and fixed in this commit**
- A sign-in page with a footer (longer than 600 characters) was accepted as a good page. It is now classified `login_wall` when it has a password field and a sign-in title or heading (`github.com/settings/profile` now returns `LOGIN_WALL`). One known gap in the benchmark corpus is closed.
- Data tables whose cells held code or long text were flattened with neighbouring cells glued together (`PHANTOM_UAok`), and an essay inside a layout table became one giant table cell. Layout tables now keep each cell as its own block, and data tables stay pipe tables.

**Not fixed**
- Direct-mode browser fingerprint (by design; see `docs/stealth.md`).

## After reworking the default main-content mode

The reading-mode algorithm was replaced (converter version 4). The default now picks the page's `<main>` or its only substantial `<article>` (otherwise the body) and removes navigation, banners, footers, sidebars, consent notices and hidden elements, without scoring text by link density. Same pages, same probes, run again:

| Page | Before (default) | After (default) | Firecrawl |
| --- | --- | --- | --- |
| quotes `/js/` | 27/39 | **39/39** (tags and authors present) | complete |
| sqlite.org/about | 8/15 | **14/15** (summary list back) | complete |
| bot.sannysoft.com | 4/13 | **11/13** (proper tables) | complete |
| RFC 1149 | 11/12 | **12/12** | 12/12 |
| example, httpbin, tableful, PDF | complete | complete | complete |
| paulgraham essay | clean, 2.6k characters | essay plus a short block of link rows, 4.0k characters | noisy layout table |
| Wikipedia "Robots.txt" | n/a | 54k characters, begins with the language list | not measured |

The price of completeness: pages with a lot of link furniture inside the content (Wikipedia's language list and reference lists, essays with translation links) come out longer and less tidy than before. That is the same trade Firecrawl makes. Use `excludeTags` to cut a known block, or `includeTags` to take one. The hostile and error cases are unchanged: the captcha, 403, 404 and login-wall pages are still refused. The 933 existing tests, the verdict benchmark and the pack smoke test pass.
