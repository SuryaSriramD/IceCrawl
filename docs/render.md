# IceCrawl on Render's free tier

This runs IceCrawl on Render without Docker on your computer, so Claude and Codex can use it any time. It is a light setup: **no browser engine**, free instances that sleep, and a free database that expires. Read "What you give up" first. The lean image and its settings were run and checked locally in Docker (it starts without the browser, scrapes, answers 501 for interact, and keeps its signing key across restarts); the Render steps themselves were written from Render's documentation and have not been run on a real Render account, so check each step against Render's current screens and limits.

## What you give up

- **No browser.** A free instance (about 512 MB of memory) cannot run Chromium, so the image is built without it and `ICECRAWL_BROWSER=false`. Pages are fetched over plain HTTP: static and server-rendered pages work; pages that need JavaScript to show their content come back thin or incomplete (a page with no text at all is reported as `empty`, but one that shows only its menu and title can still pass as a success). Screenshots, actions and `/v2/interact` are unavailable.
- **Sleeping.** A free web service sleeps after about 15 minutes without requests. The first request afterwards takes up to a minute while it starts. The MCP client waits up to 5 minutes, so it works, but the first tool call after a pause is slow.
- **The free database expires** after about 30 days. When it does, API keys, receipts, jobs and monitors are gone. Upgrade the database to a paid plan to keep them, or recreate it and make new keys.
- **No persistent disk.** Stored page snapshots live in `/tmp` and are lost whenever the service restarts, so old receipts can still be checked for their signature but not against the saved page. The signing key does not depend on the disk (see step 1), so receipts stay verifiable.
- No shell on a free service: you create API keys from your own computer (step 4).

If these are too much, a small paid instance or a cheap VPS running `docker compose` (see the README) gives you the whole thing.

## Steps

1. **Make a signing key.** On your computer:
   ```bash
   openssl genpkey -algorithm ed25519 | base64 -w0      # on a Mac: openssl genpkey -algorithm ed25519 | base64
   ```
   Keep the output; it is your `ICECRAWL_SIGNING_KEY`. Do not commit it.
2. **Create the blueprint.** In the Render dashboard choose New > Blueprint, pick your copy of this repository (the one with `render.yaml`) and paste the key when it asks for `ICECRAWL_SIGNING_KEY`. Render creates a web service, a free Postgres database and a free Key Value (Redis). The first build takes a few minutes. When `/ready` answers, the service is up; migrations run on start.
3. **Note the address**, for example `https://icecrawl-xxxx.onrender.com`. `https://<address>/dashboard/` is the dashboard.
4. **Create an API key** from your computer, in a clone of the repository (`pnpm install` once). In the Render dashboard open the database and copy its **External Database URL**, then add `?sslmode=require` to the end:
   ```bash
   DATABASE_URL='postgres://...render.com/icecrawl?sslmode=require' pnpm --filter @icecrawl/api keys:create me
   ```
   It prints the key once.
5. **Connect Claude and Codex.** The MCP server runs on your computer and talks to your Render service. Use the commands and settings from the README (or `docs/macos.md`), with these two values:
   ```
   ICECRAWL_API_URL=https://icecrawl-xxxx.onrender.com
   ICECRAWL_API_KEY=ic-...
   ```
   Codex: set `startup_timeout_sec = 30` and `tool_timeout_sec = 300` so a cold start does not time out.

## Things to know

- The API is public on the internet, protected by API keys (authentication is on by default). Keep the keys private, and do not turn on `ICECRAWL_ALLOW_PRIVATE_NETWORKS`.
- `ICECRAWL_RATE_LIMIT_PER_MINUTE` is set to 60 per key in `render.yaml`; change it there.
- Settings you can add in the service's Environment tab: a model for `extract` and the agent (`ICECRAWL_LLM_PROVIDER`, `ICECRAWL_LLM_MODEL`, `ICECRAWL_LLM_API_KEY`), and `ICECRAWL_SEARXNG_URL` if you host a SearXNG somewhere. Without them those endpoints answer 501.
- Requests leave from a shared Render address, and some sites block those addresses.
- Free instance hours and limits change; check Render's pricing page before relying on this.
