import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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

describe.skipIf(!hasBrowser)('playwright engine', () => {
  let server: Server;
  let port: number;
  let engine: PlaywrightEngine;

  beforeAll(async () => {
    engine = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
    server = createServer((req, res) => {
      const html = (body: string, head = '') =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title>${head}</head><body>${body}</body></html>`,
        );
      switch (req.url) {
        case '/js':
          return html(
            '<div id="root">loading</div><script>setTimeout(()=>{document.getElementById("root").innerHTML="<h1>Rendered by JS</h1>"},50)</script>',
          );
        case '/late':
          return html('<div id="root">early</div><script>setTimeout(()=>{document.getElementById("root").textContent="late text"},400)</script>');
        case '/actions':
          return html(
            '<input id="i"><button id="b" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p id=done>clicked \'+document.getElementById(\'i\').value+\'</p>\')">go</button><div style="height:3000px">tall</div>',
          );
        case '/mobile':
          return html('<script>document.write("<p id=w>width:"+window.innerWidth+"</p>")</script>');
        case '/headers':
          return html(`<p>x-test:${req.headers['x-test']}</p><p>ua:${req.headers['user-agent']}</p>`);
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
          return;
        case '/403':
          res.writeHead(403, { 'content-type': 'text/html' }).end('<html><body>Forbidden</body></html>');
          return;
        case '/hang':
          return; // never respond
        default:
          res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await engine.close();
    server.closeAllConnections();
    server.close();
  });

  const ctx = (path: string, over: Partial<EngineContext> = {}): EngineContext => ({
    url: `http://127.0.0.1:${port}${path}`,
    headers: {},
    timeoutMs: 15000,
    skipTlsVerification: true,
    allowPrivateNetworks: true,
    maxBytes: 5_000_000,
    waitFor: 0,
    mobile: false,
    actions: [],
    screenshot: null,
    ...over,
  });

  const text = (r: { body: Uint8Array }) => Buffer.from(r.body).toString('utf8');

  it('renders JavaScript and returns the final DOM', async () => {
    const r = await engine.scrape(ctx('/js'));
    expect(r.statusCode).toBe(200);
    expect(text(r)).toContain('Rendered by JS');
    expect(r.contentType).toContain('text/html');
    expect(r.finalUrl).toBe(`http://127.0.0.1:${port}/js`);
    expect(r.truncated).toBe(false);
  });

  it('honours waitFor for late content', async () => {
    const r = await engine.scrape(ctx('/late', { waitFor: 700 }));
    expect(text(r)).toContain('late text');
  });

  it('emulates a mobile viewport', async () => {
    const desktop = await engine.scrape(ctx('/mobile'));
    const mobile = await engine.scrape(ctx('/mobile', { mobile: true }));
    expect(text(desktop)).toContain('width:1280');
    expect(text(mobile)).toContain('width:390');
  });

  it('sends custom headers and an honest user agent', async () => {
    const r = await engine.scrape(ctx('/headers', { headers: { 'X-Test': 'abc' } }));
    expect(text(r)).toContain('x-test:abc');
    expect(text(r)).toMatch(/ua:Mozilla\/5\.0 .*Chrome\/.* IceCrawl\/0\.1/);
  });

  it('runs click, write and wait actions', async () => {
    const r = await engine.scrape(
      ctx('/actions', {
        actions: [
          { type: 'click', selector: '#i', all: false },
          { type: 'write', text: 'abc' },
          { type: 'click', selector: '#b', all: false },
          { type: 'wait', selector: '#done' },
        ],
      }),
    );
    expect(text(r)).toContain('clicked abc');
  });

  it('runs press, scroll and wait-for-milliseconds actions', async () => {
    const r = await engine.scrape(
      ctx('/actions', {
        actions: [
          { type: 'click', selector: '#i', all: false },
          { type: 'press', key: 'a' },
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 50 },
        ],
      }),
    );
    expect(r.actions?.screenshots).toEqual([]);
    expect(r.statusCode).toBe(200);
  });

  it('collects screenshot, scrape, executeJavascript and pdf action outputs in order', async () => {
    const r = await engine.scrape(
      ctx('/js', {
        waitFor: 200,
        actions: [
          { type: 'screenshot', fullPage: false },
          { type: 'scrape' },
          { type: 'executeJavascript', script: '6 * 7' },
          { type: 'executeJavascript', script: '"hi"' },
          { type: 'pdf', format: 'A4', landscape: false, scale: 1 },
        ],
      }),
    );
    const out = r.actions!;
    expect(Buffer.from(out.screenshots[0]).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(out.scrapes[0].html).toContain('Rendered by JS');
    expect(out.scrapes[0].url).toBe(`http://127.0.0.1:${port}/js`);
    expect(out.javascriptReturns).toEqual([
      { type: 'number', value: 42 },
      { type: 'string', value: 'hi' },
    ]);
    expect(Buffer.from(out.pdfs[0]).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('takes a PNG screenshot, and a full-page one is taller than the viewport one', async () => {
    const viewport = await engine.scrape(ctx('/actions', { screenshot: { fullPage: false } }));
    const full = await engine.scrape(ctx('/actions', { screenshot: { fullPage: true } }));
    expect(Buffer.from(viewport.screenshot!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const height = (png: Uint8Array) => Buffer.from(png).readUInt32BE(20);
    expect(height(full.screenshot!)).toBeGreaterThan(height(viewport.screenshot!));
  });

  it('honours a screenshot viewport size', async () => {
    const r = await engine.scrape(ctx('/js', { screenshot: { fullPage: false, viewport: { width: 640, height: 480 } } }));
    const png = Buffer.from(r.screenshot!);
    expect(png.readUInt32BE(16)).toBe(640);
    expect(png.readUInt32BE(20)).toBe(480);
  });

  it('returns non-HTML main responses as raw bytes with their content type', async () => {
    const r = await engine.scrape(ctx('/json'));
    expect(r.contentType).toContain('application/json');
    expect(text(r)).toBe('{"hello":"world"}');
  });

  it('reports the real status code of non-2xx pages', async () => {
    const r = await engine.scrape(ctx('/403'));
    expect(r.statusCode).toBe(403);
  });

  it('fails an action on a missing element with ACTION_FAILED', async () => {
    await expect(
      engine.scrape(ctx('/js', { timeoutMs: 3000, actions: [{ type: 'click', selector: '#nope', all: false }] })),
    ).rejects.toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('Action 0 (click)') });
  });

  it('times out on a page that never answers', async () => {
    await expect(engine.scrape(ctx('/hang', { timeoutMs: 1500 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('blocks private targets when private networks are not allowed', async () => {
    await expect(engine.scrape(ctx('/js', { allowPrivateNetworks: false }))).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('enforces the size cap on the rendered document', async () => {
    await expect(engine.scrape(ctx('/js', { maxBytes: 50 }))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('runs scrapes concurrently in isolated contexts', async () => {
    const [a, b] = await Promise.all([engine.scrape(ctx('/js')), engine.scrape(ctx('/late', { waitFor: 700 }))]);
    expect(text(a)).toContain('Rendered by JS');
    expect(text(b)).toContain('late text');
  });
});
