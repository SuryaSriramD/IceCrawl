import { describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
import { canonicalJson, generateSigningKey, signReceipt, signingKeyFromPem, verifySignature } from '../src';

const receipt: Receipt = {
  version: 1,
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  statusCode: 200,
  fetchedAt: '2026-10-24T10:00:00.000Z',
  engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.95, reasons: [], durationMs: 12 }],
  htmlSha256: 'a'.repeat(64),
  outputSha256: 'b'.repeat(64),
  converter: { name: 'icecrawl-convert', version: '1' },
  contentType: 'text/html',
  screenshotSha256: null,
  options: { onlyMainContent: true, skipTlsVerification: true },
};

describe('canonicalJson', () => {
  it('sorts object keys recursively and removes whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}],"b":1}');
  });

  it('ignores undefined object members like JSON.stringify but maps undefined array items to null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('serializes strings, numbers, booleans and null like ECMAScript', () => {
    expect(canonicalJson({ s: 'é"\n\u0001', n: 1e21, z: -0, t: true, f: false, x: null })).toBe(
      '{"f":false,"n":1e+21,"s":"é\\"\\n\\u0001","t":true,"x":null,"z":0}',
    );
  });

  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalJson({ 'é': 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
  });

  it('throws on values that cannot be represented', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it('is stable across a JSON round trip (as stored in Postgres jsonb)', () => {
    expect(canonicalJson(JSON.parse(JSON.stringify(receipt)))).toBe(canonicalJson(receipt));
  });
});

describe('signing', () => {
  it('derives a stable key id and produces an Ed25519 signature that verifies', () => {
    const { privateKey, publicKey } = generateSigningKey(new Date('2026-10-24T00:00:00.000Z'));
    expect(privateKey.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(publicKey).toMatchObject({ keyId: privateKey.keyId, alg: 'Ed25519', retiredAt: null, createdAt: '2026-10-24T00:00:00.000Z' });
    const sig = signReceipt(receipt, privateKey);
    expect(sig).toMatchObject({ alg: 'Ed25519', keyId: privateKey.keyId });
    expect(Buffer.from(sig.sig, 'base64')).toHaveLength(64);
    expect(verifySignature(receipt, sig, publicKey.publicKey)).toBe(true);
  });

  it('rejects any change to the receipt', () => {
    const { privateKey, publicKey } = generateSigningKey();
    const sig = signReceipt(receipt, privateKey);
    expect(verifySignature({ ...receipt, outputSha256: 'c'.repeat(64) }, sig, publicKey.publicKey)).toBe(false);
    expect(verifySignature({ ...receipt, finalUrl: 'https://evil.example/' }, sig, publicKey.publicKey)).toBe(false);
    expect(verifySignature({ ...receipt, engineChain: [] }, sig, publicKey.publicKey)).toBe(false);
  });

  it('rejects a signature from a different key and malformed input', () => {
    const a = generateSigningKey();
    const b = generateSigningKey();
    const sig = signReceipt(receipt, a.privateKey);
    expect(verifySignature(receipt, sig, b.publicKey.publicKey)).toBe(false);
    expect(verifySignature(receipt, { ...sig, sig: '!!!' }, a.publicKey.publicKey)).toBe(false);
    expect(verifySignature(receipt, sig, 'not-a-key')).toBe(false);
  });

  it('reloads the same key id and public key from a PEM', () => {
    const { privateKey, publicKey } = generateSigningKey();
    const again = signingKeyFromPem(privateKey.privateKeyPem);
    expect(again.privateKey.keyId).toBe(privateKey.keyId);
    expect(again.publicKey.publicKey).toBe(publicKey.publicKey);
    expect(verifySignature(receipt, signReceipt(receipt, again.privateKey), publicKey.publicKey)).toBe(true);
  });
});
