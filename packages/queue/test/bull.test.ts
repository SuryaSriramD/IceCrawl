import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BullQueues, PermanentError, startWorkers, type JobContext, type ScrapeJobData, type WebhookJobData } from '../src';

const redisUrl = process.env.REDIS_URL;

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!redisUrl)('BullQueues', () => {
  let q: BullQueues;
  let stop: (() => Promise<void>) | undefined;
  const prefix = () => `icecrawl-test-${randomUUID().slice(0, 8)}`;

  beforeEach(() => {
    q = new BullQueues({ redisUrl: redisUrl!, prefix: prefix(), maxAttempts: 3 });
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    const keys = await q.connection.keys(`${q.prefix}:*`);
    if (keys.length > 0) await q.connection.del(...keys);
    await q.close();
  });

  const handlers = (over: Partial<Parameters<typeof startWorkers>[1]> = {}) => ({
    scrape: async () => ({}),
    webhook: async () => {},
    ...over,
  });

  it('delivers page and discover jobs to the scrape handler', async () => {
    const seen: ScrapeJobData[] = [];
    stop = (await Promise.resolve(startWorkers(q, handlers({ scrape: async (d) => (seen.push(d), {}) }), { concurrency: 2 }))).close;
    await q.addDiscover('job-1');
    await q.addPages([{ jobId: 'job-1', url: 'https://e.com/a', depth: 2, external: true }]);
    await until(() => seen.length === 2);
    expect(seen).toContainEqual({ kind: 'discover', jobId: 'job-1' });
    expect(seen).toContainEqual({ kind: 'page', jobId: 'job-1', url: 'https://e.com/a', depth: 2, external: true });
  });

  it('re-schedules a job when the handler asks for a delay, without using a retry', async () => {
    const calls: Array<{ at: number; ctx: JobContext }> = [];
    stop = startWorkers(
      q,
      handlers({
        scrape: async (_d, ctx) => {
          calls.push({ at: Date.now(), ctx });
          return calls.length === 1 ? { delayMs: 400 } : {};
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addPages([{ jobId: 'j', url: 'https://e.com/a', depth: 0, external: false }]);
    await until(() => calls.length === 2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(350);
    expect(calls[1].ctx.attemptsMade).toBe(0);
    expect(calls[1].ctx.maxAttempts).toBe(3);
  });

  it('retries a failing handler with backoff and stops after maxAttempts', async () => {
    const attempts: number[] = [];
    stop = startWorkers(
      q,
      handlers({
        scrape: async (_d, ctx) => {
          attempts.push(ctx.attemptsMade);
          throw new Error('transient');
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addPages([{ jobId: 'j', url: 'https://e.com/a', depth: 0, external: false }]);
    await until(() => attempts.length === 3, 15000);
    await new Promise((r) => setTimeout(r, 300));
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('does not retry a PermanentError', async () => {
    let calls = 0;
    const webhooks: WebhookJobData[] = [];
    stop = startWorkers(
      q,
      handlers({
        webhook: async (d) => {
          calls++;
          webhooks.push(d);
          throw new PermanentError('never');
        },
      }),
      { concurrency: 1 },
    ).close;
    await q.addWebhook({ jobId: 'j', webhookId: 'w', url: 'https://hooks.example/x', headers: { a: 'b' }, body: '{"x":1}' });
    await until(() => calls >= 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(1);
    expect(webhooks[0]).toMatchObject({ webhookId: 'w', headers: { a: 'b' }, body: '{"x":1}' });
  });

  it('de-duplicates URLs per job in Redis', async () => {
    expect(await q.markSeen('j1', ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(await q.markSeen('j1', ['b', 'c'])).toEqual(['c']);
    expect(await q.markSeen('j2', ['a'])).toEqual(['a']);
    await q.clearJob('j1');
    expect(await q.markSeen('j1', ['a'])).toEqual(['a']);
  });

  it('limits concurrency and spaces requests with slots', async () => {
    const a = await q.acquireSlot('j', { maxConcurrency: 2 });
    const b = await q.acquireSlot('j', { maxConcurrency: 2 });
    const c = await q.acquireSlot('j', { maxConcurrency: 2 });
    expect(a.ok && b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (a.ok) await a.release();
    expect((await q.acquireSlot('j', { maxConcurrency: 2 })).ok).toBe(true);

    const first = await q.acquireSlot('d', { delayMs: 500 });
    const second = await q.acquireSlot('d', { delayMs: 500 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.retryInMs).toBeGreaterThan(0);
    if (!second.ok) expect(second.retryInMs).toBeLessThanOrEqual(500);
  });

  it('does not leak a concurrency slot when the delay slot is refused', async () => {
    await q.acquireSlot('x', { delayMs: 500 });
    const refused = await q.acquireSlot('x', { maxConcurrency: 1, delayMs: 500 });
    expect(refused.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect((await q.acquireSlot('x', { maxConcurrency: 1, delayMs: 500 })).ok).toBe(true);
  });

  it('delivers extract jobs to the scrape handler', async () => {
    const seen: ScrapeJobData[] = [];
    stop = (await Promise.resolve(startWorkers(q, handlers({ scrape: async (d) => (seen.push(d), {}) }), { concurrency: 1 }))).close;
    await q.addExtract('job-9');
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ kind: 'extract', jobId: 'job-9' });
  });
});
