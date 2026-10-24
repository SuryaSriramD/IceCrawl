import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { replayMarkdown } from '@icecrawl/scraper';
import { verifyReceipt, type Check } from '@icecrawl/trust';

export interface VerifyIo {
  fetch: typeof fetch;
  readFile(path: string): Promise<Uint8Array>;
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const USAGE = [
  'Usage:',
  '  icecrawl verify <receiptId> [--api URL] [--key KEY]',
  '  icecrawl verify --receipt FILE --snapshot FILE [--screenshot FILE] [--keys FILE]',
  'Online mode reads ICECRAWL_API_URL and ICECRAWL_API_KEY when the flags are omitted.',
].join('\n');

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } | null {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return null;
      flags[a.slice(2)] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function line(label: string, c: Check): string {
  const tag = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP';
  return `${label.padEnd(10)} ${tag}  ${c.detail}`;
}

function toSigned(json: unknown): SignedReceipt {
  const o = json as { receipt?: Receipt; data?: Receipt; signature?: ReceiptSignature | null };
  const receipt = o.receipt ?? o.data;
  if (!receipt || typeof receipt !== 'object') throw new Error('file does not contain a receipt');
  return { receipt, signature: o.signature ?? null };
}

export async function runVerify(args: string[], io: VerifyIo): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    io.err(USAGE);
    return 2;
  }
  const { positional, flags } = parsed;

  let signed: SignedReceipt;
  let publicKeys: PublicKeyEntry[] = [];
  let html: Uint8Array | null = null;
  let screenshot: Uint8Array | null = null;

  try {
    if (flags.receipt) {
      signed = toSigned(JSON.parse(Buffer.from(await io.readFile(flags.receipt)).toString('utf8')));
      if (flags.snapshot) html = await io.readFile(flags.snapshot);
      if (flags.screenshot) screenshot = await io.readFile(flags.screenshot);
      if (flags.keys) {
        const k = JSON.parse(Buffer.from(await io.readFile(flags.keys)).toString('utf8')) as { keys?: PublicKeyEntry[] };
        publicKeys = k.keys ?? [];
      }
    } else if (positional.length === 1) {
      const api = (flags.api ?? io.env.ICECRAWL_API_URL ?? '').replace(/\/+$/, '');
      const key = flags.key ?? io.env.ICECRAWL_API_KEY;
      if (!api) {
        io.err('No API URL: pass --api or set ICECRAWL_API_URL.');
        return 2;
      }
      const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
      const get = async (path: string, optional = false): Promise<Response | null> => {
        const res = await io.fetch(`${api}${path}`, { headers });
        if (res.status === 404 && optional) return null;
        if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
        return res;
      };
      const id = positional[0];
      signed = toSigned(await (await get(`/v2/receipts/${id}`))!.json());
      publicKeys = ((await (await get('/.well-known/icecrawl-keys.json'))!.json()) as { keys: PublicKeyEntry[] }).keys;
      const snap = await get(`/v2/receipts/${id}/snapshot`, true);
      if (snap) html = new Uint8Array(await snap.arrayBuffer());
      const shot = await get(`/v2/receipts/${id}/screenshot`, true);
      if (shot) screenshot = new Uint8Array(await shot.arrayBuffer());
    } else {
      io.err(USAGE);
      return 2;
    }
  } catch (err) {
    io.err(`Could not load the verification inputs: ${(err as Error).message}`);
    return 2;
  }

  const report = verifyReceipt({
    signed,
    publicKeys,
    html,
    screenshot,
    replay: (bytes) => replayMarkdown(signed.receipt, bytes),
  });
  io.out(`receipt ${signed.receipt.id}`);
  io.out(line('signature', report.signature));
  io.out(line('snapshot', report.html));
  io.out(line('screenshot', report.screenshot));
  io.out(line('replay', report.replay));
  io.out(line('scan', report.scan));
  io.out(report.ok ? 'OK: no check failed.' : 'FAILED: at least one check failed.');
  return report.ok ? 0 : 1;
}
