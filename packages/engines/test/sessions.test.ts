import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from '../src';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBrowser)('SessionManager', () => {
  let server: Server;
  let base: string;
  let sessions: SessionManager;
  const opts = { allowPrivateNetworks: true, noSandbox: process.env.CI === 'true' };

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Hi ${req.url}</title></head><body><button id="b" onclick="document.title='clicked'">go</button></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sessions = new SessionManager({ ...opts, allowCode: true, maxSessions: 2 });
  });
  afterAll(async () => {
    await sessions.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('keeps browser state between executions and cleans up', async () => {
    const s = await sessions.create({ ownerKey: 'k1', ttlMs: 60_000, url: `${base}/start` });
    const a = await sessions.execute(s.id, 'k1', { code: 'return await page.title()', language: 'node', timeoutMs: 30_000 });
    expect(a).toMatchObject({ result: 'Hi /start', exitCode: 0, killed: false });
    await sessions.execute(s.id, 'k1', { code: "await page.click('#b'); console.log('did click')", language: 'node', timeoutMs: 30_000 }).then((r) => expect(r.stdout).toBe('did click'));
    const b = await sessions.execute(s.id, 'k1', { code: 'return await page.title()', language: 'node', timeoutMs: 30_000 });
    expect(b.result).toBe('clicked');
    expect(sessions.list('k1')).toHaveLength(1);
    expect(sessions.list('other')).toHaveLength(0);
    await sessions.destroy(s.id, 'k1');
    expect(sessions.list('k1')).toHaveLength(0);
  }, 90_000);

  it('reports errors and timeouts, and hides the server environment from the code', async () => {
    process.env.ICECRAWL_TEST_SECRET = 'hunter2';
    const s = await sessions.create({ ownerKey: 'k1', ttlMs: 60_000 });
    const bad = await sessions.execute(s.id, 'k1', { code: "throw new Error('boom')", language: 'node', timeoutMs: 30_000 });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('boom');
    const env = await sessions.execute(s.id, 'k1', { code: 'return String(process.env.ICECRAWL_TEST_SECRET)', language: 'node', timeoutMs: 30_000 });
    expect(env.result).toBe('undefined');
    const slow = await sessions.execute(s.id, 'k1', { code: 'await new Promise(() => {})', language: 'node', timeoutMs: 1500 });
    expect(slow).toMatchObject({ killed: true, exitCode: null });
    await sessions.destroy(s.id, 'k1');
  }, 90_000);

  it('enforces ownership, the session cap, languages, and expiry', async () => {
    const a = await sessions.create({ ownerKey: 'k1', ttlMs: 60_000 });
    await expect(sessions.destroy(a.id, 'k2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sessions.execute(a.id, 'k1', { code: 'x', language: 'python', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
    const b = await sessions.create({ ownerKey: 'k1', ttlMs: 60_000 });
    await expect(sessions.create({ ownerKey: 'k1', ttlMs: 60_000 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await sessions.destroy(b.id, 'k1');
    const idle = await sessions.create({ ownerKey: 'k1', ttlMs: 60_000, activityTtlMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await sessions.sweep()).toBeGreaterThanOrEqual(1);
    expect(sessions.has(idle.id, 'k1')).toBe(false);
    await sessions.destroy(a.id, 'k1');
  }, 90_000);

  it('refuses code when the operator has not enabled it', async () => {
    const off = new SessionManager({ ...opts, allowCode: false });
    const s = await off.create({ ownerKey: 'k1', ttlMs: 60_000 });
    await expect(off.execute(s.id, 'k1', { code: 'return 1', language: 'node', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
    await off.close();
  }, 60_000);
});
