import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { startDueChecks } from '../src/monitor/scheduler';
import { drain, makeJobsApp, type Site } from './jobs-helpers';

const E = 'https://example.com';
const word = (w: string) => `<html><head><title>P</title></head><body><article><h1>Price list</h1><p>${`The current price is ${w} dollars for the standard plan today. `.repeat(8)}</p></article></body></html>`;
const walled = '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>';
const body = {
  name: 'Pricing watch',
  schedule: { cron: '0 * * * *' },
  targets: [{ type: 'scrape', urls: [`${E}/a`] }],
};

type T = Awaited<ReturnType<typeof makeJobsApp>>;
const call = (t: T, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = t.auth) =>
  t.app.inject({ method, url: `/v2/monitor${url}`, headers, payload: payload as never });

interface PageView {
  url: string;
  status: string;
  diff: { text: string } | null;
  error: string | null;
  currentScrapeId: string | null;
  previousScrapeId: string | null;
}

async function run(t: T, monitorId: string) {
  const started = (await call(t, 'POST', `/${monitorId}/run`)).json();
  await drain(t.deps, t.queues);
  const detail = (await call(t, 'GET', `/${monitorId}/checks/${started.id}`)).json();
  return detail.data as { status: string; summary: Record<string, number>; pages: PageView[] };
}

