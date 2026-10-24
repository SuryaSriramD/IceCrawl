import { describe, expect, it } from 'vitest';
import { normalizeMapRequest } from '@icecrawl/core';
import { mapSite, rankBySearch } from '../src/jobs/map';
import { fakeFetcher, makeJobDeps, makeJobsApp, pageHtml } from './jobs-helpers';

const E = 'https://example.com';
const request = (over: Record<string, unknown> = {}) => normalizeMapRequest({ url: `${E}/`, ...over }).request;

const home = pageHtml('Example Home', [
  '/a',
  '/a?utm=1',
  '/b/',
  `${E}/logo.png`,
  'https://blog.example.com/post',
  'https://other.org/x',
  'mailto:me@example.com',
  '#top',
]);
const sitemap = `<urlset><url><loc>${E}/from-sitemap</loc></url><url><loc>${E}/a</loc></url><url><loc>https://other.org/y</loc></url></urlset>`;

const mk = (over: { site?: Record<string, { html: string; status?: number }>; files?: Parameters<typeof fakeFetcher>[0] } = {}) => {
  const { deps } = makeJobDeps({ site: over.site ?? { [`${E}/`]: { html: home } }, files: over.files ?? { [`${E}/robots.txt`]: { status: 404, body: '' }, [`${E}/sitemap.xml`]: { body: sitemap } } });
  return { engines: deps.engines, scraper: deps.scraper, fetcher: deps.fetcher };
};

describe('rankBySearch', () => {
  it('keeps matching URLs ordered by token matches, then original order', () => {
    const urls = ['https://e.com/pricing', 'https://e.com/docs/api-keys', 'https://e.com/docs/api', 'https://e.com/blog'];
    expect(rankBySearch(urls, 'docs api')).toEqual(['https://e.com/docs/api-keys', 'https://e.com/docs/api']);
    expect(rankBySearch(urls, 'PRICING')).toEqual(['https://e.com/pricing']);
    expect(rankBySearch(urls, 'nothing')).toEqual([]);
    expect(rankBySearch(urls, '   ')).toEqual(urls);
  });
});

describe('mapSite', () => {
  it('combines page links and sitemap URLs, same host and subdomains only, without assets or duplicates', async () => {
    const links = await mapSite(mk(), request());
    expect(links.map((l) => l.url)).toEqual([
      `${E}/`,
      `${E}/a`,
      `${E}/b`,
      'https://blog.example.com/post',
      `${E}/from-sitemap`,
    ]);
    expect(links[0]).toMatchObject({ url: `${E}/`, title: 'Example Home' });
  });

  it('excludes subdomains when includeSubdomains is false', async () => {
    const links = await mapSite(mk(), request({ includeSubdomains: false }));
    expect(links.map((l) => l.url)).not.toContain('https://blog.example.com/post');
  });

  it('keeps query variants apart when ignoreQueryParameters is false', async () => {
    const links = await mapSite(mk(), request({ ignoreQueryParameters: false }));
    expect(links.map((l) => l.url)).toContain(`${E}/a?utm=1`);
    expect(links.map((l) => l.url)).toContain(`${E}/a`);
  });

  it('supports sitemap=only and sitemap=skip', async () => {
    const only = await mapSite(mk(), request({ sitemap: 'only' }));
    expect(only.map((l) => l.url)).toEqual([`${E}/from-sitemap`, `${E}/a`]);
    const skip = await mapSite(mk(), request({ sitemap: 'skip' }));
    expect(skip.map((l) => l.url)).not.toContain(`${E}/from-sitemap`);
    expect(skip.map((l) => l.url)).toContain(`${E}/b`);
  });

  it('applies search and limit', async () => {
    const searched = await mapSite(mk(), request({ search: 'sitemap' }));
    expect(searched.map((l) => l.url)).toEqual([`${E}/from-sitemap`]);
    const limited = await mapSite(mk(), request({ limit: 2 }));
    expect(limited).toHaveLength(2);
  });

  it('still returns sitemap URLs when the start page cannot be scraped', async () => {
    const links = await mapSite(mk({ site: { [`${E}/`]: { status: 403, html: 'no' } } }), request());
    expect(links.map((l) => l.url)).toEqual([`${E}/from-sitemap`, `${E}/a`]);
  });

  it('fails when nothing could be discovered', async () => {
    await expect(mapSite(mk({ site: {}, files: {} }), request())).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_ERROR|BLOCKED|EMPTY_CONTENT/) });
  });

  it('is not stopped by a robots.txt that disallows everything (map only reads sitemaps from it)', async () => {
    const m = mk({ files: { [`${E}/robots.txt`]: { body: 'User-agent: *\nDisallow: /\nSitemap: https://example.com/custom.xml' }, 'https://example.com/custom.xml': { body: `<urlset><url><loc>${E}/custom-page</loc></url></urlset>` } } });
    const links = await mapSite(m, request({ sitemap: 'only' }));
    expect(links.map((l) => l.url)).toEqual([`${E}/custom-page`]);
  });
});

describe('POST /v2/map', () => {
  it('returns links in the v2 shape', async () => {
    const t = await makeJobsApp({ site: { [`${E}/`]: { html: home } }, files: { [`${E}/robots.txt`]: { status: 404, body: '' }, [`${E}/sitemap.xml`]: { body: sitemap } } });
    const res = await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: `${E}/`, limit: 3 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.links).toHaveLength(3);
    expect(body.links[0]).toMatchObject({ url: `${E}/`, title: 'Example Home' });
    for (const l of body.links) expect(typeof l.url).toBe('string');
  });

  it('validates input, requires authentication and refuses private targets', async () => {
    const t = await makeJobsApp();
    expect((await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: 'nope' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/v2/map', payload: { url: `${E}/` } })).statusCode).toBe(401);
    const priv = await t.app.inject({ method: 'POST', url: '/v2/map', headers: t.auth, payload: { url: 'http://127.0.0.1/' } });
    expect(priv.json()).toMatchObject({ code: 'SSRF_BLOCKED' });
  });
});
