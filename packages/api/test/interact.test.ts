import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from '@icecrawl/engines';
import { makeApp } from './helpers';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe('interact routes without a browser', () => {
  it('answers 501 when sessions are not configured', async () => {
    const { app, auth } = await makeApp({ sessions: null });
    const res = await app.inject({ method: 'POST', url: '/v2/interact', headers: auth, payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('NOT_IMPLEMENTED');
  });
});

describe.skipIf(!hasBrowser)('interact routes', () => {
  let server: Server;
  let base: string;
  let sessions: SessionManager;

  beforeAll(async () => {
    server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Scripted</title></head><body><p>hello</p></body></html>'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sessions = new SessionManager({ allowPrivateNetworks: true, allowCode: true, noSandbox: process.env.CI === 'true' });
  });
  afterAll(async () => {
    await sessions.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('creates a session, runs code in it, lists it and deletes it', async () => {
    const { app, auth } = await makeApp({ sessions });
    const created = (await app.inject({ method: 'POST', url: '/v2/interact', headers: auth, payload: { ttl: 60, profile: { name: 'x' } } })).json();
    expect(created).toMatchObject({ success: true, id: expect.any(String), expiresAt: expect.any(String) });
    expect(created.warning).toContain('profile');

    const run = (code: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/v2/interact/${created.id}/execute`, headers: auth, payload: { code, ...extra } });
    const nav = (await run(`await page.goto('${base}/'); return await page.title()`)).json();
    expect(nav).toMatchObject({ success: true, result: 'Scripted', exitCode: 0, killed: false });
    const failed = (await run("throw new Error('nope')")).json();
    expect(failed).toMatchObject({ success: false, exitCode: 1, error: expect.stringContaining('nope') });
    const python = await run('print(1)', { language: 'python' });
    expect(python.statusCode).toBe(400);

    const list = (await app.inject({ method: 'GET', url: '/v2/interact', headers: auth })).json();
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([created.id]);
    const del = (await app.inject({ method: 'DELETE', url: `/v2/interact/${created.id}`, headers: auth })).json();
    expect(del).toMatchObject({ success: true, sessionDurationMs: expect.any(Number) });
    expect((await app.inject({ method: 'DELETE', url: `/v2/interact/${created.id}`, headers: auth })).statusCode).toBe(404);
  }, 90_000);

  it('opens the browser session of a scrape on its final page', async () => {
    const { app, auth } = await makeApp({ sessions, engine: undefined });
    const scraped = (await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: 'https://example.com/' } })).json();
    const id = scraped.data.trust.receiptId as string;
    // the fake engine reports https://example.com/final, which is not reachable here: the session still opens
    const res = await app.inject({ method: 'POST', url: `/v2/scrape/${id}/interact`, headers: auth, payload: { code: 'return page.url()' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 0 });
    expect((await app.inject({ method: 'DELETE', url: `/v2/scrape/${id}/interact`, headers: auth })).json()).toEqual({ success: true });
    expect((await app.inject({ method: 'POST', url: '/v2/scrape/nope/interact', headers: auth, payload: { code: 'x' } })).statusCode).toBe(404);
  }, 90_000);

  it('does not show or let another key use a session', async () => {
    const { app, auth, store } = await makeApp({ sessions });
    const { sha256Hex } = await import('@icecrawl/trust');
    await store.createApiKey({ id: 'other-key', hash: sha256Hex('ic-other'), name: 'other' });
    const created = (await app.inject({ method: 'POST', url: '/v2/interact', headers: auth, payload: {} })).json();
    const other = { authorization: 'Bearer ic-other' };
    expect((await app.inject({ method: 'GET', url: '/v2/interact', headers: other })).json().sessions).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/v2/interact/${created.id}/execute`, headers: other, payload: { code: 'return 1' } })).statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/v2/interact/${created.id}`, headers: auth });
  }, 60_000);
});
