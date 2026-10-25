import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dashboardDir } from '@icecrawl/dashboard';
import { buildReceipt, canonicalJson, generateSigningKey, sha256Hex, signReceipt } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { fakeEngine, makeApp } from './helpers';
import { MemorySnapshotStore, MemoryStore } from '../src/store/memory';

const load = async (rel: string) => (await import(pathToFileURL(join(dashboardDir, rel)).href)) as Record<string, any>;

describe('dashboard files', () => {
  it('serves the page and its assets under a strict content security policy', async () => {
    const { app } = await makeApp();
    const page = await app.inject({ method: 'GET', url: '/dashboard/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<script type="module" src="app.js">');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe');
    expect(page.headers['x-content-type-options']).toBe('nosniff');

    for (const [url, type] of [['/dashboard/app.js', 'javascript'], ['/dashboard/styles.css', 'css'], ['/dashboard/pages/monitors.js', 'javascript']] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain(type);
    }
    expect((await app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/dashboard/');
  });

  it('serves only its own files and needs no API key for them', async () => {
    const { app } = await makeApp({ useAuth: true });
    for (const url of ['/dashboard/nope.js', '/dashboard/../package.json', '/dashboard/%2e%2e/package.json', '/dashboard/lib', '/dashboard/lib/']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/dashboard/' })).statusCode).toBe(200);
  });

  it('can be turned off', async () => {
    const app = buildApp({ store: new MemoryStore(), snapshots: new MemorySnapshotStore(), engines: [fakeEngine({})], scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false }, useAuth: false, dashboard: false });
    expect((await app.inject({ method: 'GET', url: '/dashboard/' })).statusCode).toBe(404);
  });

  it('serves stored snapshots as inert downloads', async () => {
    const { app, auth } = await makeApp({ signer: generateSigningKey().privateKey });
    const scraped = (await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/a' } })).json();
    const snap = await app.inject({ method: 'GET', url: `/v2/receipts/${scraped.data.trust.receiptId}/snapshot`, headers: auth });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers['content-security-policy']).toBe('sandbox');
    expect(snap.headers['x-content-type-options']).toBe('nosniff');
  });

  it('has page modules whose imports all resolve', async () => {
    const files = (dir: string): string[] => readdirSync(join(dashboardDir, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
    const modules = [...files('lib'), ...files('pages')];
    expect(modules.length).toBeGreaterThanOrEqual(8);
    for (const m of modules) await load(m);
  });
});

describe('in-browser receipt checks', () => {
  const key = generateSigningKey();
  const html = Buffer.from('<html><body>hello</body></html>');
  const receipt = buildReceipt({
    id: '44444444-4444-4444-8444-444444444444',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    fetchedAt: new Date('2026-10-25T10:00:00Z'),
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.95, reasons: [], durationMs: 5 }],
    htmlBytes: html,
    markdown: 'hello',
    converter: { name: 'icecrawl-convert', version: '3' },
    contentType: 'text/html',
    screenshot: null,
    options: { onlyMainContent: true, skipTlsVerification: true },
  });
  const signed = { receipt, signature: signReceipt(receipt, key.privateKey) };
  const keys = [key.publicKey];

  it('canonicalises exactly like the server', async () => {
    const { canonicalJson: browser } = await load('lib/receipt.js');
    const sample = { b: [1, 2.5, null, true, 'é"\n'], a: { z: 1, y: undefined, x: 'x' }, c: 0.95 };
    expect(browser(sample)).toBe(canonicalJson(sample));
    expect(browser(receipt)).toBe(canonicalJson(receipt));
  });

  it('passes an untouched receipt and fails every kind of tampering', async () => {
    const { verifyReceipt } = await load('lib/receipt.js');
    const ok = await verifyReceipt(signed, keys, new Uint8Array(html), null);
    expect(ok).toMatchObject({ ok: true, signature: { status: 'pass' }, snapshot: { status: 'pass' }, screenshot: { status: 'skipped' } });
    expect(sha256Hex(html)).toBe(receipt.htmlSha256);

    const edited = await verifyReceipt({ ...signed, receipt: { ...receipt, finalUrl: 'https://evil.example/' } }, keys, new Uint8Array(html), null);
    expect(edited.signature.status).toBe('fail');
    expect(edited.ok).toBe(false);

    const swapped = await verifyReceipt(signed, keys, new Uint8Array(Buffer.from('<html><body>HELLO</body></html>')), null);
    expect(swapped.snapshot.status).toBe('fail');

    const unknown = await verifyReceipt(signed, [], new Uint8Array(html), null);
    expect(unknown.signature.status).toBe('fail');

    const unsigned = await verifyReceipt({ receipt, signature: null }, keys, new Uint8Array(html), null);
    expect(unsigned.signature.status).toBe('skipped');
  });
});

describe('dom helpers', () => {
  it('only lets http, https and in-app links through', async () => {
    const { safeHref } = await load('lib/dom.js');
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('#/receipts/abc')).toBe('#/receipts/abc');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', 'not a url']) expect(safeHref(bad)).toBe('#');
  });
});
