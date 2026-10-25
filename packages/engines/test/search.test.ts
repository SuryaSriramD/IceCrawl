import { describe, expect, it } from 'vitest';
import { createSearxngProvider, hostMatches, parseTbs, type SearchQuery } from '../src';

type Reply = { status?: number; json?: unknown; text?: string } | Error;

function fakeFetch(handler: (url: URL) => Reply) {
  const urls: URL[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, urls };
}

const query = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  query: 'icecrawl',
  limit: 10,
  sources: ['web'],
  categories: [],
  timeoutMs: 5000,
  ...over,
});
const hit = (n: number, host = 'example.com') => ({ url: `https://${host}/p${n}`, title: `Title ${n}`, content: `Snippet ${n}` });

describe('createSearxngProvider', () => {
  it('asks SearXNG for JSON and maps web results', async () => {
    const { fn, urls } = fakeFetch((u) => ({ json: { results: u.searchParams.get('pageno') === '1' ? [hit(1), hit(2)] : [] } }));
    const p = createSearxngProvider({ baseUrl: 'http://searx.test/', fetch: fn });
    const r = await p.search(query({ limit: 5 }));
    expect(r.web).toEqual([
      { url: 'https://example.com/p1', title: 'Title 1', description: 'Snippet 1' },
      { url: 'https://example.com/p2', title: 'Title 2', description: 'Snippet 2' },
    ]);
    expect(r.images).toEqual([]);
    expect(r.news).toEqual([]);
    expect(urls[0].origin + urls[0].pathname).toBe('http://searx.test/search');
    expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({ q: 'icecrawl', format: 'json', categories: 'general', pageno: '1' });
    expect(p.name).toBe('searxng');
  });

  it('pages until it has enough results, then stops', async () => {
    const pages: Record<string, unknown[]> = { '1': [hit(1), hit(2), hit(3)], '2': [hit(4), hit(5), hit(6)], '3': [hit(7)] };
    const { fn, urls } = fakeFetch((u) => ({ json: { results: pages[u.searchParams.get('pageno') ?? ''] ?? [] } }));
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query({ limit: 5 }));
    expect(r.web.map((h) => h.title)).toEqual(['Title 1', 'Title 2', 'Title 3', 'Title 4', 'Title 5']);
    expect(urls).toHaveLength(2);
  });

  it('stops at an empty page and at maxPages', async () => {
    const { fn, urls } = fakeFetch((u) => ({ json: { results: [hit(Number(u.searchParams.get('pageno')))] } }));
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn, maxPages: 3 }).search(query({ limit: 50 }));
    expect(r.web).toHaveLength(3);
    expect(urls).toHaveLength(3);
    const empty = fakeFetch(() => ({ json: { results: [] } }));
    expect((await createSearxngProvider({ baseUrl: 'http://s', fetch: empty.fn }).search(query())).web).toEqual([]);
    expect(empty.urls).toHaveLength(1);
  });

  it('drops duplicates and results without an http(s) URL', async () => {
    const { fn } = fakeFetch((u) => ({
      json: { results: u.searchParams.get('pageno') === '1' ? [hit(1), hit(1), { url: 'javascript:alert(1)', title: 'x' }, { url: 'ftp://a/b', title: 'y' }, { title: 'no url' }] : [] },
    }));
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query());
    expect(r.web.map((h) => h.url)).toEqual(['https://example.com/p1']);
  });

  it('filters by includeDomains and excludeDomains, subdomains included', async () => {
    const results = [hit(1, 'docs.a.com'), hit(2, 'a.com'), hit(3, 'b.com'), hit(4, 'nota.com')];
    const { fn } = fakeFetch((u) => ({ json: { results: u.searchParams.get('pageno') === '1' ? results : [] } }));
    const p = createSearxngProvider({ baseUrl: 'http://s', fetch: fn });
    expect((await p.search(query({ includeDomains: ['a.com'] }))).web.map((h) => h.url)).toEqual(['https://docs.a.com/p1', 'https://a.com/p2']);
    expect((await p.search(query({ excludeDomains: ['a.com'] }))).web.map((h) => h.url)).toEqual(['https://b.com/p3', 'https://nota.com/p4']);
  });

  it('passes time range and safe search, and reports filters it cannot honour', async () => {
    const { fn, urls } = fakeFetch(() => ({ json: { results: [] } }));
    const p = createSearxngProvider({ baseUrl: 'http://s', fetch: fn });
    const r = await p.search(query({ tbs: 'qdr:w', safe: true, country: 'DE', location: 'Berlin' }));
    expect(urls[0].searchParams.get('time_range')).toBe('week');
    expect(urls[0].searchParams.get('safesearch')).toBe('2');
    expect(r.warnings.join(' ')).toContain('country and location');
    const hour = await p.search(query({ tbs: 'qdr:h' }));
    expect(urls.at(-1)?.searchParams.get('time_range')).toBe('day');
    expect(hour.warnings.join(' ')).toContain('qdr:h');
    const custom = await p.search(query({ tbs: 'cdr:1,cd_min:01/01/2026,cd_max:02/01/2026' }));
    expect(custom.warnings.join(' ')).toContain('cdr:1');
  });

  it('maps categories to SearXNG categories and a filetype query', async () => {
    const { fn, urls } = fakeFetch(() => ({ json: { results: [] } }));
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query({ categories: ['developer', 'research', 'pdf'] }));
    expect(urls[0].searchParams.get('categories')).toBe('general,it,science');
    expect(urls[0].searchParams.get('q')).toBe('icecrawl filetype:pdf');
    expect(r.warnings.join(' ')).toContain('filetype:pdf');
  });

  it('searches images and news in parallel and maps them', async () => {
    const { fn } = fakeFetch((u) => {
      if (u.searchParams.get('pageno') !== '1') return { json: { results: [] } };
      const cat = u.searchParams.get('categories');
      if (cat === 'images') {
        return {
          json: {
            results: [
              { url: 'https://example.com/gallery', img_src: 'https://cdn.example.com/a.png', title: 'A', resolution: '1920 x 1080' },
              { url: 'https://example.com/gallery', img_src: 'https://cdn.example.com/b.png', title: 'B' },
              { url: 'https://example.com/none', title: 'no image' },
            ],
          },
        };
      }
      if (cat === 'news') return { json: { results: [{ url: 'https://news.example.com/1', title: 'N', content: 'Body', publishedDate: '2026-10-20T10:00:00' }] } };
      return { json: { results: [hit(1)] } };
    });
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query({ sources: ['web', 'images', 'news'] }));
    expect(r.web).toHaveLength(1);
    expect(r.images).toEqual([
      { title: 'A', imageUrl: 'https://cdn.example.com/a.png', url: 'https://example.com/gallery', imageWidth: 1920, imageHeight: 1080 },
      { title: 'B', imageUrl: 'https://cdn.example.com/b.png', url: 'https://example.com/gallery' },
    ]);
    expect(r.news).toEqual([{ title: 'N', snippet: 'Body', url: 'https://news.example.com/1', date: '2026-10-20T10:00:00' }]);
  });

  it('notes engines that did not answer when results fall short', async () => {
    const { fn } = fakeFetch((u) => ({
      json: { results: u.searchParams.get('pageno') === '1' ? [hit(1)] : [], unresponsive_engines: [['google', 'CAPTCHA'], ['bing', 'timeout']] },
    }));
    const r = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query());
    expect(r.warnings.join(' ')).toContain('google (CAPTCHA)');
    const full = await createSearxngProvider({ baseUrl: 'http://s', fetch: fn }).search(query({ limit: 1 }));
    expect(full.warnings).toEqual([]);
  });

  it('turns provider failures into typed errors', async () => {
    const run = (reply: Reply) => createSearxngProvider({ baseUrl: 'http://s', fetch: fakeFetch(() => reply).fn }).search(query());
    await expect(run({ status: 403, text: 'Forbidden' })).rejects.toMatchObject({ code: 'TARGET_ERROR', message: expect.stringContaining('json format') });
    await expect(run({ status: 500, text: 'boom' })).rejects.toMatchObject({ code: 'TARGET_ERROR', message: expect.stringContaining('HTTP 500') });
    await expect(run({ text: '<html>not json</html>' })).rejects.toMatchObject({ code: 'TARGET_ERROR', message: expect.stringContaining('JSON') });
    await expect(run(new TypeError('fetch failed'))).rejects.toMatchObject({ code: 'TARGET_ERROR', message: expect.stringContaining('Could not reach') });
    await expect(run(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('helpers', () => {
  it('hostMatches matches the domain and its subdomains only', () => {
    expect(hostMatches('https://a.com/x', ['a.com'])).toBe(true);
    expect(hostMatches('https://docs.a.com/x', ['a.com'])).toBe(true);
    expect(hostMatches('https://nota.com/x', ['a.com'])).toBe(false);
    expect(hostMatches('not a url', ['a.com'])).toBe(false);
  });

  it('parseTbs understands the predefined ranges', () => {
    expect(parseTbs(undefined)).toEqual({ warnings: [] });
    expect(parseTbs('qdr:d').timeRange).toBe('day');
    expect(parseTbs('qdr:m').timeRange).toBe('month');
    expect(parseTbs('qdr:y').timeRange).toBe('year');
    expect(parseTbs('sbd:1,qdr:w')).toMatchObject({ timeRange: 'week' });
    expect(parseTbs('sbd:1').warnings.join(' ')).toContain('sbd:1');
  });
});
