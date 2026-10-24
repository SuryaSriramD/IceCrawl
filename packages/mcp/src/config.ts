import { IceCrawl } from '@icecrawl/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createIceCrawlMcpServer } from './server';

export interface McpConfig {
  apiUrl: string;
  apiKey?: string;
  toolPrefix: string;
  maxChars: number;
  http: { host: string; port: number; token?: string; allowedHosts: string[] };
}

export function loadMcpConfig(env: Record<string, string | undefined>): McpConfig {
  const toolPrefix = env.ICECRAWL_MCP_TOOL_PREFIX ?? 'icecrawl_';
  if (!/^[a-z0-9_]*$/.test(toolPrefix)) throw new Error('ICECRAWL_MCP_TOOL_PREFIX may only contain lowercase letters, digits and underscores');

  const maxChars = Number(env.ICECRAWL_MCP_MAX_CHARS ?? 30000);
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 200_000) throw new Error('ICECRAWL_MCP_MAX_CHARS must be an integer from 500 to 200000');

  const port = Number(env.ICECRAWL_MCP_PORT ?? 3003);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ICECRAWL_MCP_PORT must be a port number');

  return {
    apiUrl: env.ICECRAWL_API_URL ?? env.FIRECRAWL_API_URL ?? 'http://localhost:3002',
    apiKey: env.ICECRAWL_API_KEY ?? env.FIRECRAWL_API_KEY,
    toolPrefix,
    maxChars,
    http: {
      host: env.ICECRAWL_MCP_HOST ?? '127.0.0.1',
      port,
      token: env.ICECRAWL_MCP_TOKEN || undefined,
      allowedHosts: (env.ICECRAWL_MCP_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    },
  };
}

export function createServerFromConfig(cfg: McpConfig, fetchImpl?: typeof fetch): McpServer {
  return createIceCrawlMcpServer({
    client: new IceCrawl({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, fetch: fetchImpl }),
    toolPrefix: cfg.toolPrefix,
    maxChars: cfg.maxChars,
  });
}
