import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine, type EngineContext } from '../src';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-echo-ua': String(req.headers['user-agent']) });
        res.end('<html><body>hello</body></html>');
        break;
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        res.end();
        break;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        break;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(gzipSync('<html>zipped</html>'));
        break;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
        break;
      case '/trunc':
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': '1000' });
        res.write('<html>partial');
        setTimeout(() => res.socket?.destroy(), 20);
        break;
      case '/404':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>nope</html>');
        break;
      case '/hang':
        break; // never respond
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const ctx = (path: string, over: Partial<EngineContext> = {}): EngineContext => ({
  url: `http://127.0.0.1:${port}${path}`,
  headers: {},
  timeoutMs: 2000,
  skipTlsVerification: true,
  allowPrivateNetworks: true,
  maxBytes: 100_000,
  waitFor: 0,
  mobile: false,
  actions: [],
  screenshot: null,
  ...over,
});

describe('fetchEngine', () => {
  it('fetches a page and reports status, headers and content type', async () => {
    const r = await fetchEngine.scrape(ctx('/ok'));
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.body).toString()).toContain('hello');
    expect(r.contentType).toContain('text/html');
    expect(r.headers['x-echo-ua']).toContain('IceCrawl');
    expect(r.truncated).toBe(false);
  });

  it('follows redirects and reports the final URL', async () => {
    const r = await fetchEngine.scrape(ctx('/redirect'));
    expect(r.finalUrl).toBe(`http://127.0.0.1:${port}/ok`);
  });

  it('gives up on redirect loops', async () => {
    await expect(fetchEngine.scrape(ctx('/loop'))).rejects.toMatchObject({ code: 'TARGET_ERROR' });
  });

  it('decodes gzip bodies', async () => {
    const r = await fetchEngine.scrape(ctx('/gzip'));
    expect(Buffer.from(r.body).toString()).toBe('<html>zipped</html>');
  });

  it('returns non-2xx responses without throwing (the verdict decides)', async () => {
    const r = await fetchEngine.scrape(ctx('/404'));
    expect(r.statusCode).toBe(404);
  });

  it('enforces the response size cap', async () => {
    await expect(fetchEngine.scrape(ctx('/big', { maxBytes: 1000 }))).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('flags a body cut short as truncated', async () => {
    const r = await fetchEngine.scrape(ctx('/trunc'));
    expect(r.truncated).toBe(true);
  });

  it('times out on a server that never answers', async () => {
    await expect(fetchEngine.scrape(ctx('/hang', { timeoutMs: 300 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('blocks private targets by default', async () => {
    await expect(fetchEngine.scrape(ctx('/ok', { allowPrivateNetworks: false }))).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });
});
