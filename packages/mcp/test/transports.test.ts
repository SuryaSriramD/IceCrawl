import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { IceCrawl } from '@icecrawl/sdk';
import { loadMcpConfig, type McpConfig } from '../src/config';
import { startHttpServer } from '../src/http';
import { createIceCrawlMcpServer } from '../src/server';

const clean = { scanner: { name: 'icecrawl-injection-scan', version: '1' }, flagged: false, highest: null, count: 0, findings: [] };
const doc = (url: string) => ({
  markdown: `# Fake\n\nFake page for ${url}`,
  metadata: { title: 'Fake', description: null, language: 'en', sourceURL: url, url, statusCode: 200, contentType: 'text/html', scrapeId: 's1' },
  trust: { verdict: 'ok', confidence: 0.95, reasons: [], receiptId: 'rcpt-fake', engine: 'fetch', injection: clean },
});

let fakeApi: Server;
let fakeUrl: string;
const seenAuth: Array<string | undefined> = [];

beforeAll(async () => {
  fakeApi = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = body ? (JSON.parse(body) as { url: string }).url : 'none';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: doc(url) }));
    });
  });
  await new Promise<void>((r) => fakeApi.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`;
});

afterAll(() => {
  fakeApi.closeAllConnections();
  fakeApi.close();
});

describe('loadMcpConfig', () => {
  it('has safe defaults', () => {
    expect(loadMcpConfig({})).toEqual({
      apiUrl: 'http://localhost:3002',
      apiKey: undefined,
      toolPrefix: 'icecrawl_',
      maxChars: 30000,
      http: { host: '127.0.0.1', port: 3003, token: undefined, allowedHosts: [] },
    });
  });

  it('reads IceCrawl settings first and falls back to Firecrawl-style variables', () => {
    expect(loadMcpConfig({ FIRECRAWL_API_URL: 'http://fc', FIRECRAWL_API_KEY: 'fc-key' })).toMatchObject({ apiUrl: 'http://fc', apiKey: 'fc-key' });
    expect(loadMcpConfig({ ICECRAWL_API_URL: 'http://ic', FIRECRAWL_API_URL: 'http://fc', ICECRAWL_API_KEY: 'ic-key' })).toMatchObject({ apiUrl: 'http://ic', apiKey: 'ic-key' });
  });

  it('parses the HTTP and tool settings and rejects bad values', () => {
    const c = loadMcpConfig({ ICECRAWL_MCP_TOOL_PREFIX: 'firecrawl_', ICECRAWL_MCP_MAX_CHARS: '8000', ICECRAWL_MCP_PORT: '4001', ICECRAWL_MCP_TOKEN: 't', ICECRAWL_MCP_ALLOWED_HOSTS: 'mcp.example.com, other.test' });
    expect(c).toMatchObject({ toolPrefix: 'firecrawl_', maxChars: 8000, http: { port: 4001, token: 't', allowedHosts: ['mcp.example.com', 'other.test'] } });
    expect(() => loadMcpConfig({ ICECRAWL_MCP_TOOL_PREFIX: 'Bad Prefix!' })).toThrow(/ICECRAWL_MCP_TOOL_PREFIX/);
    expect(() => loadMcpConfig({ ICECRAWL_MCP_MAX_CHARS: '10' })).toThrow(/ICECRAWL_MCP_MAX_CHARS/);
    expect(() => loadMcpConfig({ ICECRAWL_MCP_PORT: 'abc' })).toThrow(/ICECRAWL_MCP_PORT/);
  });
});

describe('stdio transport (the real bin)', () => {
  it('starts, lists tools and scrapes through the configured API', async () => {
    const bin = fileURLToPath(new URL('../bin/icecrawl-mcp.mjs', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { ...(process.env as Record<string, string>), ICECRAWL_API_URL: fakeUrl, ICECRAWL_API_KEY: 'ic-from-env' },
      stderr: 'pipe',
    });
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(transport);
    try {
      const names = (await mcp.listTools()).tools.map((t) => t.name);
      expect(names).toContain('icecrawl_scrape');
      const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/page' } });
      const t = (r.content as Array<{ text: string }>)[0].text;
      expect(t).toContain('Fake page for https://e.com/page');
      expect(t).toContain('<<<ICECRAWL_UNTRUSTED_CONTENT');
      expect(seenAuth).toContain('Bearer ic-from-env');
    } finally {
      await mcp.close();
    }
  }, 30000);
});

describe('streamable HTTP transport', () => {
  const cfg = (over: Partial<McpConfig['http']> = {}): McpConfig => ({
    apiUrl: fakeUrl,
    apiKey: 'k',
    toolPrefix: 'icecrawl_',
    maxChars: 30000,
    http: { host: '127.0.0.1', port: 0, token: undefined, allowedHosts: [], ...over },
  });
  const make = (c: McpConfig) => () => createIceCrawlMcpServer({ client: new IceCrawl({ apiUrl: c.apiUrl, apiKey: c.apiKey }), toolPrefix: c.toolPrefix, maxChars: c.maxChars });

  it('serves tools over POST /mcp and a health endpoint', async () => {
    const c = cfg();
    const srv = await startHttpServer(c, make(c));
    try {
      expect((await fetch(`${srv.url}/health`)).status).toBe(200);
      const mcp = new Client({ name: 'test', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
      expect((await mcp.listTools()).tools.map((t) => t.name)).toContain('icecrawl_map');
      const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/http' } });
      expect((r.content as Array<{ text: string }>)[0].text).toContain('Fake page for https://e.com/http');
      await mcp.close();
    } finally {
      await srv.close();
    }
  }, 30000);

  it('requires the bearer token when one is configured', async () => {
    const c = cfg({ token: 'sekret' });
    const srv = await startHttpServer(c, make(c));
    try {
      const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' };
      expect((await fetch(`${srv.url}/mcp`, init)).status).toBe(401);
      expect((await fetch(`${srv.url}/mcp`, { ...init, headers: { ...init.headers, authorization: 'Bearer wrong' } })).status).toBe(401);
      const mcp = new Client({ name: 'test', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), { requestInit: { headers: { authorization: 'Bearer sekret' } } }));
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);
      await mcp.close();
    } finally {
      await srv.close();
    }
  }, 30000);

  it('rejects foreign Host headers, other methods and oversized bodies', async () => {
    const c = cfg();
    const srv = await startHttpServer(c, make(c));
    try {
      const port = srv.port;
      const http = await import('node:http');
      const raw = (opts: { method: string; path: string; host?: string; body?: string }) =>
        new Promise<number>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: { host: opts.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end(opts.body);
        });
      expect(await raw({ method: 'POST', path: '/mcp', host: 'evil.example', body: '{}' })).toBe(403);
      expect(await raw({ method: 'GET', path: '/mcp' })).toBe(405);
      expect(await raw({ method: 'GET', path: '/nope' })).toBe(404);
      expect(await raw({ method: 'POST', path: '/mcp', body: 'x'.repeat(5 * 1024 * 1024) })).toBe(413);
      expect(await raw({ method: 'POST', path: '/mcp', body: '{not json' })).toBe(400);
    } finally {
      await srv.close();
    }
  }, 30000);

  it('caps chunked bodies without a content-length, and the health endpoint exposes nothing', async () => {
    const c = cfg({ token: 'sekret' });
    const srv = await startHttpServer(c, make(c));
    try {
      const http = await import('node:http');
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer sekret', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        for (let i = 0; i < 5; i++) req.write('x'.repeat(1024 * 1024));
        req.end();
      });
      expect(status).toBe(413);
      const health = await fetch(`${srv.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await srv.close();
    }
  }, 30000);

  it('refuses to listen beyond loopback without a token, and allows it with one', async () => {
    const open = cfg({ host: '0.0.0.0' });
    await expect(startHttpServer(open, make(open))).rejects.toThrow(/ICECRAWL_MCP_TOKEN/);
    const guarded = cfg({ host: '0.0.0.0', token: 't' });
    const srv = await startHttpServer(guarded, make(guarded));
    await srv.close();
  });
});
