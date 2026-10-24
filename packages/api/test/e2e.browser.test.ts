import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runVerify, type VerifyIo } from '@icecrawl/cli';
import { createPlaywrightEngine, fetchEngine } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { loadOrCreateSigningKey } from '../src/signing';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';

const url = process.env.DATABASE_URL;
const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const pageHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>JS Page</title></head><body>
<div id="root">loading</div>
<script>setTimeout(()=>{document.getElementById('root').innerHTML='<article><h1>Rendered by JS</h1>'+'<p>Content that only exists after JavaScript runs. </p>'.repeat(20)+'</article>'},50)</script>
</body></html>`;

// readable without JS, so the fetch fallback produces a trustworthy result
const staticHtml = `<!doctype html><html><head><title>Static Page</title></head><body><article><h1>Plain content</h1>${'<p>Content that is present in the raw HTML without JavaScript. </p>'.repeat(20)}</article></body></html>`;

describe.skipIf(!url || !hasBrowser)('end to end: browser + signing + verify', () => {
  const sql = createSql(url ?? 'postgres://unused');
  const engine = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
  let origin: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-browser-'));
    origin = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/static' ? staticHtml : pageHtml);
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await engine.close();
    origin.closeAllConnections();
    origin.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('renders JS, screenshots it, signs the receipt, and verify passes; tampering is caught', async () => {
    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(join(dir, 'snaps'));
    const signer = await loadOrCreateSigningKey(join(dir, 'signing-key.pem'), store);
    const app = buildApp({
      store,
      snapshots,
      engines: [engine, fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false },
      useAuth: true,
      signer,
    });
    const token = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(token), name: 'e2e-browser' });
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({
      method: 'POST', url: '/v2/scrape', headers: auth,
      payload: { url: `http://127.0.0.1:${port}/page`, formats: ['markdown', 'screenshot'], waitFor: 300 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.markdown).toContain('Rendered by JS');
    expect(body.data.trust).toMatchObject({ verdict: 'ok', engine: 'playwright' });
    expect(body.data.screenshot).toMatch(/^data:image\/png;base64,/);
    const id = body.data.trust.receiptId as string;

    // a verify client that talks to the in-process app
    const fetchViaApp = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      const r = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(new Uint8Array(r.rawPayload), { status: r.statusCode, headers: r.headers as Record<string, string> });
    }) as typeof fetch;
    const run = async (override?: typeof fetch) => {
      const lines: string[] = [];
      const io: VerifyIo = { fetch: override ?? fetchViaApp, readFile: async (p) => readFile(p), out: (l) => lines.push(l), err: (l) => lines.push(l), env: {} };
      const code = await runVerify([id, '--api', 'http://icecrawl.test', '--key', token], io);
      return { code, text: lines.join('\n') };
    };

    const good = await run();
    expect(good.code).toBe(0);
    expect(good.text).toMatch(/signature\s+PASS/);
    expect(good.text).toMatch(/snapshot\s+PASS/);
    expect(good.text).toMatch(/screenshot\s+PASS/);
    expect(good.text).toMatch(/replay\s+PASS/);

    // tamper with the stored snapshot as seen by the verifier
    const tamperedSnapshot = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchViaApp(input, init);
      if (!String(input).endsWith('/snapshot')) return res;
      const bytes = Buffer.from(await res.arrayBuffer());
      bytes[bytes.length - 3] ^= 1;
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const bad = await run(tamperedSnapshot);
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/snapshot\s+FAIL/);

    // tamper with the receipt as seen by the verifier
    const tamperedReceipt = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchViaApp(input, init);
      if (!new URL(String(input)).pathname.endsWith(`/receipts/${id}`)) return res;
      const json = (await res.json()) as { data: { finalUrl: string } };
      json.data.finalUrl = 'https://evil.example/';
      return Response.json(json);
    }) as typeof fetch;
    const forged = await run(tamperedReceipt);
    expect(forged.code).toBe(1);
    expect(forged.text).toMatch(/signature\s+FAIL/);
  });

  it('falls back to fetch when the browser engine fails, and records both attempts', async () => {
    const store = new PgStore(sql);
    const broken = { ...engine, scrape: async () => { throw Object.assign(new Error('boom'), { name: 'Error' }); } };
    const app = buildApp({
      store,
      snapshots: new FileSnapshotStore(join(dir, 'snaps2')),
      engines: [broken, fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: false },
      useAuth: false,
    });
    const res = await app.inject({ method: 'POST', url: '/v2/scrape', payload: { url: `http://127.0.0.1:${port}/static` } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.trust.receiptId as string;
    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${id}` })).json().data;
    expect(receipt.engineChain.map((a: { engine: string }) => a.engine)).toEqual(['playwright', 'fetch']);
    expect(receipt.engineChain[0].verdict).toBe('error');
  });
});
