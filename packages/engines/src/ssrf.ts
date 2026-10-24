import dns from 'node:dns';
import { isIP } from 'node:net';
import { IceCrawlError } from '@icecrawl/core';

function isPrivateV4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (embedded) {
    const p = embedded[1].split('.').map(Number);
    s = `${s.slice(0, -embedded[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip.split('.').map(Number));
  if (family === 6) {
    const g = expandIPv6(ip);
    if (!g) return true;
    if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true; // :: and ::1
    if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
      return isPrivateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // v4-mapped
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
  }
  return true; // not an IP: fail closed
}

export function assertUrlAllowed(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IceCrawlError('VALIDATION', `Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IceCrawlError('VALIDATION', 'Only http and https URLs are supported');
  }
  if (url.username || url.password) {
    throw new IceCrawlError('VALIDATION', 'URLs with embedded credentials are not supported');
  }
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const blocked =
      host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isPrivateAddress(host));
    if (blocked) throw new IceCrawlError('SSRF_BLOCKED', `Blocked request to a private address: ${host}`);
  }
  return url;
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;

export function createSafeLookup(allowPrivate: boolean, resolver: typeof dns.lookup = dns.lookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    (resolver as (h: string, o: dns.LookupOptions, cb: (e: Error | null, a: dns.LookupAddress[]) => void) => void)(
      hostname,
      { ...options, all: true },
      (err, addresses) => {
        if (err) return callback(err);
        if (!allowPrivate) {
          const bad = addresses.find((a) => isPrivateAddress(a.address));
          if (bad) {
            return callback(new IceCrawlError('SSRF_BLOCKED', `Host ${hostname} resolves to a private address ${bad.address}`));
          }
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      },
    );
  };
}
