import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultSitemapSeeds, discoverSitemapUrls, parseSitemapXml, type Fetcher } from '../src';

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-01-01</lastmod></url>`).join('')}</urlset>`;
const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('parseSitemapXml', () => {
  it('reads urlsets, including a single entry', () => {
    expect(parseSitemapXml(urlset('https://e.com/a', 'https://e.com/b')).urls).toEqual(['https://e.com/a', 'https://e.com/b']);
    expect(parseSitemapXml(urlset('https://e.com/a')).urls).toEqual(['https://e.com/a']);
  });

  it('reads sitemap indexes', () => {
    expect(parseSitemapXml(index('https://e.com/s1.xml', 'https://e.com/s2.xml')).sitemaps).toEqual(['https://e.com/s1.xml', 'https://e.com/s2.xml']);
  });

  it('returns nothing for garbage or an unrelated document', () => {
    expect(parseSitemapXml('<html><body>nope</body></html>')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemapXml('not xml at all')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemapXml('')).toEqual({ urls: [], sitemaps: [] });
  });
});

describe('defaultSitemapSeeds', () => {
  it('lists robots sitemaps first, then /sitemap.xml, without duplicates', () => {
    expect(defaultSitemapSeeds('https://e.com/some/page', ['https://e.com/custom.xml', 'https://e.com/sitemap.xml'])).toEqual([
      'https://e.com/custom.xml',
      'https://e.com/sitemap.xml',
    ]);
    expect(defaultSitemapSeeds('https://e.com/x', [])).toEqual(['https://e.com/sitemap.xml']);
  });
});

function site(files: Record<string, string | Buffer | { status: number }>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const f = files[url];
    if (f === undefined) return { status: 404, body: new Uint8Array() };
    if (typeof f === 'object' && !Buffer.isBuffer(f)) return { status: f.status, body: new Uint8Array() };
    return { status: 200, body: Buffer.from(f as string | Buffer) };
  };
}

describe('discoverSitemapUrls', () => {
  it('follows sitemap indexes and keeps document order without duplicates', async () => {
    const f = site({
      'https://e.com/sitemap.xml': index('https://e.com/s1.xml', 'https://e.com/s2.xml'),
      'https://e.com/s1.xml': urlset('https://e.com/a', 'https://e.com/b'),
      'https://e.com/s2.xml': urlset('https://e.com/b', 'https://e.com/c'),
    });
    expect(await discoverSitemapUrls(['https://e.com/sitemap.xml'], f)).toEqual(['https://e.com/a', 'https://e.com/b', 'https://e.com/c']);
  });

  it('decompresses gzipped sitemaps', async () => {
    const f = site({ 'https://e.com/sitemap.xml.gz': gzipSync(urlset('https://e.com/zipped')) });
    expect(await discoverSitemapUrls(['https://e.com/sitemap.xml.gz'], f)).toEqual(['https://e.com/zipped']);
  });

  it('ignores missing, failing and malformed sitemaps', async () => {
    const f: Fetcher = async (url) => {
      if (url.endsWith('boom.xml')) throw new Error('network down');
      if (url.endsWith('bad.xml')) return { status: 200, body: Buffer.from('<html/>') };
      if (url.endsWith('ok.xml')) return { status: 200, body: Buffer.from(urlset('https://e.com/fine')) };
      return { status: 500, body: new Uint8Array() };
    };
    expect(await discoverSitemapUrls(['https://e.com/boom.xml', 'https://e.com/bad.xml', 'https://e.com/err.xml', 'https://e.com/ok.xml'], f)).toEqual([
      'https://e.com/fine',
    ]);
  });

  it('does not loop on cyclic indexes and respects the sitemap-count and depth limits', async () => {
    const calls: string[] = [];
    const cyc = site({ 'https://e.com/a.xml': index('https://e.com/b.xml'), 'https://e.com/b.xml': index('https://e.com/a.xml') }, calls);
    expect(await discoverSitemapUrls(['https://e.com/a.xml'], cyc)).toEqual([]);
    expect(calls).toEqual(['https://e.com/a.xml', 'https://e.com/b.xml']);

    const deepCalls: string[] = [];
    const chain = site(
      {
        'https://e.com/0.xml': index('https://e.com/1.xml'),
        'https://e.com/1.xml': index('https://e.com/2.xml'),
        'https://e.com/2.xml': index('https://e.com/3.xml'),
        'https://e.com/3.xml': urlset('https://e.com/deep'),
      },
      deepCalls,
    );
    expect(await discoverSitemapUrls(['https://e.com/0.xml'], chain, { maxDepth: 1 })).toEqual([]);
    expect(deepCalls).toEqual(['https://e.com/0.xml', 'https://e.com/1.xml']);
  });

  it('caps the number of URLs', async () => {
    const f = site({ 'https://e.com/s.xml': urlset(...Array.from({ length: 20 }, (_, i) => `https://e.com/p${i}`)) });
    expect(await discoverSitemapUrls(['https://e.com/s.xml'], f, { maxUrls: 5 })).toHaveLength(5);
  });
});
