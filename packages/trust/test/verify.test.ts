import { describe, expect, it } from 'vitest';
import type { Receipt } from '@icecrawl/core';
import { buildReceipt, generateSigningKey, sha256Hex, signReceipt, verifyReceipt } from '../src';

const html = Buffer.from('<html><body>hello</body></html>');
const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
const markdown = 'hello';

function setup(over: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  const key = generateSigningKey();
  const receipt: Receipt = buildReceipt({
    id: '11111111-1111-4111-8111-111111111111',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.9, reasons: [], durationMs: 3 }],
    htmlBytes: html,
    markdown,
    converter: { name: 'icecrawl-convert', version: '1' },
    contentType: 'text/html',
    screenshot: png,
    options: { onlyMainContent: true, skipTlsVerification: true },
    ...over,
  });
  const signature = signReceipt(receipt, key.privateKey);
  return { key, receipt, signature, publicKeys: [key.publicKey] };
}

const goodReplay = () => ({ markdown });

describe('verifyReceipt', () => {
  it('passes every check for untouched data', async () => {
    const { receipt, signature, publicKeys } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('pass');
    expect(r.html.status).toBe('pass');
    expect(r.screenshot.status).toBe('pass');
    expect(r.replay.status).toBe('pass');
    expect(r.ok).toBe(true);
  });

  it('fails the snapshot check after a one-byte change and skips replay', async () => {
    const { receipt, signature, publicKeys } = setup();
    const tampered = Buffer.from(html);
    tampered[3] ^= 1;
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html: tampered, screenshot: png, replay: goodReplay });
    expect(r.html.status).toBe('fail');
    expect(r.replay.status).toBe('skipped');
    expect(r.ok).toBe(false);
  });

  it('fails the screenshot check after a change', async () => {
    const { receipt, signature, publicKeys } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: Buffer.from('89504e470d0a1a0b0000', 'hex'), replay: goodReplay });
    expect(r.screenshot.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails the signature when the receipt was edited', async () => {
    const { receipt, signature, publicKeys } = setup();
    const edited = { ...receipt, finalUrl: 'https://evil.example/' };
    const r = await verifyReceipt({ signed: { receipt: edited, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails when the signing key is unknown', async () => {
    const { receipt, signature } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys: [], html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('fail');
    expect(r.signature.detail).toContain(signature.keyId);
  });

  it('still verifies receipts signed by a retired key', async () => {
    const { receipt, signature, key } = setup();
    const retired = { ...key.publicKey, retiredAt: '2026-10-25T00:00:00.000Z' };
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys: [retired], html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('pass');
  });

  it('skips the signature check for unsigned receipts without failing them', async () => {
    const { receipt, publicKeys } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature: null }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.signature.status).toBe('skipped');
    expect(r.ok).toBe(true);
  });

  it('fails replay when the converter output differs from the recorded output hash', async () => {
    const { receipt, signature, publicKeys } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: () => ({ markdown: 'something else' }) });
    expect(r.replay.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('skips replay when it is unavailable and skips checks for missing artifacts', async () => {
    const { receipt, signature, publicKeys } = setup({ screenshot: null });
    const r1 = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: null, replay: () => ({ unavailable: 'converter differs' }) });
    expect(r1.replay).toMatchObject({ status: 'skipped', detail: expect.stringContaining('converter differs') });
    expect(r1.screenshot.status).toBe('skipped');
    const r2 = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html: null, screenshot: null });
    expect(r2.html.status).toBe('skipped');
    expect(r2.replay.status).toBe('skipped');
    expect(r2.ok).toBe(true);
  });

  it('records the expected digest in details', async () => {
    const { receipt, signature, publicKeys } = setup();
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: goodReplay });
    expect(r.html.detail).toContain(sha256Hex(html).slice(0, 12));
  });
});

describe('verifyReceipt scan check', () => {
  const scan = { scanner: { name: 'icecrawl-injection-scan', version: '1' }, flagged: true, highest: 'high' as const, count: 2 };
  const replayWith = (s: unknown) => () => ({ markdown, scan: s as never });

  it('passes when replaying the scanner gives the recorded summary', async () => {
    const { receipt, signature, publicKeys } = setup({ scan });
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: replayWith(scan) });
    expect(r.scan.status).toBe('pass');
    expect(r.ok).toBe(true);
  });

  it('fails when the replayed summary differs (the scan result was altered)', async () => {
    const { receipt, signature, publicKeys } = setup({ scan });
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html, screenshot: png, replay: replayWith({ ...scan, count: 0, flagged: false, highest: null }) });
    expect(r.scan.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('skips for a different scanner version, an old receipt, a scan-off receipt, or no replay', async () => {
    const base = setup({ scan });
    const other = await verifyReceipt({ ...{ signed: { receipt: base.receipt, signature: base.signature }, publicKeys: base.publicKeys, html, screenshot: png }, replay: replayWith({ ...scan, scanner: { name: 'icecrawl-injection-scan', version: '2' } }) });
    expect(other.scan.status).toBe('skipped');

    const old = setup();
    const legacy = { ...old.receipt } as Record<string, unknown>;
    delete legacy.scan;
    const oldReport = await verifyReceipt({ signed: { receipt: legacy as never, signature: old.signature }, publicKeys: old.publicKeys, html, screenshot: png, replay: replayWith(scan) });
    expect(oldReport.scan.status).toBe('skipped');
    expect(oldReport.scan.detail).toContain('predates');

    const off = await verifyReceipt({ signed: { receipt: old.receipt, signature: old.signature }, publicKeys: old.publicKeys, html, screenshot: png, replay: replayWith(scan) });
    expect(off.scan.status).toBe('skipped');

    const noReplay = await verifyReceipt({ signed: { receipt: base.receipt, signature: base.signature }, publicKeys: base.publicKeys, html, screenshot: png });
    expect(noReplay.scan.status).toBe('skipped');
  });

  it('skips the scan check when the snapshot hash already failed', async () => {
    const { receipt, signature, publicKeys } = setup({ scan });
    const tampered = Buffer.from(html);
    tampered[3] ^= 1;
    const r = await verifyReceipt({ signed: { receipt, signature }, publicKeys, html: tampered, screenshot: png, replay: replayWith(scan) });
    expect(r.html.status).toBe('fail');
    expect(r.scan.status).toBe('skipped');
  });
});
