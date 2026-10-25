# Parse, proxies and escalation

## Parsing files (`POST /v2/parse`)

Upload a file as `multipart/form-data` (field `file`, optional field `options` with a JSON object) and get the same document a scrape returns: markdown, a `trust` block, a signed receipt and a stored snapshot.

```bash
curl -s http://localhost:3002/v2/parse -H "Authorization: Bearer $KEY" -F file=@report.pdf -F 'options={"formats":["markdown"]}'
```

- Formats: pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, csv, html, txt (`GET /v2/parse/formats`). Legacy `.doc`, `.xls`, `.ppt` and `.xlsb` are listed as `available: false`; convert them first.
- Options honoured: `formats` (including `json` and `summary`), `onlyMainContent`, `includeTags`, `excludeTags`, `removeBase64Images`. Others are ignored and named in `warnings`.
- The receipt URL is `upload://<sha256>/<filename>`. The same converters read documents fetched by URL (`.pdf` and Office links), so `scrape` and `parse` give the same markdown for the same bytes and `icecrawl verify` replays both.
- PDF: the text layer only. A scanned PDF is reported as unreadable (no OCR). Spreadsheets become one table per sheet (dates as ISO text), slides become `## Slide n` sections.
- Limits: `ICECRAWL_MAX_UPLOAD_BYTES` (50 MiB). Zip based formats are refused when their declared unpacked size exceeds 200 MiB or they declare XML entities; at most 500 pages, slides or sheets and 20 000 table rows are converted (a warning says when output was cut).
- Not exposed over MCP on purpose: an agent could be told to upload any local file.

## Proxy pools and `proxy: auto`

IceCrawl does not sell or bundle proxies. You supply them:

```
ICECRAWL_PROXIES_ENHANCED=http://user:pass@proxy1.example:8080,http://proxy2.example:8080
ICECRAWL_PROXIES_STEALTH=http://user:pass@residential.example:9000
ICECRAWL_PROXY_DOMAIN_INTERVAL_MS=1000
```

| `proxy` in the request | Behaviour |
| --- | --- |
| `basic` | direct connection, honest `IceCrawl` user agent |
| `enhanced`, `stealth` | only that tier; `UNSUPPORTED_OPTION` when the tier has no proxies |
| `auto` (default) | direct first; when the verdict is `blocked` or `captcha` retry through `enhanced`, then `stealth`, for the tiers that have proxies |

- Requests through a pool proxy use a regular Chrome user agent and, in the browser engine, hide the common automation markers (`navigator.webdriver`, languages, `window.chrome`). Direct requests keep the honest user agent.
- Each attempt records its `proxyTier` in the receipt's engine chain. Proxy URLs (credentials) never appear in receipts, responses or errors.
- Requests to one host through a pool proxy are spaced `ICECRAWL_PROXY_DOMAIN_INTERVAL_MS` apart (default 1000, 0 = off; per process). Crawls keep honouring robots.txt and `Crawl-delay`.
- A proxy that fails is skipped for a minute.
- If every tier is still refused the scrape reports `blocked` or `captcha`; nothing is solved or bypassed. Captcha solving is not implemented.

### Security notes

- Requests through a pool proxy leave from the proxy's network. IceCrawl resolves the target locally first and refuses private addresses, but the proxy resolves again, so this is a check and not a guarantee, and the browser's redirect and subresource requests are not individually checked. Run pool proxies outside your private network; a proxy entry that points at a private address is refused unless `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true`.
- Only `http:` and `https:` proxies are supported (no SOCKS).
- You are responsible for having the right to use the proxies and to access the sites you scrape through them.
