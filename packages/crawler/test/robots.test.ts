import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, DISALLOW_ALL, loadRobots, parseRobots, type Fetcher } from '../src';

const text = `User-agent: *
Disallow: /private/
Crawl-delay: 2

User-agent: IceCrawl
Disallow: /icecrawl-only/
Allow: /private/public-ok

Sitemap: https://example.com/sitemap.xml
`;

describe('parseRobots', () => {
  it('applies the rules of the matching user agent and exposes crawl delay and sitemaps', () => {
    const generic = parseRobots(text, 'https://example.com/robots.txt', 'SomeBot');
    expect(generic.allowed('https://example.com/private/x')).toBe(false);
    expect(generic.allowed('https://example.com/public')).toBe(true);
    expect(generic.crawlDelaySeconds).toBe(2);
    expect(generic.sitemaps).toEqual(['https://example.com/sitemap.xml']);

    const ours = parseRobots(text, 'https://example.com/robots.txt', 'IceCrawl');
    expect(ours.allowed('https://example.com/icecrawl-only/x')).toBe(false);
    expect(ours.allowed('https://example.com/private/x')).toBe(true);
  });

  it('allows everything for an empty file', () => {
    expect(parseRobots('', 'https://example.com/robots.txt', 'IceCrawl').allowed('https://example.com/a')).toBe(true);
  });
});

const fetcherOf = (res: { status: number; text?: string } | Error): Fetcher => async () => {
  if (res instanceof Error) throw res;
  return { status: res.status, body: Buffer.from(res.text ?? '') };
};

describe('loadRobots (RFC 9309 status handling)', () => {
  it('parses a 200 response', async () => {
    const r = await loadRobots('https://example.com', fetcherOf({ status: 200, text: 'User-agent: *\nDisallow: /x' }), 'IceCrawl');
    expect(r.allowed('https://example.com/x')).toBe(false);
    expect(r.allowed('https://example.com/y')).toBe(true);
  });

  it('allows everything on 404 and other 4xx', async () => {
    for (const status of [404, 403, 410]) {
      const r = await loadRobots('https://example.com', fetcherOf({ status }), 'IceCrawl');
      expect(r.allowed('https://example.com/x')).toBe(true);
    }
  });

  it('disallows everything when the server errors or is unreachable', async () => {
    for (const res of [{ status: 500 }, { status: 503 }, new Error('ECONNRESET')]) {
      const r = await loadRobots('https://example.com', fetcherOf(res), 'IceCrawl');
      expect(r.allowed('https://example.com/x')).toBe(false);
    }
  });

  it('asks for /robots.txt on the origin', async () => {
    const seen: string[] = [];
    await loadRobots('https://example.com:8443', async (u) => (seen.push(u), { status: 404, body: new Uint8Array() }), 'IceCrawl');
    expect(seen).toEqual(['https://example.com:8443/robots.txt']);
  });

  it('exports the constant rule sets', () => {
    expect(ALLOW_ALL.allowed('https://x.example/')).toBe(true);
    expect(DISALLOW_ALL.allowed('https://x.example/')).toBe(false);
  });
});
