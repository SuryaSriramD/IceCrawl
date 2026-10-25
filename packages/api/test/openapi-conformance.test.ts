import { describe, expect, it } from 'vitest';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';
import { extractionDeps, fakeLlm } from './llm-helpers';
import { fakeSearch, webHit } from './search-helpers';
import { hasOpenApi, loadResponseValidator } from './support/openapi';

const E = 'https://example.com';
const site = {
  [`${E}/`]: { html: pageHtml('Home', ['/a']) },
  [`${E}/a`]: { html: pageHtml('A') },
  [`${E}/walled`]: { html: '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>' },
};
const files = { [`${E}/robots.txt`]: { status: 404, body: '' } };
const SENTENCE = 'Real readable sentence about a real topic';

describe.skipIf(!hasOpenApi())('responses conform to the Firecrawl v2 OpenAPI', () => {
  const v = loadResponseValidator();
  const setup = () => makeJobsApp({ site, files, search: fakeSearch({ web: [webHit(`${E}/a`)] }), extraction: extractionDeps(fakeLlm(JSON.stringify({ fact: SENTENCE }))) });
  type T = Awaited<ReturnType<typeof setup>>;
  const call = async (t: T, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
    const res = await t.app.inject({ method, url, headers: t.auth, payload: payload as never });
    return { status: res.statusCode, body: res.json() };
  };
  const check = (path: string, method: 'get' | 'post' | 'delete', r: { status: number; body: unknown }) => {
    const label = `${method.toUpperCase()} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
    // Firecrawl's own spec contradicts itself here (it requires `data`, defines `crawls`): check what it does define.
    if (path === '/crawl/active') {
      expect(r.body, label).toMatchObject({ success: true, crawls: expect.any(Array) });
      return;
    }
    // IceCrawl answers untrustworthy pages with 502 and other typed codes the spec does not list: those must still
    // have the generic error shape every Firecrawl client reads.
    if (r.status >= 400 && v.validate(path, method, r.status, r.body)[0]?.includes('documents no')) {
      expect(r.body, label).toMatchObject({ success: false, error: expect.any(String), code: expect.any(String) });
      return;
    }
    expect(v.validate(path, method, r.status, r.body), label).toEqual([]);
  };

  it('scrape: success and failure', async () => {
    const t = await setup();
    check('/scrape', 'post', await call(t, 'POST', '/v2/scrape', { url: `${E}/a`, formats: ['markdown', 'links', 'html'] }));
    check('/scrape', 'post', await call(t, 'POST', '/v2/scrape', { url: `${E}/walled` }));
    check('/scrape', 'post', await call(t, 'POST', '/v2/scrape', { url: 'nope' }));
  });

  it('map', async () => {
    const t = await setup();
    check('/map', 'post', await call(t, 'POST', '/v2/map', { url: `${E}/` }));
  });

  it('crawl', async () => {
    const t = await setup();
    const start = await call(t, 'POST', '/v2/crawl', { url: `${E}/`, limit: 5, sitemap: 'skip' });
    check('/crawl', 'post', start);
    const id = (start.body as { id: string }).id;
    check('/crawl/{id}', 'get', await call(t, 'GET', `/v2/crawl/${id}`));
    await drain(t.deps, t.queues);
    check('/crawl/{id}', 'get', await call(t, 'GET', `/v2/crawl/${id}`));
    check('/crawl/{id}/errors', 'get', await call(t, 'GET', `/v2/crawl/${id}/errors`));
    check('/crawl/active', 'get', await call(t, 'GET', '/v2/crawl/active'));
    const second = (await call(t, 'POST', '/v2/crawl', { url: `${E}/`, sitemap: 'skip' })).body as { id: string };
    check('/crawl/{id}', 'delete', await call(t, 'DELETE', `/v2/crawl/${second.id}`));
  });

  it('batch scrape', async () => {
    const t = await setup();
    const start = await call(t, 'POST', '/v2/batch/scrape', { urls: [`${E}/a`, 'nope'] });
    check('/batch/scrape', 'post', start);
    const id = (start.body as { id: string }).id;
    await drain(t.deps, t.queues);
    check('/batch/scrape/{id}', 'get', await call(t, 'GET', `/v2/batch/scrape/${id}`));
    check('/batch/scrape/{id}/errors', 'get', await call(t, 'GET', `/v2/batch/scrape/${id}/errors`));
  });

  it('team', async () => {
    const t = await setup();
    await call(t, 'POST', '/v2/scrape', { url: `${E}/a` });
    for (const p of ['credit-usage', 'token-usage', 'queue-status', 'activity']) check(`/team/${p}`, 'get', await call(t, 'GET', `/v2/team/${p}`));
    check('/team/credit-usage/historical', 'get', await call(t, 'GET', '/v2/team/credit-usage/historical'));
    check('/team/token-usage/historical', 'get', await call(t, 'GET', '/v2/team/token-usage/historical?byApiKey=true'));
  });

  it('search', async () => {
    const t = await setup();
    check('/search', 'post', await call(t, 'POST', '/v2/search', { query: 'q' }));
    check('/search', 'post', await call(t, 'POST', '/v2/search', { query: 'q', scrapeOptions: { formats: ['markdown'] } }));
  });

  it('parse', async () => {
    const t = await setup();
    const rows = 'Row of the uploaded table with enough words to count as content,12\n'.repeat(20);
    const send = async (name: string, content: string) => {
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'text/csv' }), name);
      const res = new Response(form);
      const r = await t.app.inject({ method: 'POST', url: '/v2/parse', headers: { ...t.auth, 'content-type': res.headers.get('content-type') ?? '' }, payload: Buffer.from(await res.arrayBuffer()) });
      return { status: r.statusCode, body: r.json() };
    };
    check('/parse', 'post', await send('table.csv', `name,qty\n${rows}`));
    check('/parse', 'post', await send('table.exe', 'MZ'));
    check('/parse/formats', 'get', await call(t, 'GET', '/v2/parse/formats'));
  });

  it('extract', async () => {
    const t = await setup();
    const start = await call(t, 'POST', '/v2/extract', { urls: [`${E}/a`], prompt: 'Find a fact' });
    check('/extract', 'post', start);
    const id = (start.body as { id: string }).id;
    check('/extract/{id}', 'get', await call(t, 'GET', `/v2/extract/${id}`));
    await drain(t.deps, t.queues);
    check('/extract/{id}', 'get', await call(t, 'GET', `/v2/extract/${id}`));
  });
});
