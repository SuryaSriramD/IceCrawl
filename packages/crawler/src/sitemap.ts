import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { Fetcher } from './robots';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const MAX_XML_BYTES = 50 * 1024 * 1024;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const locs = (nodes: unknown): string[] =>
  asArray(nodes as unknown)
    .map((n) => (typeof n === 'string' ? n : (n as { loc?: unknown } | null)?.loc))
    .filter((x): x is string => typeof x === 'string' && x.length > 0);

export function parseSitemapXml(xml: string): { urls: string[]; sitemaps: string[] } {
  let doc: { urlset?: { url?: unknown }; sitemapindex?: { sitemap?: unknown } } | undefined;
  try {
    doc = parser.parse(xml);
  } catch {
    return { urls: [], sitemaps: [] };
  }
  return { urls: locs(doc?.urlset?.url), sitemaps: locs(doc?.sitemapindex?.sitemap) };
}

export function defaultSitemapSeeds(startUrl: string, robotsSitemaps: string[]): string[] {
  const fallback = new URL('/sitemap.xml', startUrl).toString();
  return [...new Set([...robotsSitemaps, fallback])];
}

export interface SitemapOptions {
  maxSitemaps?: number;
  maxUrls?: number;
  maxDepth?: number;
}

function decode(url: string, body: Uint8Array): string | null {
  const buf = Buffer.from(body);
  try {
    const gz = url.toLowerCase().endsWith('.gz') || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
    return (gz ? gunzipSync(buf, { maxOutputLength: MAX_XML_BYTES }) : buf).toString('utf8');
  } catch {
    return null;
  }
}

export async function discoverSitemapUrls(seeds: string[], fetcher: Fetcher, o: SitemapOptions = {}): Promise<string[]> {
  const maxSitemaps = o.maxSitemaps ?? 50;
  const maxUrls = o.maxUrls ?? 50_000;
  const maxDepth = o.maxDepth ?? 3;
  const queue: Array<{ url: string; depth: number }> = seeds.map((url) => ({ url, depth: 0 }));
  const visited = new Set<string>();
  const found = new Set<string>();

  while (queue.length > 0 && visited.size < maxSitemaps && found.size < maxUrls) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let res: { status: number; body: Uint8Array };
    try {
      res = await fetcher(url);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const xml = decode(url, res.body);
    if (xml === null) continue;

    const { urls, sitemaps } = parseSitemapXml(xml);
    for (const u of urls) {
      if (found.size >= maxUrls) break;
      found.add(u);
    }
    if (depth < maxDepth) for (const s of sitemaps) queue.push({ url: s, depth: depth + 1 });
  }
  return [...found];
}
