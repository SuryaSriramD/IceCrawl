import { describe, expect, it } from 'vitest';
import { MemoryQueues } from '../src';

describe('MemoryQueues', () => {
  it('queues pages and discover jobs in FIFO order', async () => {
    const q = new MemoryQueues();
    await q.addDiscover('j1');
    await q.addPages([
      { jobId: 'j1', url: 'https://e.com/a', depth: 0, external: false },
      { jobId: 'j1', url: 'https://e.com/b', depth: 1, external: true },
    ]);
    expect(q.takeNext()).toEqual({ kind: 'discover', jobId: 'j1' });
    expect(q.takeNext()).toEqual({ kind: 'page', jobId: 'j1', url: 'https://e.com/a', depth: 0, external: false });
    expect(q.takeNext()).toMatchObject({ url: 'https://e.com/b', external: true });
    expect(q.takeNext()).toBeUndefined();
  });

  it('reports only unseen URLs, per job, preserving order and removing duplicates', async () => {
    const q = new MemoryQueues();
    expect(await q.markSeen('j1', ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(await q.markSeen('j1', ['b', 'c'])).toEqual(['c']);
    expect(await q.markSeen('j2', ['a'])).toEqual(['a']);
    await q.clearJob('j1');
    expect(await q.markSeen('j1', ['a'])).toEqual(['a']);
    expect(q.cleared).toEqual(['j1']);
  });

  it('hands out slots and can be told to be busy', async () => {
    const q = new MemoryQueues();
    const ok = await q.acquireSlot('j1', { maxConcurrency: 1 });
    expect(ok.ok).toBe(true);
    q.busy.push(250);
    expect(await q.acquireSlot('j1', {})).toEqual({ ok: false, retryInMs: 250 });
    expect((await q.acquireSlot('j1', {})).ok).toBe(true);
  });

  it('collects webhook deliveries', async () => {
    const q = new MemoryQueues();
    await q.addWebhook({ jobId: 'j1', webhookId: 'w1', url: 'https://hooks.example/x', headers: {}, body: '{}' });
    expect(q.webhooks).toHaveLength(1);
  });

  it('queues extract jobs', async () => {
    const q = new MemoryQueues();
    await q.addExtract('j9');
    expect(q.takeNext()).toEqual({ kind: 'extract', jobId: 'j9' });
  });
});
