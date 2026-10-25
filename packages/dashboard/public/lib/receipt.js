// Checks a receipt in the browser with Web Crypto: the Ed25519 signature over the canonical receipt and the stored
// snapshot and screenshot hashes. Replaying the converter and the injection scanner needs the CLI (`icecrawl verify`).

/**
 * RFC 8785 (JCS) for the JSON subset receipts use. Mirrors packages/trust/src/sign.ts.
 * @param {unknown} value @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const obj = /** @type {Record<string, unknown>} */ (value);
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`unsupported type ${typeof value}`);
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const check = (status, detail) => ({ status, detail });

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hashCheck(label, expected, bytes) {
  if (!expected) return check('skipped', `the receipt records no ${label}`);
  if (!bytes) return check('skipped', `${label} not available`);
  const actual = await sha256Hex(bytes);
  return actual === expected ? check('pass', `sha256 ${actual.slice(0, 12)}… matches the receipt`) : check('fail', `sha256 ${actual.slice(0, 12)}… but the receipt says ${expected.slice(0, 12)}…`);
}

/**
 * @param {{receipt: object, signature: null | {keyId: string, sig: string}}} signed
 * @param {Array<{keyId: string, publicKey: string, retiredAt?: string | null}>} publicKeys
 * @param {Uint8Array | null} snapshot @param {Uint8Array | null} screenshot
 */
export async function verifyReceipt(signed, publicKeys, snapshot, screenshot) {
  const { receipt, signature } = signed;
  let sig;
  if (!signature) sig = check('skipped', 'the receipt is unsigned');
  else {
    const key = publicKeys.find((k) => k.keyId === signature.keyId);
    if (!key) sig = check('fail', `unknown signing key ${signature.keyId}`);
    else {
      try {
        const cryptoKey = await crypto.subtle.importKey('spki', unb64(key.publicKey), { name: 'Ed25519' }, false, ['verify']);
        const ok = await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, unb64(signature.sig), new TextEncoder().encode(canonicalJson(receipt)));
        sig = ok ? check('pass', `Ed25519 signature by ${signature.keyId}${key.retiredAt ? ' (retired key)' : ''} is valid`) : check('fail', `the signature by ${signature.keyId} does not match the receipt`);
      } catch {
        sig = check('skipped', 'this browser cannot verify Ed25519 signatures; use `icecrawl verify`');
      }
    }
  }
  const html = await hashCheck('snapshot hash', /** @type {any} */ (receipt).htmlSha256, snapshot);
  const shot = await hashCheck('screenshot hash', /** @type {any} */ (receipt).screenshotSha256, screenshot);
  return { signature: sig, snapshot: html, screenshot: shot, ok: [sig, html, shot].every((c) => c.status !== 'fail') };
}
