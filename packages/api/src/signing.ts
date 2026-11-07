import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateSigningKey, signingKeyFromPem, type PrivateSigningKey } from '@icecrawl/trust';
import type { Store } from './store/types';

async function readPem(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function register(store: Store, pem: string): Promise<PrivateSigningKey> {
  const { privateKey, publicKey } = signingKeyFromPem(pem);
  await store.registerPublicKey(publicKey);
  return privateKey;
}

/**
 * A signing key given through the environment (for hosts without a persistent disk): a PEM, either as is, with `\n`
 * written out, or base64 encoded. The key is registered in the store like a key read from a file.
 */
export async function signingKeyFromEnv(value: string, store: Store): Promise<PrivateSigningKey> {
  const text = value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8');
  if (!text.includes('BEGIN')) throw new Error('ICECRAWL_SIGNING_KEY must be a PEM private key, plain or base64 encoded');
  return register(store, text.trim() + '\n');
}

export async function loadOrCreateSigningKey(file: string, store: Store): Promise<PrivateSigningKey> {
  let pem = await readPem(file);
  if (pem === null) {
    pem = generateSigningKey().privateKey.privateKeyPem;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pem, { mode: 0o600, flag: 'wx' });
  }
  return register(store, pem);
}

export async function rotateSigningKey(
  file: string,
  store: Store,
): Promise<{ oldKeyId: string | null; newKeyId: string }> {
  const oldPem = await readPem(file);
  let oldKeyId: string | null = null;
  if (oldPem !== null) {
    oldKeyId = signingKeyFromPem(oldPem).privateKey.keyId;
    await rename(file, `${file}.${oldKeyId}.bak`);
  }
  const fresh = generateSigningKey();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, fresh.privateKey.privateKeyPem, { mode: 0o600, flag: 'wx' });
  await store.registerPublicKey(fresh.publicKey);
  if (oldKeyId !== null) await store.retireKey(oldKeyId);
  return { oldKeyId, newKeyId: fresh.privateKey.keyId };
}
