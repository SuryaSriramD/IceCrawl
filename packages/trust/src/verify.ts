import type { PublicKeyEntry, SignedReceipt } from '@icecrawl/core';
import { sha256Hex } from './receipt';
import { verifySignature } from './sign';

export type CheckStatus = 'pass' | 'fail' | 'skipped';
export interface Check {
  status: CheckStatus;
  detail: string;
}
export type ReplayResult = { markdown: string } | { unavailable: string };

export interface VerifyInput {
  signed: SignedReceipt;
  publicKeys: PublicKeyEntry[];
  html: Uint8Array | null;
  screenshot: Uint8Array | null;
  replay?: (html: Uint8Array) => ReplayResult;
}

export interface VerifyReport {
  signature: Check;
  html: Check;
  screenshot: Check;
  replay: Check;
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

export function verifyReceipt(i: VerifyInput): VerifyReport {
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

  let replay: Check;
  if (!i.replay) replay = check('skipped', 'replay not requested');
  else if (!i.html) replay = check('skipped', 'snapshot not provided');
  else if (html.status === 'fail') replay = check('skipped', 'snapshot does not match the receipt, so replaying it is meaningless');
  else if (!receipt.outputSha256) replay = check('skipped', 'receipt records no output hash');
  else {
    const r = i.replay(i.html);
    if ('unavailable' in r) replay = check('skipped', `replay unavailable: ${r.unavailable}`);
    else {
      const actual = sha256Hex(r.markdown);
      replay =
        actual === receipt.outputSha256
          ? check('pass', `re-running the converter reproduces output ${short(actual)}…`)
          : check('fail', `re-running the converter gives ${short(actual)}… but the receipt says ${short(receipt.outputSha256)}…`);
    }
  }

  return { signature: sig, html, screenshot, replay, ok: [sig, html, screenshot, replay].every((c) => c.status !== 'fail') };
}
