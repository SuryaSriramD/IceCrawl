import { isIP } from 'node:net';
import { isPrivateAddress } from './ssrf';

/** The proxy tiers an operator can supply. "basic" is no proxy: the server's own address. */
export const PROXY_TIERS = ['enhanced', 'stealth'] as const;
export type ProxyTier = (typeof PROXY_TIERS)[number];

/**
 * Parses a comma or whitespace separated list of http(s) proxy URLs (credentials go in the URL: http://user:pass@host:8080).
 * Errors name the setting and the entry number, never the entry, because it holds credentials.
 */
export function parseProxyList(raw: string | undefined, name: string, allowPrivate: boolean): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((item, i) => {
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        throw new Error(`${name} entry ${i + 1} is not a URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} entry ${i + 1}: only http: and https: proxies are supported`);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const local = host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isPrivateAddress(host));
      // requests through a pool proxy leave from the proxy's network: a proxy inside ours would reach private addresses
      if (local && !allowPrivate) throw new Error(`${name} entry ${i + 1} is a private address; set ICECRAWL_ALLOW_PRIVATE_NETWORKS=true to allow it`);
      return item;
    });
}

/** Round-robin pool of operator-supplied proxies per tier. A proxy that just failed is skipped for a while. */
export class ProxyPool {
  private readonly cursor = new Map<ProxyTier, number>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly tiers: Partial<Record<ProxyTier, string[]>>,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  has(tier: ProxyTier): boolean {
    return (this.tiers[tier]?.length ?? 0) > 0;
  }

  next(tier: ProxyTier): string | null {
    const list = this.tiers[tier] ?? [];
    if (list.length === 0) return null;
    const start = this.cursor.get(tier) ?? 0;
    for (let i = 0; i < list.length; i++) {
      const candidate = list[(start + i) % list.length];
      const failed = this.failedAt.get(candidate);
      if (failed === undefined || this.now() - failed >= this.cooldownMs) {
        this.cursor.set(tier, (start + i + 1) % list.length);
        return candidate;
      }
    }
    // every proxy failed recently: keep rotating rather than refuse to scrape
    this.cursor.set(tier, (start + 1) % list.length);
    return list[start % list.length];
  }

  report(proxy: string, ok: boolean): void {
    if (ok) this.failedAt.delete(proxy);
    else this.failedAt.set(proxy, this.now());
  }
}

/** A proxy as it may appear in logs and errors: scheme, host and port, no credentials. */
export function describeProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'proxy';
  }
}