describe('/v2/monitor', () => {
  it('creates, lists, reads, updates and deletes a monitor', async () => {
    const t = await makeJobsApp({ site: {} });
    const created = (await call(t, 'POST', '', { ...body, webhook: { url: 'https://hooks.example/m' } })).json();
    expect(created).toMatchObject({ success: true, data: { name: 'Pricing watch', status: 'active', schedule: { cron: '0 * * * *', timezone: 'UTC' }, retentionDays: 30 } });
    expect(created.data.nextRunAt).toEqual(expect.any(String));
    expect(created.data.targets[0].id).toEqual(expect.any(String));
    const id = created.data.id as string;
    expect((await call(t, 'GET', '')).json().data.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await call(t, 'GET', `/${id}`)).json().data.id).toBe(id);

    const paused = (await call(t, 'PATCH', `/${id}`, { status: 'paused', name: 'Renamed' })).json();
    expect(paused.data).toMatchObject({ status: 'paused', name: 'Renamed', nextRunAt: null });
    const resumed = (await call(t, 'PATCH', `/${id}`, { status: 'active', schedule: { cron: '30 6 * * *', timezone: 'Europe/Berlin' } })).json();
    expect(resumed.data).toMatchObject({ status: 'active', schedule: { cron: '30 6 * * *', timezone: 'Europe/Berlin' } });
    expect(resumed.data.nextRunAt).toEqual(expect.any(String));
    const zoneOnly = (await call(t, 'PATCH', `/${id}`, { schedule: { timezone: 'Asia/Tokyo' } })).json();
    expect(zoneOnly.data.schedule).toEqual({ cron: '30 6 * * *', timezone: 'Asia/Tokyo' });
    expect((await call(t, 'PATCH', `/${id}`, { schedule: { text: 'daily' } })).statusCode).toBe(400);

    expect((await call(t, 'DELETE', `/${id}`)).json()).toEqual({ success: true });
    expect((await call(t, 'GET', `/${id}`)).statusCode).toBe(404);
  });

  it('validates schedules, targets and webhooks, and keeps monitors private to their key', async () => {
    const t = await makeJobsApp({ site: {} });
    expect((await call(t, 'POST', '', { ...body, schedule: { text: 'every day' } })).json().error).toContain('cron');
    expect((await call(t, 'POST', '', { ...body, schedule: { cron: '* * * * *' } })).json().error).toContain('more often');
    expect((await call(t, 'POST', '', { ...body, schedule: { cron: 'nonsense' } })).statusCode).toBe(400);
    // uneven gaps (10 and 50 minutes): the first two runs alone can look fine depending on when it is created
    expect((await call(t, 'POST', '', { ...body, schedule: { cron: '0,10 * * * *' } })).json().error).toContain('more often');
    expect((await call(t, 'POST', '', { ...body, targets: [] })).statusCode).toBe(400);
    expect((await call(t, 'POST', '', { ...body, targets: [{ type: 'scrape', urls: ['http://127.0.0.1/admin'] }] })).json().code).toBe('SSRF_BLOCKED');
    expect((await call(t, 'POST', '', { ...body, webhook: { url: 'http://127.0.0.1/hook' } })).json().code).toBe('SSRF_BLOCKED');
    expect((await call(t, 'POST', '', body, {})).statusCode).toBe(401);
    const warned = (await call(t, 'POST', '', { ...body, notification: { email: { enabled: true, recipients: ['a@b.co'] } }, judgeEnabled: true })).json();
    expect(warned.warning).toContain('Email notifications');
    expect(warned.warning).toContain('judgeEnabled');

    const id = (await call(t, 'POST', '', body)).json().data.id;
    await t.store.createApiKey({ id: '22222222-2222-4222-8222-222222222222', hash: sha256Hex('ic-other'), name: 'other' });
    expect((await call(t, 'GET', `/${id}`, undefined, { authorization: 'Bearer ic-other' })).statusCode).toBe(404);
    expect((await call(t, 'GET', '', undefined, { authorization: 'Bearer ic-other' })).json().data).toEqual([]);
  });

  it('reports new, same and changed pages with a diff, and never counts a blocked page as a change', async () => {
    const site: Site = { [`${E}/a`]: { html: word('ten') } };
    const t = await makeJobsApp({ site });
    const id = (await call(t, 'POST', '', body)).json().data.id as string;

    const first = await run(t, id);
    expect(first).toMatchObject({ status: 'completed', summary: { totalPages: 1, new: 1 } });
    expect(first.pages[0].currentScrapeId).toEqual(expect.any(String));

    const second = await run(t, id);
    expect(second.summary).toMatchObject({ same: 1, changed: 0 });

    site[`${E}/a`] = { html: word('twelve') };
    const third = await run(t, id);
    expect(third.summary).toMatchObject({ changed: 1 });
    expect(third.pages[0].diff?.text).toMatch(/^-.*ten dollars/m);
    expect(third.pages[0].diff?.text).toMatch(/^\+.*twelve dollars/m);
    expect(third.pages[0].previousScrapeId).toBe(first.pages[0].currentScrapeId);

    site[`${E}/a`] = { html: walled };
    const fourth = await run(t, id);
    expect(fourth).toMatchObject({ status: 'failed', summary: { error: 1, changed: 0 } });
    expect(fourth.pages[0].error).toContain('CAPTCHA');

    site[`${E}/a`] = { html: word('twelve') };
    expect((await run(t, id)).summary).toMatchObject({ same: 1 });

    const monitor = (await call(t, 'GET', `/${id}`)).json().data;
    expect(monitor.lastCheckSummary).toMatchObject({ same: 1 });
    expect(monitor.currentCheckId).toBeNull();
    const checks = (await call(t, 'GET', `/${id}/checks?limit=2`)).json().data;
    expect(checks).toHaveLength(2);
    expect((await call(t, 'GET', `/${id}/checks?status=failed`)).json().data).toHaveLength(1);
  });

  it('reports pages that left the targets as removed, and pages through a check', async () => {
    const site: Site = { [`${E}/a`]: { html: word('ten') }, [`${E}/b`]: { html: word('eleven') } };
    const t = await makeJobsApp({ site });
    const id = (await call(t, 'POST', '', { ...body, targets: [{ type: 'scrape', urls: [`${E}/a`, `${E}/b`] }] })).json().data.id as string;
    await run(t, id);
    await call(t, 'PATCH', `/${id}`, { targets: [{ type: 'scrape', urls: [`${E}/a`] }] });
    const started = (await call(t, 'POST', `/${id}/run`)).json();
    await drain(t.deps, t.queues);
    const page1 = (await call(t, 'GET', `/${id}/checks/${started.id}?limit=1`)).json();
    expect(page1.data.pages).toHaveLength(1);
    expect(page1.next).toContain('skip=1');
    const page2 = (await call(t, 'GET', `/${id}/checks/${started.id}?limit=1&skip=1`)).json();
    expect(page2.data.pages).toHaveLength(1);
    expect(page2.next).toBeNull();
    const removed = (await call(t, 'GET', `/${id}/checks/${started.id}?status=removed`)).json().data.pages;
    expect(removed.map((p: PageView) => p.url)).toEqual([`${E}/b`]);
  });

  it('runs due monitors from the scheduler, skips overlapping runs and queues webhooks', async () => {
    const site: Site = { [`${E}/a`]: { html: word('ten') } };
    const t = await makeJobsApp({ site });
    const id = (await call(t, 'POST', '', { ...body, webhook: { url: 'https://hooks.example/m', metadata: { team: 'x' } } })).json().data.id as string;
    const monitors = t.deps.monitors!;

    expect(await startDueChecks({ monitors, queues: t.queues })).toBe(0);
    await monitors.updateMonitor(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    expect(await startDueChecks({ monitors, queues: t.queues })).toBe(1);
    const afterClaim = await monitors.getMonitor(id);
    expect(Date.parse(afterClaim!.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(await startDueChecks({ monitors, queues: t.queues })).toBe(0);

    // the scheduled check is still queued, so a manual run is recorded as skipped
    const manual = (await call(t, 'POST', `/${id}/run`)).json();
    expect(manual.data.status).toBe('skipped_overlap');

    await drain(t.deps, t.queues);
    const [latestScheduled] = (await call(t, 'GET', `/${id}/checks?status=completed`)).json().data;
    expect(latestScheduled).toMatchObject({ trigger: 'scheduled', summary: { new: 1 } });
    const types = t.queues.webhooks.map((w) => (JSON.parse(w.body) as { type: string }).type);
    expect(types).toEqual(['monitor.page', 'monitor.check.completed']);
    expect(JSON.parse(t.queues.webhooks[1].body)).toMatchObject({ metadata: { team: 'x' }, data: [{ summary: { new: 1 } }] });
  });

  it('keeps going when one target cannot be resolved', async () => {
    const t = await makeJobsApp({ site: { [`${E}/a`]: { html: word('ten') } } });
    const id = (await call(t, 'POST', '', { ...body, targets: [{ type: 'scrape', urls: [`${E}/a`] }, { type: 'search', queries: ['x'] }] })).json().data.id as string;
    const check = await run(t, id);
    expect(check.status).toBe('partial');
    const full = (await call(t, 'GET', `/${id}/checks?limit=1`)).json().data[0];
    expect(full.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'search', status: 'error' })]));
  });
});
