import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Receipt, ReceiptSignature, WebhookConfig } from '@icecrawl/core';
import type { ScrapeRecord, Store } from '../src/store/types';

export function sampleReceipt(id: string): Receipt {
  return {
    version: 1,
    id,
    requestedUrl: 'https://example.com/a',
    finalUrl: 'https://example.com/b',
    statusCode: 200,
    fetchedAt: '2026-10-24T10:00:00.000Z',
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.95, reasons: [], durationMs: 5 }],
    htmlSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    converter: { name: 'icecrawl-convert', version: '1' },
    options: { onlyMainContent: true, skipTlsVerification: true },
  };
}

export function sampleScrape(id: string, apiKeyId: string | null): ScrapeRecord {
  return {
    id,
    apiKeyId,
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/b',
    verdict: 'ok',
    confidence: 0.95,
    engine: 'fetch',
    statusCode: 200,
    markdown: '# hi',
    metadata: { title: 'T' },
    response: { success: true, data: { markdown: '# hi' } },
    createdAt: new Date().toISOString(),
  };
}

export function describeStoreContract(name: string, make: () => Promise<Store>) {
  describe(`${name} store contract`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
    });

    it('finds an API key by hash and reports revocation', async () => {
      const id = randomUUID();
      await store.createApiKey({ id, hash: `hash-${id}`, name: 'dev' });
      expect(await store.findApiKeyByHash(`hash-${id}`)).toEqual({ id, name: 'dev', revoked: false });
      await store.revokeApiKey(id);
      expect((await store.findApiKeyByHash(`hash-${id}`))?.revoked).toBe(true);
      expect(await store.findApiKeyByHash('missing')).toBeNull();
    });

    it('round-trips a scrape, its receipt and snapshot metadata', async () => {
      const keyId = randomUUID();
      await store.createApiKey({ id: keyId, hash: `h-${keyId}`, name: 'k' });
      const id = randomUUID();
      const rec = sampleScrape(id, keyId);
      await store.saveScrape(rec, sampleReceipt(id), { sha256: 'a'.repeat(64), key: 'aa/aaa', bytes: 42 });
      const got = await store.getScrape(id);
      expect(got).toMatchObject({ id, apiKeyId: keyId, verdict: 'ok', engine: 'fetch', statusCode: 200, markdown: '# hi' });
      expect(got?.response).toEqual(rec.response);
      expect(got?.metadata).toEqual({ title: 'T' });
      expect(await store.getReceipt(id)).toEqual(sampleReceipt(id));
    });

    it('stores a scrape without a snapshot or key', async () => {
      const id = randomUUID();
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null);
      expect((await store.getScrape(id))?.apiKeyId).toBeNull();
    });

    it('returns null for unknown ids', async () => {
      expect(await store.getScrape(randomUUID())).toBeNull();
      expect(await store.getReceipt(randomUUID())).toBeNull();
      expect(await store.getSignedReceipt(randomUUID())).toBeNull();
    });

    it('stores and returns a receipt signature', async () => {
      const id = randomUUID();
      const signature: ReceiptSignature = { alg: 'Ed25519', keyId: 'k_0123456789abcdef', sig: 'c2lnbmF0dXJl' };
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null, signature);
      expect(await store.getSignedReceipt(id)).toEqual({ receipt: sampleReceipt(id), signature });
    });

    it('returns a null signature for unsigned receipts', async () => {
      const id = randomUUID();
      await store.saveScrape(sampleScrape(id, null), sampleReceipt(id), null);
      expect(await store.getSignedReceipt(id)).toEqual({ receipt: sampleReceipt(id), signature: null });
    });

    it('registers, lists and retires public keys', async () => {
      const a = { keyId: `k_${randomUUID().slice(0, 16)}`, alg: 'Ed25519' as const, publicKey: 'QQ==', createdAt: '2026-10-24T10:00:00.000Z', retiredAt: null };
      const b = { ...a, keyId: `k_${randomUUID().slice(0, 16)}`, createdAt: '2026-10-25T10:00:00.000Z' };
      await store.registerPublicKey(a);
      await store.registerPublicKey(b);
      await store.registerPublicKey(a); // idempotent
      const before = (await store.listPublicKeys()).filter((k) => k.keyId === a.keyId || k.keyId === b.keyId);
      expect(before.map((k) => k.keyId)).toEqual([a.keyId, b.keyId]);
      expect(before.every((k) => k.retiredAt === null)).toBe(true);
      await store.retireKey(a.keyId);
      const after = (await store.listPublicKeys()).find((k) => k.keyId === a.keyId);
      expect(after?.retiredAt).not.toBeNull();
    });
    const newJob = (over: Partial<Parameters<Store['createJob']>[0]> = {}) => ({
      id: randomUUID(),
      type: 'crawl' as const,
      apiKeyId: null as string | null,
      request: { url: 'https://example.com' } as Record<string, unknown>,
      webhook: null as WebhookConfig | null,
      limit: 5,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...over,
    });

    it('creates and reads a job', async () => {
      const job = newJob({ webhook: { url: 'https://hooks.example.com/x', events: ['page'] } });
      await store.createJob(job);
      const got = await store.getJob(job.id);
      expect(got).toMatchObject({
        id: job.id,
        type: 'crawl',
        status: 'scraping',
        request: { url: 'https://example.com' },
        webhook: { url: 'https://hooks.example.com/x', events: ['page'] },
        limit: 5,
        total: 0,
        completed: 0,
        failed: 0,
        completedAt: null,
      });
      expect(Date.parse(got!.expiresAt)).toBeGreaterThan(Date.now());
      expect(await store.getJob(randomUUID())).toBeNull();
    });

    it('reserves URLs up to the limit atomically', async () => {
      const job = newJob({ limit: 5 });
      await store.createJob(job);
      expect(await store.reserveUrls(job.id, 3)).toBe(3);
      expect(await store.reserveUrls(job.id, 4)).toBe(2);
      expect(await store.reserveUrls(job.id, 1)).toBe(0);
      expect((await store.getJob(job.id))?.total).toBe(5);
    });

    it('never grants more than the limit under concurrent reservations', async () => {
      const job = newJob({ limit: 10 });
      await store.createJob(job);
      const grants = await Promise.all(Array.from({ length: 8 }, () => store.reserveUrls(job.id, 3)));
      expect(grants.reduce((a, b) => a + b, 0)).toBe(10);
      expect((await store.getJob(job.id))?.total).toBe(10);
    });

    it('records page results and finalizes exactly once', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.reserveUrls(job.id, 3);
      expect(await store.recordPageResult(job.id, 'completed')).toMatchObject({ total: 3, completed: 1, failed: 0, status: 'scraping' });
      expect(await store.recordPageResult(job.id, 'failed')).toMatchObject({ completed: 1, failed: 1 });
      const winner = await store.finalizeJob(job.id, 'completed');
      expect(winner).toMatchObject({ id: job.id, status: 'completed' });
      expect(winner?.completedAt).not.toBeNull();
      expect(await store.finalizeJob(job.id, 'failed')).toBeNull();
      expect((await store.getJob(job.id))?.status).toBe('completed');
    });

    it('cancels a running job once, refuses new reservations afterwards, and keeps counting', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.reserveUrls(job.id, 2);
      expect(await store.cancelJob(job.id)).toBe(true);
      expect(await store.cancelJob(job.id)).toBe(false);
      expect(await store.reserveUrls(job.id, 2)).toBe(0);
      expect(await store.recordPageResult(job.id, 'completed')).toMatchObject({ status: 'cancelled', completed: 1 });
      expect(await store.finalizeJob(job.id, 'completed')).toBeNull();
      expect((await store.getJob(job.id))?.status).toBe('cancelled');
      expect(await store.cancelJob(randomUUID())).toBe(false);
    });

    it('stores job errors in order', async () => {
      const job = newJob();
      await store.createJob(job);
      await store.addJobError(job.id, { url: 'https://example.com/a', error: 'boom', code: 'TIMEOUT', kind: 'error' });
      await store.addJobError(job.id, { url: 'https://example.com/b', error: 'Blocked by robots.txt', code: null, kind: 'robots' });
      const errors = await store.listJobErrors(job.id);
      expect(errors.map((e) => [e.url, e.kind, e.code])).toEqual([
        ['https://example.com/a', 'error', 'TIMEOUT'],
        ['https://example.com/b', 'robots', null],
      ]);
      expect(errors[0].id).toBeTruthy();
      expect(Date.parse(errors[0].timestamp)).not.toBeNaN();
    });

    it('lists only accepted pages of a job in insertion order and paginates by size', async () => {
      const job = newJob();
      await store.createJob(job);
      const mk = (n: number, success: boolean) => {
        const id = randomUUID();
        return {
          id,
          rec: { ...sampleScrape(id, null), jobId: job.id, response: success ? { success: true, data: { markdown: `page ${n}`, metadata: { n } } } : { success: false, code: 'BLOCKED', error: 'no' } },
        };
      };
      for (const [n, ok] of [[1, true], [2, false], [3, true], [4, true]] as const) {
        const s = mk(n, ok);
        await store.saveScrape(s.rec, sampleReceipt(s.id), null);
      }
      const all = await store.listJobPages(job.id, 0, 1_000_000);
      expect(all.items.map((i) => (i.metadata as { n: number }).n)).toEqual([1, 3, 4]);
      expect(all.nextSkip).toBeNull();

      const first = await store.listJobPages(job.id, 0, 10);
      expect(first.items).toHaveLength(1);
      expect(first.nextSkip).toBe(1);
      const second = await store.listJobPages(job.id, first.nextSkip!, 10);
      expect((second.items[0].metadata as { n: number }).n).toBe(3);
      const last = await store.listJobPages(job.id, 2, 10);
      expect((last.items[0].metadata as { n: number }).n).toBe(4);
      expect(last.nextSkip).toBeNull();
      expect((await store.listJobPages(job.id, 10, 1_000_000)).items).toEqual([]);
    });

    it('lists active jobs per API key', async () => {
      const keyA = randomUUID();
      const keyB = randomUUID();
      await store.createApiKey({ id: keyA, hash: `a-${keyA}`, name: 'a' });
      await store.createApiKey({ id: keyB, hash: `b-${keyB}`, name: 'b' });
      const running = newJob({ apiKeyId: keyA });
      const done = newJob({ apiKeyId: keyA });
      const other = newJob({ apiKeyId: keyB });
      for (const j of [running, done, other]) await store.createJob(j);
      await store.finalizeJob(done.id, 'completed');
      expect((await store.listActiveJobs(keyA)).map((j) => j.id)).toEqual([running.id]);
      expect((await store.listActiveJobs(keyB)).map((j) => j.id)).toEqual([other.id]);
    });

    it('deletes expired jobs together with their pages and receipts', async () => {
      const old = newJob({ expiresAt: new Date(Date.now() - 1000) });
      const fresh = newJob();
      await store.createJob(old);
      await store.createJob(fresh);
      const id = randomUUID();
      await store.saveScrape({ ...sampleScrape(id, null), jobId: old.id }, sampleReceipt(id), null);
      expect(await store.deleteExpiredJobs(new Date())).toBeGreaterThanOrEqual(1);
      expect(await store.getJob(old.id)).toBeNull();
      expect(await store.getJob(fresh.id)).not.toBeNull();
      expect(await store.getScrape(id)).toBeNull();
      expect(await store.getReceipt(id)).toBeNull();
    });
  });
}
