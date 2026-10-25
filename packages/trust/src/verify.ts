import type { PublicKeyEntry, ScanSummary, SignedReceipt } from '@icecrawl/core';
import { sha256Hex } from './receipt';
import { verifySignature } from './sign';

export type CheckStatus = 'pass' | 'fail' | 'skipped';
export interface Check {
  status: CheckStatus;
  detail: string;
}
export type ReplayResult = { markdown: string; scan?: ScanSummary | null } | { unavailable: string };

export interface VerifyInput {
  signed: SignedReceipt;
  publicKeys: PublicKeyEntry[];
  html: Uint8Array | null;
  screenshot: Uint8Array | null;
  replay?: (html: Uint8Array) => ReplayResult | Promise<ReplayResult>;
}

export interface VerifyReport {
  signature: Check;
  html: Check;
  screenshot: Check;
  replay: Check;
  scan: Check;
  ok: boolean;
}

const check = (status: CheckStatus, detail: string): Check => ({ status, detail });
const short = (hex: string) => hex.slice(0, 12);

function hashCheck(label: string, expected: string | null | undefined, bytes: Uint8Array | null): Check {
  if (!expected) return check('skipped', `receipt records no ${label}`);
  if (!bytes) return check('skipped', `${label} not provided`);
  const actual = sha256Hex(bytes);
  return actual === expected
    ? check('pass', `sha256 ${short(actual)}… matches the receipt`)
    : check('fail', `sha256 ${short(actual)}… but the receipt says ${short(expected)}…`);
}

const sameScan = (a: ScanSummary, b: ScanSummary) =>
  a.flagged === b.flagged && a.highest === b.highest && a.count === b.count;

export async function verifyReceipt(i: VerifyInput): Promise<VerifyReport> {
  const { receipt, signature } = i.signed;

  let sig: Check;
  if (!signature) {
    sig = check('skipped', 'receipt is unsigned');
  } else {
    const key = i.publicKeys.find((k) => k.keyId === signature.keyId);
    if (!key) sig = check('fail', `unknown signing key ${signature.keyId}`);
    else if (verifySignature(receipt, signature, key.publicKey)) {
      sig = check('pass', `Ed25519 signature by ${signature.keyId}${key.retiredAt ? ' (retired key)' : ''} is valid`);
    } else {
      sig = check('fail', `signature by ${signature.keyId} does not match the receipt`);
    }
  }

  const html = hashCheck('snapshot hash', receipt.htmlSha256, i.html);
  const screenshot = hashCheck('screenshot hash', receipt.screenshotSha256, i.screenshot);

  const canReplay = Boolean(i.replay && i.html && html.status !== 'fail');
  const replayed = canReplay ? await i.replay!(i.html!) : null;

  let replay: Check;
  if (!i.replay) replay = check('skipped', 'replay not requested');
  else if (!i.html) replay = check('skipped', 'snapshot not provided');
  else if (html.status === 'fail') replay = check('skipped', 'snapshot does not match the receipt, so replaying it is meaningless');
  else if (!receipt.outputSha256) replay = check('skipped', 'receipt records no output hash');
  else if (replayed && 'unavailable' in replayed) replay = check('skipped', `replay unavailable: ${replayed.unavailable}`);
  else {
    const actual = sha256Hex((replayed as { markdown: string }).markdown);
    replay =
      actual === receipt.outputSha256
        ? check('pass', `re-running the converter reproduces output ${short(actual)}…`)
        : check('fail', `re-running the converter gives ${short(actual)}… but the receipt says ${short(receipt.outputSha256)}…`);
  }

  let scan: Check;
  if (receipt.scan === undefined) scan = check('skipped', 'receipt predates injection scanning');
  else if (receipt.scan === null) scan = check('skipped', 'injection scanning was off for this scrape');
  else if (!replayed) scan = check('skipped', 'no replay available');
  else if ('unavailable' in replayed || !replayed.scan) scan = check('skipped', 'replay did not produce a scan summary');
  else if (replayed.scan.scanner.name !== receipt.scan.scanner.name || replayed.scan.scanner.version !== receipt.scan.scanner.version) {
    scan = check('skipped', `receipt used scanner ${receipt.scan.scanner.name}@${receipt.scan.scanner.version}, this build has ${replayed.scan.scanner.name}@${replayed.scan.scanner.version}`);
  } else if (sameScan(replayed.scan, receipt.scan)) {
    scan = check('pass', `re-running the scanner gives the recorded result (${receipt.scan.count} finding(s), highest ${receipt.scan.highest ?? 'none'})`);
  } else {
    scan = check('fail', `re-running the scanner gives ${replayed.scan.count} finding(s), highest ${replayed.scan.highest ?? 'none'}, but the receipt says ${receipt.scan.count}, highest ${receipt.scan.highest ?? 'none'}`);
  }

  return {
    signature: sig,
    html,
    screenshot,
    replay,
    scan,
    ok: [sig, html, screenshot, replay, scan].every((c) => c.status !== 'fail'),
  };
}
