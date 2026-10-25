import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReceipt, generateSigningKey, signReceipt } from '@icecrawl/trust';
import { runVerify, type VerifyIo } from '../src/verify-cmd';

const html = Buffer.from('<html><body><article>' + 'Plenty of honest words for the converter to keep. '.repeat(10) + '</article></body></html>');
const key = generateSigningKey();

async function makeReceipt() {
  const { renderBody, CONVERTER } = await import('@icecrawl/scraper');
  const rendered = renderBody(html, 'text/html', 'https://example.com/', { onlyMainContent: true, removeBase64Images: true });
  const receipt = buildReceipt({
    id: '22222222-2222-4222-8222-222222222222',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    fetchedAt: new Date('2026-10-24T10:00:00.000Z'),
    engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.9, reasons: [], durationMs: 3 }],
    htmlBytes: html,
    markdown: rendered.markdown,
    converter: { name: CONVERTER.name, version: CONVERTER.version },
    contentType: 'text/html',
    screenshot: null,
    options: { onlyMainContent: true, skipTlsVerification: true, removeBase64Images: true },
  });
  return { receipt, signature: signReceipt(receipt, key.privateKey) };
}

function io(over: Partial<VerifyIo> = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const base: VerifyIo = {
    fetch: (async () => new Response('not configured', { status: 500 })) as typeof fetch,
    readFile: async (p) => readFile(p),
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    env: {},
    ...over,
  };
  return { base, lines, errs };
}

function fakeServer(parts: { receipt: unknown; signature: unknown; snapshot: Buffer | null; keys: unknown }, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
    if (url.pathname.endsWith('/icecrawl-keys.json')) return Response.json(parts.keys);
    if (url.pathname.endsWith('/snapshot')) return parts.snapshot ? new Response(new Uint8Array(parts.snapshot)) : new Response('no', { status: 404 });
    if (url.pathname.endsWith('/screenshot')) return new Response('no', { status: 404 });
    if (url.pathname.includes('/receipts/')) return Response.json({ success: true, data: parts.receipt, signature: parts.signature });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
}

describe('icecrawl verify (online)', () => {
  it('passes for an untouched receipt and sends the API key', async () => {
    const { receipt, signature } = await makeReceipt();
    const seen: string[] = [];
    const { base, lines } = io({ fetch: fakeServer({ receipt, signature, snapshot: html, keys: { keys: [key.publicKey] } }, seen) });
    const code = await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://localhost:3002', '--key', 'ic-test'], base);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/signature\s+PASS/);
    expect(text).toMatch(/snapshot\s+PASS/);
    expect(text).toMatch(/replay\s+PASS/);
    expect(text).toMatch(/scan\s+SKIP/);
    expect(seen.some((s) => s.includes('/receipts/22222222') && s.endsWith('Bearer ic-test'))).toBe(true);
  });

  it('reads the API location and key from the environment', async () => {
    const { receipt, signature } = await makeReceipt();
    const { base } = io({
      fetch: fakeServer({ receipt, signature, snapshot: html, keys: { keys: [key.publicKey] } }),
      env: { ICECRAWL_API_URL: 'http://localhost:3002', ICECRAWL_API_KEY: 'ic-env' },
    });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222'], base)).toBe(0);
  });

  it('exits 1 and names the failing check when the snapshot was tampered with', async () => {
    const { receipt, signature } = await makeReceipt();
    const tampered = Buffer.from(html);
    tampered[10] ^= 1;
    const { base, lines } = io({ fetch: fakeServer({ receipt, signature, snapshot: tampered, keys: { keys: [key.publicKey] } }) });
    const code = await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], base);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/snapshot\s+FAIL/);
  });

  it('exits 1 when the receipt was edited after signing', async () => {
    const { receipt, signature } = await makeReceipt();
    const { base, lines } = io({
      fetch: fakeServer({ receipt: { ...receipt, finalUrl: 'https://evil.example/' }, signature, snapshot: html, keys: { keys: [key.publicKey] } }),
    });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], base)).toBe(1);
    expect(lines.join('\n')).toMatch(/signature\s+FAIL/);
  });

  it('exits 2 on usage errors and unreachable servers', async () => {
    const a = io();
    expect(await runVerify([], a.base)).toBe(2);
    expect(a.errs.join('\n')).toContain('Usage');
    const b = io({ fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch });
    expect(await runVerify(['22222222-2222-4222-8222-222222222222', '--api', 'http://x'], b.base)).toBe(2);
    expect(b.errs.join('\n')).toContain('404');
  });
});

describe('icecrawl verify (offline)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('verifies files saved from the API', async () => {
    const { receipt, signature } = await makeReceipt();
    const dir = await mkdtemp(join(tmpdir(), 'icecrawl-verify-'));
    dirs.push(dir);
    await writeFile(join(dir, 'receipt.json'), JSON.stringify({ success: true, data: receipt, signature }));
    await writeFile(join(dir, 'snapshot.html'), html);
    await writeFile(join(dir, 'keys.json'), JSON.stringify({ keys: [key.publicKey] }));
    const { base, lines } = io();
    const code = await runVerify(['--receipt', join(dir, 'receipt.json'), '--snapshot', join(dir, 'snapshot.html'), '--keys', join(dir, 'keys.json')], base);
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/replay\s+PASS/);
  });

  it('fails the signature when no keys file is given (an unverifiable signature is never accepted)', async () => {
    const { receipt, signature } = await makeReceipt();
    const dir = await mkdtemp(join(tmpdir(), 'icecrawl-verify-'));
    dirs.push(dir);
    await writeFile(join(dir, 'receipt.json'), JSON.stringify({ receipt, signature }));
    await writeFile(join(dir, 'snapshot.html'), html);
    const { base, lines } = io();
    const code = await runVerify(['--receipt', join(dir, 'receipt.json'), '--snapshot', join(dir, 'snapshot.html')], base);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/signature\s+FAIL.*unknown signing key/);
  });
});
