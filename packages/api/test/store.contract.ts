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

    it('counts usage per key inside a time window, with extract tokens', async () => {
      const a = randomUUID();
      const b = randomUUID();
      for (const id of [a, b]) await store.createApiKey({ id, hash: `h-${id}`, name: id });
      const at = (key: string, createdAt: string) => ({ ...sampleScrape(randomUUID(), key), createdAt });
      for (const rec of [at(a, '2026-05-10T10:00:00.000Z'), at(a, '2026-05-20T10:00:00.000Z'), at(a, '2026-06-02T10:00:00.000Z'), at(b, '2026-05-11T10:00:00.000Z')]) {
        await store.saveScrape(rec, sampleReceipt(rec.id), null);
      }
      const may = [new Date('2026-05-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z')] as const;
      expect(await store.usageBetween(a, ...may)).toEqual({ scrapes: 2, tokens: 0 });
      expect((await store.usageBetween(b, ...may)).scrapes).toBe(1);

      const job = newJob({ type: 'extract', apiKeyId: a, limit: 0 });
      await store.createJob(job);
      await store.saveJobResult(job.id, { data: {} }, 42);
      const now = Date.now();
      expect((await store.usageBetween(a, new Date(now - 60_000), new Date(now + 60_000))).tokens).toBe(42);
      expect((await store.usageBetween(b, new Date(now - 60_000), new Date(now + 60_000))).tokens).toBe(0);
    });

    it('lists recent scrapes newest first, with a cursor and an endpoint filter', async () => {
      const key = randomUUID();
      await store.createApiKey({ id: key, hash: `h-${key}`, name: key });
      const job = newJob({ type: 'batch', apiKeyId: key });
      await store.createJob(job);
      const mk = (createdAt: string, jobId: string | null) => ({ ...sampleScrape(randomUUID(), key), createdAt, jobId, url: `https://example.com/${createdAt}` });
      const recs = [mk('2026-05-01T10:00:00.000Z', null), mk('2026-05-02T10:00:00.000Z', job.id), mk('2026-05-03T10:00:00.000Z', null)];
      for (const rec of recs) await store.saveScrape(rec, sampleReceipt(rec.id), null);

      const all = await store.recentScrapes(key, { limit: 10 });
      expect(all.map((r) => r.id)).toEqual([recs[2].id, recs[1].id, recs[0].id]);
      expect(all.map((r) => r.endpoint)).toEqual(['scrape', 'batch_scrape', 'scrape']);
      expect(all[0]).toEqual({ id: recs[2].id, endpoint: 'scrape', createdAt: '2026-05-03T10:00:00.000Z', url: recs[2].url });
      expect((await store.recentScrapes(key, { limit: 1 })).map((r) => r.id)).toEqual([recs[2].id]);
      expect((await store.recentScrapes(key, { limit: 10, before: '2026-05-03T10:00:00.000Z' })).map((r) => r.id)).toEqual([recs[1].id, recs[0].id]);
      expect((await store.recentScrapes(key, { limit: 10, endpoint: 'batch_scrape' })).map((r) => r.id)).toEqual([recs[1].id]);
      expect(await store.recentScrapes(randomUUID(), { limit: 10 })).toEqual([]);
    });

    it('reports when the last successful scrape happened', async () => {
      const key = randomUUID();
      await store.createApiKey({ id: key, hash: `h-${key}`, name: key });
      expect(await store.latestScrapeAt(key)).toBeNull();
      const ok = { ...sampleScrape(randomUUID(), key), createdAt: '2026-05-03T10:00:00.000Z' };
      const failed = { ...sampleScrape(randomUUID(), key), createdAt: '2026-05-09T10:00:00.000Z', response: { success: false } };
      for (const rec of [ok, failed]) await store.saveScrape(rec, sampleReceipt(rec.id), null);
      expect(await store.latestScrapeAt(key)).toBe('2026-05-03T10:00:00.000Z');
    });

    it('fails only the running jobs that are older than the cutoff, keeping any stored result', async () => {
      const running = newJob();
      const done = newJob();
      for (const j of [running, done]) await store.createJob(j);
      await store.finalizeJob(done.id, 'completed');
      expect(await store.failStaleJobs(new Date(Date.now() - 60_000))).toBe(0);
      expect((await store.getJob(running.id))?.status).toBe('scraping');
      expect(await store.failStaleJobs(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
      expect(await store.getJob(running.id)).toMatchObject({ status: 'failed', result: { code: 'TIMEOUT' } });
      expect((await store.getJob(running.id))?.completedAt).not.toBeNull();
      expect((await store.getJob(done.id))?.status).toBe('completed');
    });

    it('answers a ping', async () => {
      await expect(store.ping()).resolves.toBeUndefined();
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

    it('searches the pages a key scraped successfully, latest copy of each URL, best match first', async () => {
      const keyA = randomUUID();
      const keyB = randomUUID();
      await store.createApiKey({ id: keyA, hash: `hash-${keyA}`, name: 'a' });
      await store.createApiKey({ id: keyB, hash: `hash-${keyB}`, name: 'b' });
      const save = async (over: Partial<ScrapeRecord> & { key: string }) => {
        const id = randomUUID();
        const { key, ...rest } = over;
        await store.saveScrape({ ...sampleScrape(id, key), ...rest }, sampleReceipt(id), null);
        await new Promise((r) => setTimeout(r, 5));
        return id;
      };
      const ok = { response: { success: true } };
      const old = await save({ key: keyA, finalUrl: 'https://example.com/pricing', markdown: 'The plan costs ten dollars a month.', metadata: { title: 'Pricing' }, ...ok });
      const latest = await save({ key: keyA, finalUrl: 'https://example.com/pricing', markdown: 'The plan costs twelve dollars a month. Pricing pricing pricing.', metadata: { title: 'Pricing' }, ...ok });
      await save({ key: keyA, finalUrl: 'https://example.com/blog', markdown: 'A post that mentions pricing once and little else of use today.', ...ok });
      await save({ key: keyA, finalUrl: 'https://example.com/walled', markdown: 'pricing behind a captcha', response: { success: false } });
      await save({ key: keyB, finalUrl: 'https://other.example/pricing', markdown: 'pricing of someone else', ...ok });

      const hits = await store.searchScrapes(keyA, 'pricing', 10);
      expect(hits.map((h) => h.url)).toEqual(['https://example.com/pricing', 'https://example.com/blog']);
      expect(hits[0]).toMatchObject({ scrapeId: latest, title: 'Pricing' });
      expect(hits.some((h) => h.scrapeId === old)).toBe(false);
      expect(hits[0].snippet.toLowerCase()).toContain('pricing');
      expect((await store.searchScrapes(keyA, 'pricing', 1)).length).toBe(1);
      expect((await store.searchScrapes(keyA, 'pricing', 10, 'https://example.com/b')).map((h) => h.url)).toEqual(['https://example.com/blog']);
      expect(await store.searchScrapes(keyA, 'nonexistentword', 10)).toEqual([]);
      expect(await store.searchScrapes(keyA, '   ', 10)).toEqual([]);
      expect((await store.searchScrapes(keyB, 'pricing', 10)).map((h) => h.url)).toEqual(['https://other.example/pricing']);
    });

    it('lists the newest jobs of one type for one key', async () => {
      const keyA = randomUUID();
      await store.createApiKey({ id: keyA, hash: `hash-${keyA}`, name: 'a' });
      const first = newJob({ apiKeyId: keyA, type: 'agent' });
      const second = newJob({ apiKeyId: keyA, type: 'agent' });
      const crawl = newJob({ apiKeyId: keyA });
      for (const j of [first, crawl, second]) {
        await store.createJob(j);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect((await store.listJobs(keyA, 'agent', 10)).map((j) => j.id)).toEqual([second.id, first.id]);
      expect((await store.listJobs(keyA, 'agent', 1)).map((j) => j.id)).toEqual([second.id]);
      expect(await store.listJobs(null, 'agent', 10)).toEqual([]);
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

    it('stores the result of an extract job', async () => {
      const job = newJob({ type: 'extract', limit: 0, request: { urls: ['https://example.com'] } });
      await store.createJob(job);
      expect(await store.getJob(job.id)).toMatchObject({ type: 'extract', status: 'scraping', result: null, tokensUsed: null });
      await store.saveJobResult(job.id, { data: { a: 1 }, trust: { sources: [] } }, 42);
      expect(await store.getJob(job.id)).toMatchObject({ result: { data: { a: 1 }, trust: { sources: [] } }, tokensUsed: 42 });
      await store.saveJobResult(job.id, { error: 'x', code: 'LLM_ERROR' }, null);
      expect(await store.getJob(job.id)).toMatchObject({ result: { error: 'x', code: 'LLM_ERROR' }, tokensUsed: null });
    });
  });
}
