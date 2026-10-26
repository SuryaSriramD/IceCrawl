#!/usr/bin/env bash
# Sets IceCrawl up on a Mac: starts the stack in Docker, creates an API key and prints the settings for Claude and Codex.
#
#   ./scripts/setup-mac.sh                 # stack + key + config to paste
#   ./scripts/setup-mac.sh --search        # also start SearXNG so the search tools work
#   ./scripts/setup-mac.sh --claude        # also register the server with the `claude` CLI (Claude Code)
#
# It changes nothing outside this folder, except `--claude`, which runs `claude mcp add`.
# Codex and the Claude desktop app are never edited: their settings are printed for you to paste.
set -euo pipefail

SEARCH=0
CLAUDE=0
for arg in "$@"; do
  case "$arg" in
    --search) SEARCH=1 ;;
    --claude) CLAUDE=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || [ -n "${ICECRAWL_SETUP_ANY_OS:-}" ] || die "this script is for macOS (set ICECRAWL_SETUP_ANY_OS=1 to try it elsewhere)"
cd "$(dirname "$0")/.."
REPO="$(pwd)"

say "Checking tools"
command -v docker >/dev/null || die "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and run this again."
command -v node >/dev/null || die "Node.js is not installed. Install Node 20.12 or newer (for example: brew install node@22)."
NODE_BIN="$(command -v node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' || die "Node $(node -v) is too old; IceCrawl needs 20.12 or newer."
if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null || die "pnpm is not installed and corepack is not available. Run: npm install -g pnpm"
  corepack enable || die "could not enable pnpm through corepack. Run: npm install -g pnpm"
fi
echo "node $(node -v) at $NODE_BIN, pnpm $(pnpm -v), docker ok"

say "Installing dependencies (the MCP server runs from this folder)"
pnpm install --frozen-lockfile

# Settings for the containers live in .env (git-ignored). Existing values are never overwritten.
touch .env
if [ "$SEARCH" = "1" ]; then
  grep -q '^ICECRAWL_SEARXNG_URL=' .env || echo 'ICECRAWL_SEARXNG_URL=http://searxng:8080' >> .env
  if lsof -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1 && ! grep -q '^SEARXNG_PORT=' .env; then
    echo 'SEARXNG_PORT=8082' >> .env
    echo "port 8080 is in use on this Mac, so SearXNG will listen on 8082"
  fi
fi

say "Starting IceCrawl in Docker (the first build takes several minutes)"
if [ "$SEARCH" = "1" ]; then docker compose --profile search up -d --build; else docker compose up -d --build; fi

say "Waiting for the API"
for _ in $(seq 1 90); do
  if curl -fsS -m 3 http://localhost:3002/ready >/dev/null 2>&1; then READY=1; break; fi
  sleep 3
done
[ "${READY:-0}" = "1" ] || die "the API did not become ready. Look at: docker compose logs api"

say "Creating an API key"
KEY_NAME="mac-$(date +%Y%m%d%H%M%S)"
KEY="$(docker compose exec -T api pnpm --filter @icecrawl/api keys:create "$KEY_NAME" 2>/dev/null | grep -Eo 'ic-[0-9a-f]+' | head -1)"
[ -n "$KEY" ] || die "could not read the new API key. Create one by hand: docker compose exec api pnpm --filter @icecrawl/api keys:create me"

MCP_BIN="$REPO/packages/mcp/bin/icecrawl-mcp.mjs"
URL="http://localhost:3002"

if [ "$CLAUDE" = "1" ]; then
  command -v claude >/dev/null || die "the claude CLI was not found; skipping --claude. Use the Claude Code command below instead."
  say "Registering with Claude Code"
  claude mcp remove icecrawl >/dev/null 2>&1 || true
  claude mcp add icecrawl -e "ICECRAWL_API_URL=$URL" -e "ICECRAWL_API_KEY=$KEY" -- "$NODE_BIN" "$MCP_BIN"
fi

cat <<EOF

IceCrawl is running.
  API        $URL
  Dashboard  $URL/dashboard/   (paste the key below)
  API key    $KEY      (shown once; keep it private)

Use the full path to node below: apps started from the Dock or Finder do not see the node from your shell.

--- Claude Code (terminal) ---
claude mcp add icecrawl -e ICECRAWL_API_URL=$URL -e ICECRAWL_API_KEY=$KEY -- '$NODE_BIN' '$MCP_BIN'

--- Claude desktop app: ~/Library/Application Support/Claude/claude_desktop_config.json ---
{
  "mcpServers": {
    "icecrawl": {
      "command": "$NODE_BIN",
      "args": ["$MCP_BIN"],
      "env": { "ICECRAWL_API_URL": "$URL", "ICECRAWL_API_KEY": "$KEY" }
    }
  }
}
(merge it into the file if it already has other servers, then quit and reopen Claude)

--- Codex: ~/.codex/config.toml ---
[mcp_servers.icecrawl]
command = "$NODE_BIN"
args = ["$MCP_BIN"]
env = { ICECRAWL_API_URL = "$URL", ICECRAWL_API_KEY = "$KEY" }
startup_timeout_sec = 30
tool_timeout_sec = 300

Stop it:   docker compose stop        Start again: docker compose up -d
EOF
