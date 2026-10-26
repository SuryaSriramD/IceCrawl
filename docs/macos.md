# IceCrawl on a Mac, for Claude and Codex

IceCrawl runs in Docker (the API, a worker, Postgres, Redis and the browser) and the MCP server runs on the Mac next to your apps. Both Intel and Apple Silicon work; the images are multi-architecture. This was written and checked on Windows and Linux: the Mac steps have not been run on a Mac, so if one fails, the message it prints says which.

## One command

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running), Node 20.12 or newer (`brew install node@22`) and git.

```bash
git clone https://github.com/SuryaSriramD/IceCrawl.git
cd IceCrawl
./scripts/setup-mac.sh --search      # --search also starts SearXNG; leave it out if you don't need web search
```

The first run builds the images (several minutes). At the end it prints an API key and the exact settings for each app. Add `--claude` to have it register the server with the `claude` command for you.

## Claude and Codex

- **Claude Code:** run the `claude mcp add ...` command it prints.
- **Claude desktop app:** merge the JSON it prints into `~/Library/Application Support/Claude/claude_desktop_config.json`, then quit and reopen Claude.
- **Codex:** paste the TOML it prints into `~/.codex/config.toml`.

Apps opened from the Dock do not see the `node` from your shell profile, so the settings use the full path to node. If you later switch Node versions (nvm, brew), rerun the script and paste the new path.

Then ask Claude or Codex to scrape a page. Page text comes back inside untrusted-content markers, and pages that are blocked or behind a captcha come back as errors without page text.

## Everyday use

```bash
docker compose stop            # stop IceCrawl
docker compose up -d           # start it again
docker compose logs -f api     # see what it is doing
open http://localhost:3002/dashboard/    # dashboard (paste the API key)
```

- A second key: `docker compose exec api pnpm --filter @icecrawl/api keys:create another`.
- A model for `extract` and the agent: put `ICECRAWL_LLM_PROVIDER`, `ICECRAWL_LLM_MODEL` and `ICECRAWL_LLM_API_KEY` in `.env` and run `docker compose up -d`. For Ollama on the Mac use `ICECRAWL_LLM_PROVIDER=openai` and `ICECRAWL_LLM_BASE_URL=http://host.docker.internal:11434/v1`.
- Keep the API on this Mac only: it listens on `localhost:3002`. Do not expose it to a network without HTTPS and keys you trust.
- Give Docker Desktop at least 4 GB of memory: the browser needs it.
