import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Receipt, ReceiptSignature } from '@icecrawl/core';
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
  });
}
