import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServerFromConfig, type McpConfig } from './config';

/** stdout carries the protocol; anything human-readable must go to stderr. */
export async function startStdio(cfg: McpConfig): Promise<void> {
  const server = createServerFromConfig(cfg);
  await server.connect(new StdioServerTransport());
  console.error(`icecrawl-mcp ready on stdio (API ${cfg.apiUrl}, tool prefix "${cfg.toolPrefix}")`);
}
