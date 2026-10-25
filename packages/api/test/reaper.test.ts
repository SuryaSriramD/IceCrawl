import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reapOnce } from '../src/jobs/reaper';
import { MemoryStore } from '../src/store/memory';

const HOUR = 3_600_000;

async function newJob(store: MemoryStore, type: 'crawl' | 'extract' = 'extract', expiresInMs = 24 * HOUR) {
  const id = randomUUID();
  await store.createJob({ id, type, apiKeyId: null, request: {}, webhook: null, limit: 1, expiresAt: new Date(Date.now() + expiresInMs) });
  return id;
}

describe('reapOnce', () => {
  it('leaves a job alone until it has run longer than the maximum, then marks it failed', async () => {
    const store = new MemoryStore();
    const id = await newJob(store);
    expect(await reapOnce(store, 6 * HOUR)).toEqual({ failed: 0, deleted: 0 });
    expect((await store.getJob(id))?.status).toBe('scraping');

    // seven hours later its worker is presumed lost
    expect((await reapOnce(store, 6 * HOUR, new Date(Date.now() + 7 * HOUR))).failed).toBe(1);
    const job = await store.getJob(id);
    expect(job).toMatchObject({ status: 'failed', result: { code: 'TIMEOUT' } });
    expect(job?.completedAt).not.toBeNull();
  });

  it('does not touch finished jobs, and keeps a result the job had already stored', async () => {
    const store = new MemoryStore();
    const done = await newJob(store);
    await store.saveJobResult(done, { data: { a: 1 } }, 5);
    await store.finalizeJob(done, 'completed');
    const running = await newJob(store);
    await store.saveJobResult(running, { partial: true }, null);

    expect((await reapOnce(store, HOUR, new Date(Date.now() + 2 * HOUR))).failed).toBe(1);
    expect(await store.getJob(done)).toMatchObject({ status: 'completed', result: { data: { a: 1 } } });
    expect(await store.getJob(running)).toMatchObject({ status: 'failed', result: { partial: true } });
  });

  it('deletes expired jobs in the same pass', async () => {
    const store = new MemoryStore();
    const id = await newJob(store, 'crawl', -1000);
    await store.finalizeJob(id, 'completed');
    expect((await reapOnce(store, 6 * HOUR)).deleted).toBe(1);
    expect(await store.getJob(id)).toBeNull();
  });
});
