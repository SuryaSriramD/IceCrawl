import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey, rotateSigningKey } from '../src/signing';
import { MemoryStore } from '../src/store/memory';

describe('signing key management', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'icecrawl-sign-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('creates a key file on first use and registers its public key', async () => {
    const dir = await tmp();
    const file = join(dir, 'nested', 'signing-key.pem');
    const store = new MemoryStore();
    const key = await loadOrCreateSigningKey(file, store);
    expect(key.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(await readFile(file, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect((await store.listPublicKeys()).map((k) => k.keyId)).toEqual([key.keyId]);
  });

  it('reloads the same key without registering it twice', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const store = new MemoryStore();
    const a = await loadOrCreateSigningKey(file, store);
    const b = await loadOrCreateSigningKey(file, store);
    expect(b.keyId).toBe(a.keyId);
    expect(await store.listPublicKeys()).toHaveLength(1);
  });

  it('registers an existing key file that the store does not know yet', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const first = await loadOrCreateSigningKey(file, new MemoryStore());
    const freshStore = new MemoryStore();
    const again = await loadOrCreateSigningKey(file, freshStore);
    expect(again.keyId).toBe(first.keyId);
    expect(await freshStore.listPublicKeys()).toHaveLength(1);
  });

  it('rotates: keeps the old private key as a backup, retires it, and registers the new one', async () => {
    const dir = await tmp();
    const file = join(dir, 'signing-key.pem');
    const store = new MemoryStore();
    const old = await loadOrCreateSigningKey(file, store);
    const result = await rotateSigningKey(file, store);
    expect(result.oldKeyId).toBe(old.keyId);
    expect(result.newKeyId).not.toBe(old.keyId);
    const keys = await store.listPublicKeys();
    expect(keys.map((k) => k.keyId)).toEqual([old.keyId, result.newKeyId]);
    expect(keys[0].retiredAt).not.toBeNull();
    expect(keys[1].retiredAt).toBeNull();
    expect((await readdir(dir)).some((f) => f.includes(old.keyId))).toBe(true);
    expect((await loadOrCreateSigningKey(file, store)).keyId).toBe(result.newKeyId);
  });

  it('rotate works when no key exists yet', async () => {
    const dir = await tmp();
    const result = await rotateSigningKey(join(dir, 'signing-key.pem'), new MemoryStore());
    expect(result.oldKeyId).toBeNull();
  });
});
