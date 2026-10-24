import { describe, expect, it } from 'vitest';
import { buildReceipt, checkStoredHashes, sha256Hex } from '../src';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  statusCode: 200,
  fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
  engineChain: [{ engine: 'fetch', verdict: 'ok' as const, confidence: 0.95, reasons: [], durationMs: 12 }],
  htmlBytes: Buffer.from('<html>hi</html>'),
  markdown: 'hi',
  converter: { name: 'icecrawl-convert', version: '1' },
  options: { onlyMainContent: true, skipTlsVerification: true },
};

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildReceipt', () => {
  it('records hashes, chain and timestamps', () => {
    const r = buildReceipt(base);
    expect(r.version).toBe(1);
    expect(r.id).toBe(base.id);
    expect(r.fetchedAt).toBe('2026-10-24T10:00:00.000Z');
    expect(r.htmlSha256).toBe(sha256Hex(base.htmlBytes));
    expect(r.outputSha256).toBe(sha256Hex('hi'));
    expect(r.engineChain).toHaveLength(1);
    expect(r.options.skipTlsVerification).toBe(true);
  });

  it('uses null hashes when there is no body or output', () => {
    const r = buildReceipt({ ...base, htmlBytes: null, markdown: null });
    expect(r.htmlSha256).toBeNull();
    expect(r.outputSha256).toBeNull();
  });
});

describe('checkStoredHashes', () => {
  it('passes for untouched data and fails after a one-byte change', () => {
    const r = buildReceipt(base);
    expect(checkStoredHashes(r, base.htmlBytes, 'hi')).toEqual({ html: true, output: true });
    const tampered = Buffer.from('<html>hj</html>');
    expect(checkStoredHashes(r, tampered, 'hi').html).toBe(false);
    expect(checkStoredHashes(r, base.htmlBytes, 'hI').output).toBe(false);
  });
});
