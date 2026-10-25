# Index

The index answers "what do I already have about this?" without fetching anything. It searches two kinds of source:

- **`scrapes`**: the pages your API key has scraped successfully (scrape, parse, crawl, batch, search-with-scrape, monitors, the agent). Postgres full-text search over the stored markdown, the latest copy of each URL, best match first. Blocked, captcha, empty and quarantined scrapes are not indexed, and one API key never sees another key's pages. Every result carries `receiptId`, the receipt of the stored scrape, so the page can be verified.
- **Providers**: external data sets you choose. IceCrawl does not ship any data; Firecrawl's hosted developer, government and research indexes are curated data sets that cannot be reproduced here, so this is the mechanism and you supply the sources.

```bash
curl -s -X POST localhost:3002/v2/index/search -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"enterprise pricing","limit":5}'
curl -s localhost:3002/v2/index/providers -H "Authorization: Bearer $KEY"
```

Request fields: `query` (required), `limit` (1-50, default 10), `sources` (`"scrapes"` and/or provider names, default all), `urlPrefix` (restricts stored pages), `timeout` (ms for providers). Results are `{ source, title, url, snippet, score?, receiptId?, createdAt?, trust? }`; stored-page results come first, then each provider's results in the order of the file. Results of different sources are not ranked against each other. A provider that fails costs only its own results and is named in `warning`.

## Providers

Set `ICECRAWL_PROVIDERS_FILE` to a JSON file listing HTTP sources that answer with JSON:

```json
[
  {
    "name": "papers",
    "description": "Preprints",
    "url": "https://api.example.org/search?q={query}&n={limit}",
    "headers": { "authorization": "Bearer ${PAPERS_API_KEY}" },
    "resultsPath": "data.items",
    "fields": { "title": "name", "url": "link", "snippet": "abstract" }
  }
]
```

- `{query}` (URL-encoded) and `{limit}` are replaced in the URL. `${NAME}` in a header value is replaced from the environment when the server starts, so secrets stay out of the file; a missing variable stops the server with its name.
- `resultsPath` is a dot path to the result array (empty if the answer is the array). `fields` name the properties holding the title, URL and snippet (defaults `title`, `url`, `description`). Results without an `http(s)` URL are dropped.
- Requests go through the same SSRF guard as scrapes (private addresses refused unless `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true`), time out, and are cut at 1 MB.
- A code plugin is a `DataProvider` (`{ name, description, search({ query, limit, timeoutMs }) }`) passed to `buildApp({ providers })`.

## Trust

Provider results have no receipt: they are what a third party said. Snippets from both kinds of source are scanned for prompt injection like search results (`flag` marks them under `trust.snippetInjection`, `quarantine` withholds the high-severity ones). To rely on a provider result, scrape its URL.

## Not included

No embeddings or vector search: matching is by words (Postgres `websearch_to_tsquery`, language neutral), so synonyms are not found. The `index` engine that serves stored pages instead of fetching (`maxAge`) is not implemented.
