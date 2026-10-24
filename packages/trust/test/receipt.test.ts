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
  contentType: 'text/html; charset=utf-8',
  screenshot: null,
  options: { onlyMainContent: true, skipTlsVerification: true, removeBase64Images: true },
};

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildReceipt', () => {
  it('records the scan summary, or null when scanning was off', () => {
    const scan = { scanner: { name: 'icecrawl-injection-scan', version: '1' }, flagged: true, highest: 'high' as const, count: 2 };
    expect(buildReceipt({ ...base, scan }).scan).toEqual(scan);
    expect(buildReceipt(base).scan).toBeNull();
  });

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

  it('hashes the screenshot and records the content type', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const r = buildReceipt({ ...base, screenshot: png });
    expect(r.screenshotSha256).toBe(sha256Hex(png));
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.options.removeBase64Images).toBe(true);
    expect(buildReceipt(base).screenshotSha256).toBeNull();
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
