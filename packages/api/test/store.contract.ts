import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
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
    });
  });
}
