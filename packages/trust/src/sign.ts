import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { PublicKeyEntry, Receipt, ReceiptSignature } from '@icecrawl/core';

/**
 * RFC 8785 (JCS) for the JSON subset receipts use: objects, arrays, strings, finite numbers,
 * booleans and null. JSON.stringify already emits ECMAScript number and string forms, which JCS
 * mandates; keys are sorted by UTF-16 code units, which is the default string sort.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export interface PrivateSigningKey {
  keyId: string;
  privateKeyPem: string;
}

function keyIdOf(publicDer: Buffer): string {
  return `k_${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`;
}

export function signingKeyFromPem(
  pem: string,
  now: Date = new Date(),
): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry } {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
  const keyId = keyIdOf(der);
  return {
    privateKey: { keyId, privateKeyPem: pem },
    publicKey: { keyId, alg: 'Ed25519', publicKey: der.toString('base64'), createdAt: now.toISOString(), retiredAt: null },
  };
}

export function generateSigningKey(now: Date = new Date()): { privateKey: PrivateSigningKey; publicKey: PublicKeyEntry } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signingKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now);
}

export function signReceipt(receipt: Receipt, key: PrivateSigningKey): ReceiptSignature {
  const sig = sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), createPrivateKey(key.privateKeyPem));
  return { alg: 'Ed25519', keyId: key.keyId, sig: sig.toString('base64') };
}

export function verifySignature(receipt: Receipt, signature: ReceiptSignature, publicKeyBase64Der: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64Der, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canonicalJson(receipt), 'utf8'), publicKey, Buffer.from(signature.sig, 'base64'));
  } catch {
    return false;
  }
}
