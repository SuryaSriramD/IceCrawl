# Dashboard

IceCrawl serves a small web dashboard at `/dashboard/` (the root URL redirects there). It is static: you paste an API key, and the page calls the same `/v2` routes as any client. Turn it off with `ICECRAWL_DASHBOARD=false`.

- **Overview:** scrapes and model tokens this month, running jobs, scrapes per month, recent activity, how to create keys.
- **Playground:** scrape (formats, proxy tier), parse a file, search the web or the stored pages, extract, run the agent with its trace. Every result shows the trust panel: verdict, reasons, engine, injection findings, receipt.
- **Jobs:** look up a crawl, batch, extract or agent job by id; recent scrapes with filters.
- **Receipts:** opens a receipt and checks it in your browser: the Ed25519 signature (Web Crypto) and the stored snapshot and screenshot hashes. Replaying the converter and scanner needs the CLI, and the page prints the command.
- **Monitors:** list, create, pause, delete, run now; checks and per-page results with receipt links and coloured diffs.

## Keys and security

- **No key management in the UI.** Creating keys needs access to the server (`pnpm --filter @icecrawl/api keys:create <name>`), so that a leaked key cannot mint more keys.
- The key is held in the browser tab's session storage, sent only to the server that served the page, and forgotten when the tab closes.
- Everything from the web (page text, snippets, diffs, monitor names) is drawn as text, never as markup. The page is served with a policy (`default-src 'none'`, scripts, styles, images and connections only from its own origin) so that even a mistake in the code cannot run a script from a scraped page.
- Stored snapshots (`GET /v2/receipts/{id}/snapshot`) are sent with `Content-Security-Policy: sandbox` and `nosniff`, so opening one never runs the page.
- The dashboard has no build step: `packages/dashboard/public` holds plain ES modules and CSS, read into memory when the server starts.

## Not included

User accounts, roles and key management; live job updates (pages poll); a visual editor for monitor targets other than scrape URLs (create crawl and search targets through the API).
