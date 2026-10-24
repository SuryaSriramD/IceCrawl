import type { Fetcher } from '@icecrawl/crawler';
import { fetchEngine } from '@icecrawl/engines';

/** Plain, SSRF-safe GET used for robots.txt and sitemaps. Redirects are followed by the fetch engine. */
export function makeFetcher(o: { allowPrivateNetworks: boolean; maxBytes?: number; timeoutMs?: number }): Fetcher {
  return async (url) => {
    const r = await fetchEngine.scrape({
      url,
      headers: {},
      timeoutMs: o.timeoutMs ?? 10_000,
      skipTlsVerification: true,
      allowPrivateNetworks: o.allowPrivateNetworks,
      maxBytes: o.maxBytes ?? 20 * 1024 * 1024,
      waitFor: 0,
      mobile: false,
      actions: [],
      screenshot: null,
    });
    return { status: r.statusCode, body: r.body };
  };
}
