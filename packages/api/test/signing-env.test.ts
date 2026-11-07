import { describe, expect, it } from 'vitest';
import { generateSigningKey, signReceipt, verifySignature } from '@icecrawl/trust';
import { signingKeyFromEnv } from '../src/signing';
import { MemoryStore } from '../src/store/memory';
import { sampleReceipt } from './store.contract';

describe('signingKeyFromEnv', () => {
  const generated = generateSigningKey();
  const pem = generated.privateKey.privateKeyPem;

  it.each([
    ['a plain PEM', pem],
    ['a PEM with the newlines written as \\n', pem.trim().replace(/\n/g, '\\n')],
    ['a base64 encoded PEM', Buffer.from(pem).toString('base64')],
  ])('uses %s, registers its public key and signs with it', async (_label, value) => {
    const store = new MemoryStore();
    const key = await signingKeyFromEnv(value, store);
    expect(key.keyId).toBe(generated.privateKey.keyId);
    const keys = await store.listPublicKeys();
    expect(keys.map((k) => k.keyId)).toEqual([key.keyId]);
    const receipt = sampleReceipt('55555555-5555-4555-8555-555555555555');
    expect(verifySignature(receipt, signReceipt(receipt, key), keys[0].publicKey)).toBe(true);
  });

  it('gives the same key id after a restart, so receipts keep verifying', async () => {
    const store = new MemoryStore();
    const first = await signingKeyFromEnv(pem, store);
    const second = await signingKeyFromEnv(pem, store);
    expect(second.keyId).toBe(first.keyId);
    expect(await store.listPublicKeys()).toHaveLength(1);
  });

  it('refuses a value that is not a key, without echoing it', async () => {
    await expect(signingKeyFromEnv('hunter2-not-a-key', new MemoryStore())).rejects.toThrow(/ICECRAWL_SIGNING_KEY must be a PEM/);
    await expect(signingKeyFromEnv('hunter2-not-a-key', new MemoryStore())).rejects.not.toThrow(/hunter2/);
  });
});
