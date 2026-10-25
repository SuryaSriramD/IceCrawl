import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MonitorStore, NewMonitor } from '../src/monitor/types';
import { migrate } from '../src/store/migrate';
import { MemoryMonitorStore } from '../src/store/monitor-memory';
import { PgMonitorStore } from '../src/store/monitor-pg';
import { createSql } from '../src/store/pg';

const monitor = (over: Partial<NewMonitor> = {}): NewMonitor => ({
  id: randomUUID(),
  apiKeyId: null,
  name: 'm',
  status: 'active',
  cron: '0 * * * *',
  timezone: 'UTC',
  targets: [{ id: randomUUID(), type: 'scrape', urls: ['https://example.com/a'] }],
  webhook: null,
  notification: null,
  retentionDays: 30,
  goal: null,
  judgeEnabled: false,
  nextRunAt: null,
  ...over,
});

function contract(name: string, make: () => Promise<MonitorStore>) {
  describe(`monitor store: ${name}`, () => {
    let store: MonitorStore;
    beforeEach(async () => {
      store = await make();
    });

    it('creates, reads, updates, lists and deletes monitors', async () => {
      const a = await store.createMonitor(monitor({ name: 'a' }));
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createMonitor(monitor({ name: 'b', webhook: { url: 'https://h.example/x', events: ['monitor.check.completed'] } }));
      expect(await store.getMonitor(a.id)).toMatchObject({ name: 'a', status: 'active', lastRunAt: null, currentCheckId: null });
      expect((await store.listMonitors(null, 10, 0)).map((m) => m.id)).toEqual([b.id, a.id]);
      expect((await store.listMonitors(null, 1, 1)).map((m) => m.id)).toEqual([a.id]);
      const updated = await store.updateMonitor(a.id, { name: 'renamed', status: 'paused', lastCheckSummary: { totalPages: 1, same: 1, changed: 0, new: 0, removed: 0, error: 0 } });
      expect(updated).toMatchObject({ name: 'renamed', status: 'paused', lastCheckSummary: { same: 1 } });
      expect(await store.updateMonitor(randomUUID(), { name: 'x' })).toBeNull();
      expect(await store.deleteMonitor(a.id)).toBe(true);
      expect(await store.deleteMonitor(a.id)).toBe(false);
      expect(await store.getMonitor(a.id)).toBeNull();
    });

    it('claims due monitors once and moves their next run forward', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const due = await store.createMonitor(monitor({ nextRunAt: past }));
      await store.createMonitor(monitor({ nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }));
      await store.createMonitor(monitor({ nextRunAt: past, status: 'paused' }));
      const next = new Date(Date.now() + 1_800_000);
      const claimed = await store.claimDue(new Date(), 10, () => next);
      expect(claimed.map((m) => m.id)).toEqual([due.id]);
      expect((await store.getMonitor(due.id))?.nextRunAt).toBe(next.toISOString());
      expect(await store.claimDue(new Date(), 10, () => next)).toEqual([]);
    });

    it('stores checks and pages and filters them', async () => {
      const m = await store.createMonitor(monitor());
      const c1 = await store.createCheck({ id: randomUUID(), monitorId: m.id, status: 'queued', trigger: 'manual', scheduledFor: null, startedAt: null, finishedAt: null, summary: null, targetResults: null, error: null });
      await new Promise((r) => setTimeout(r, 5));
      const c2 = await store.createCheck({ id: randomUUID(), monitorId: m.id, status: 'completed', trigger: 'scheduled', scheduledFor: new Date().toISOString(), startedAt: null, finishedAt: null, summary: { totalPages: 0, same: 0, changed: 0, new: 0, removed: 0, error: 0 }, targetResults: null, error: null });
      expect((await store.listChecks(m.id, { limit: 10, offset: 0 })).map((c) => c.id)).toEqual([c2.id, c1.id]);
      expect((await store.listChecks(m.id, { limit: 10, offset: 0, status: 'queued' })).map((c) => c.id)).toEqual([c1.id]);
      await store.updateCheck(c1.id, { status: 'completed', finishedAt: new Date().toISOString(), summary: { totalPages: 2, same: 1, changed: 1, new: 0, removed: 0, error: 0 }, targetResults: [{ ok: true }] });
      expect(await store.findCheck(c1.id)).toMatchObject({ status: 'completed', summary: { changed: 1 }, targetResults: [{ ok: true }] });
      expect(await store.getCheck(randomUUID(), c1.id)).toBeNull();

      for (const [i, status] of (['same', 'changed', 'error'] as const).entries()) {
        await store.addPage({ id: randomUUID(), checkId: c1.id, targetId: 't', url: `https://example.com/${i}`, status, previousScrapeId: null, currentScrapeId: null, statusCode: 200, error: null, metadata: null, diff: status === 'changed' ? { text: '-a\n+b' } : null });
      }
      expect((await store.listPages(c1.id, { skip: 0, limit: 10 })).map((p) => p.status)).toEqual(['same', 'changed', 'error']);
      expect((await store.listPages(c1.id, { skip: 1, limit: 1 })).map((p) => p.status)).toEqual(['changed']);
      expect((await store.listPages(c1.id, { skip: 0, limit: 10, status: 'changed' }))[0].diff).toEqual({ text: '-a\n+b' });
    });

    it('keeps one baseline per url and deletes them', async () => {
      const m = await store.createMonitor(monitor());
      const base = { monitorId: m.id, targetId: 't', scrapeId: null };
      await store.upsertBaseline({ ...base, url: 'https://example.com/a', contentHash: '1', markdown: 'one' });
      await store.upsertBaseline({ ...base, url: 'https://example.com/a', contentHash: '2', markdown: 'two' });
      await store.upsertBaseline({ ...base, url: 'https://example.com/b', contentHash: '3', markdown: 'three' });
      expect((await store.listBaselines(m.id)).map((b) => [b.url, b.contentHash]).sort()).toEqual([['https://example.com/a', '2'], ['https://example.com/b', '3']]);
      await store.deleteBaselines(m.id, ['https://example.com/a']);
      expect((await store.listBaselines(m.id)).map((b) => b.url)).toEqual(['https://example.com/b']);
      await store.deleteBaselines(m.id, []);
    });

    it('applies retention and fails checks that never finished', async () => {
      const m = await store.createMonitor(monitor({ retentionDays: 1 }));
      const stuck = await store.createCheck({ id: randomUUID(), monitorId: m.id, status: 'running', trigger: 'scheduled', scheduledFor: null, startedAt: null, finishedAt: null, summary: null, targetResults: null, error: null });
      await store.updateMonitor(m.id, { currentCheckId: stuck.id });
      expect(await store.failStaleChecks(new Date(Date.now() - 3_600_000))).toBe(0);
      expect(await store.failStaleChecks(new Date(Date.now() + 1000))).toBe(1);
      expect(await store.findCheck(stuck.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('did not finish') });
      expect((await store.getMonitor(m.id))?.currentCheckId).toBeNull();
      expect(await store.deleteExpiredChecks(new Date())).toBe(0);
      expect(await store.deleteExpiredChecks(new Date(Date.now() + 3 * 86_400_000))).toBe(1);
      expect(await store.findCheck(stuck.id)).toBeNull();
    });
  });
}

contract('memory', async () => new MemoryMonitorStore());

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('postgres monitors', () => {
  const sql = createSql(url ?? 'postgres://unused');
  afterAll(async () => {
    await sql.end();
  });
  contract('postgres', async () => {
    await migrate(sql);
    await sql`truncate monitors cascade`;
    return new PgMonitorStore(sql);
  });
});
