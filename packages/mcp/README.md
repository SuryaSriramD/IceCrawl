# @icecrawl/mcp

MCP server for [IceCrawl](https://github.com/SuryaSriramD/IceCrawl): scrape, map, crawl, batch scrape, search, extract and receipt verification for Claude, Codex and other MCP clients. Page text is always wrapped as untrusted data and failed scrapes never return page text.

```bash
claude mcp add icecrawl -e ICECRAWL_API_URL=http://localhost:3002 -e ICECRAWL_API_KEY=ic-... -- npx -y @icecrawl/mcp
```

Environment: `ICECRAWL_API_URL`, `ICECRAWL_API_KEY`, `ICECRAWL_MCP_TOOL_PREFIX` (default `icecrawl_`; `firecrawl_` for drop-in names), `ICECRAWL_MCP_MAX_CHARS`. Streamable HTTP: `--http --port 3003` with `ICECRAWL_MCP_TOKEN`. Full setup for Claude Desktop and Codex is in the main README.
