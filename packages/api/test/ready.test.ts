import { describe, expect, it } from 'vitest';
import { makeJobsApp } from './jobs-helpers';

describe('/health and /ready', () => {
  it('/health answers without checking anything', async () => {
    const t = await makeJobsApp({ ready: async () => ({ postgres: 'unreachable: down' }) });
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('/ready is 200 when every dependency answers, and needs no API key', async () => {
    const t = await makeJobsApp({ ready: async () => ({ postgres: 'ok', redis: 'ok' }) });
    const res = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('/ready is 503 and names the failing dependency', async () => {
    const t = await makeJobsApp({ ready: async () => ({ postgres: 'ok', redis: 'unreachable: connection refused' }) });
    const res = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, checks: { postgres: 'ok', redis: 'unreachable: connection refused' } });
  });

  it('/ready is 200 with no checks configured', async () => {
    const t = await makeJobsApp();
    expect((await t.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });
});

describe('request logging', () => {
  it('logs API requests but not the health probes', async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    const t = await makeJobsApp({ logger: { level: 'info', stream } });
    await t.app.inject({ method: 'GET', url: '/health' });
    await t.app.inject({ method: 'GET', url: '/ready' });
    expect(lines).toEqual([]);
    await t.app.inject({ method: 'GET', url: '/v2/crawl/active' });
    expect(lines.some((l) => l.includes('/v2/crawl/active'))).toBe(true);
  });
});
