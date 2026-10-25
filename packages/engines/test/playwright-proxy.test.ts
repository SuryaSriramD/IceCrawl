import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightEngine, type EngineContext, type PlaywrightEngine } from '../src';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBrowser)('playwright engine through a proxy', () => {
  let proxy: Server;
  let port: number;
  let engine: PlaywrightEngine;
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    engine = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
    // an http proxy that demands credentials and answers every page itself
    proxy = createServer((req, res) => {
      const expected = `Basic ${Buffer.from('user:pw').toString('base64')}`;
      if (req.headers['proxy-authorization'] !== expected) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pool"' }).end();
        return;
      }
      seen.push({ url: req.url, headers: req.headers });
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<html><body><p id="out"></p><script>document.getElementById("out").textContent="webdriver:"+navigator.webdriver+" ua:"+navigator.userAgent</script></body></html>');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await engine.close();
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  const ctx = (over: Partial<EngineContext>): EngineContext => ({
    url: 'http://target.example/page',
    headers: {},
    timeoutMs: 20_000,
    skipTlsVerification: false,
    allowPrivateNetworks: true,
    maxBytes: 1_000_000,
    waitFor: 0,
    mobile: false,
    actions: [],
    screenshot: null,
    proxy: `http://user:pw@127.0.0.1:${port}`,
    ...over,
  });

  it('routes the page through the proxy with credentials and, in stealth mode, hides the automation tells', async () => {
    const r = await engine.scrape(ctx({ stealth: true }));
    const html = Buffer.from(r.body).toString();
    expect(html).toContain('webdriver:false');
    expect(html).not.toContain('IceCrawl');
    expect(seen[seen.length - 1].url).toBe('http://target.example/page');
  }, 30_000);

  it('keeps the honest IceCrawl user agent without stealth', async () => {
    const r = await engine.scrape(ctx({}));
    expect(Buffer.from(r.body).toString()).toContain('IceCrawl/0.1');
  }, 30_000);
});
