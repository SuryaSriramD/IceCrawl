# Interact sessions

`/v2/interact` gives you a persistent headless browser and lets you drive it with code, as in Firecrawl v2.

```bash
ID=$(curl -s -X POST localhost:3002/v2/interact -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"ttl":300}' | jq -r .id)
curl -s -X POST localhost:3002/v2/interact/$ID/execute -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"code":"await page.goto(\"https://example.com\"); return await page.title()"}'
curl -s -X DELETE localhost:3002/v2/interact/$ID -H "Authorization: Bearer $KEY"
```

- Routes: `POST/GET /v2/interact`, `POST /v2/interact/{id}/execute`, `DELETE /v2/interact/{id}`, and for the browser behind a scrape `POST/DELETE /v2/scrape/{id}/interact` (the session opens on the scrape's final URL the first time code runs).
- Code runs as `node` with `page`, `context`, `browser` and `console` in scope; `return` a value to get it back in `result`. `python` and `bash` return `UNSUPPORTED_OPTION`.
- State (cookies, the open page) lasts until the session is deleted, expires (`ttl`, 30–3600 s) or sits idle past `activityTtl`. A server keeps at most `ICECRAWL_INTERACT_MAX_SESSIONS` (5) sessions. Sessions belong to the API key that made them and live in the API process (they do not survive a restart).
- The browser's traffic goes through the same SSRF guard as scrapes. `profile`, `location`, `blockAds` and `streamWebView` are accepted and ignored (named in `warning`); there is no live view and no CDP URL is returned.

- Each session's Chromium opens a remote-debugging port on `127.0.0.1` without authentication (that is how code attaches to it). The session's egress proxy refuses requests to that port, so a page cannot reach the browser that renders it, even with `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true`. Other processes on the same machine can still connect to it: do not run IceCrawl with interact on a shared host.

## Turning on code execution

Executing code is **off by default**. Set `ICECRAWL_INTERACT_CODE=true` to enable it.

This is not a sandbox. The code runs in a child Node process with an empty environment (it cannot read your API keys, database URL or signing key from the environment), a 256 MB heap limit and a hard timeout, but it still runs with the server's operating system rights: it can read files the server can read and open network connections that do not go through the browser. Enable it only where every API key holder is trusted to run code on that machine, or run IceCrawl itself in a container. The MCP server does not expose code execution.
