import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpConfig } from './config';

const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

function hostAllowed(req: IncomingMessage, extra: string[]): boolean {
  const raw = req.headers.host ?? '';
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  const bare = host.replace(/^\[|\]$/g, '');
  return LOOPBACK.has(bare) || extra.includes(bare) || extra.includes(host);
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers 413 and keeps discarding the upload (bounded), so the client reads the response instead of a connection reset. */
function rejectTooLarge(req: IncomingMessage, res: ServerResponse): void {
  send(res, 413, { error: 'Body too large' });
  let drained = 0;
  req.on('data', (c: Buffer) => {
    drained += c.length;
    if (drained > 8 * MAX_BODY) req.destroy();
  });
}

/** Resolves the body, or null after answering 413 (counts real bytes, so chunked uploads are capped too). */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.off('data', onData);
        rejectTooLarge(req, res);
        resolve(null);
      } else chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startHttpServer(
  cfg: McpConfig,
  makeServer: () => McpServer,
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const { host, token, allowedHosts } = cfg.http;
  if (!LOOPBACK.has(host) && !token) {
    throw new Error('Refusing to listen beyond loopback without ICECRAWL_MCP_TOKEN: the MCP server forwards your IceCrawl API key to anyone who can reach it.');
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/health') return void send(res, 200, { ok: true });
      if (!hostAllowed(req, allowedHosts)) return void send(res, 403, { error: 'Host not allowed' });
      if (path !== '/mcp') return void send(res, 404, { error: 'Not found' });
      if (token && !tokenOk(req, token)) return void send(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return void send(res, 405, { error: 'Use POST (stateless streamable HTTP)' }, { allow: 'POST' });

      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return void rejectTooLarge(req, res);
      const text = await readBody(req, res);
      if (text === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return void send(res, 400, { error: 'Invalid JSON' });
      }

      const mcp = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      console.error('icecrawl-mcp http error:', (err as Error).message);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.http.port, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${port}`,
    port,
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
