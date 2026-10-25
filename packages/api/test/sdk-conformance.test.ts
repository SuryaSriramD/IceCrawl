import type { AddressInfo } from 'node:net';
import Firecrawl from '@mendable/firecrawl-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';
import { extractionDeps, fakeLlm } from './llm-helpers';
import { fakeSearch, webHit } from './search-helpers';

const E = 'https://example.com';
const SENTENCE = 'Real readable sentence about a real topic';
const site = {
  [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) },
  [`${E}/a`]: { html: pageHtml('A') },
  [`${E}/b`]: { html: pageHtml('B') },
  [`${E}/walled`]: { html: '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>' },
};
const files = { [`${E}/robots.txt`]: { status: 404, body: '' } };

type T = Awaited<ReturnType<typeof makeJobsApp>>;

describe('the official @mendable/firecrawl-js SDK against IceCrawl', () => {
  let t: T;
  let app: Firecrawl;

  beforeAll(async () => {
    t = await makeJobsApp({
      site,
      files,
      search: fakeSearch({ web: [webHit(`${E}/a`, 'Page A', 'About A')] }),
      extraction: extractionDeps(fakeLlm(JSON.stringify({ fact: SENTENCE }))),
    });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    app = new Firecrawl({ apiKey: 'ic-jobs', apiUrl: `http://127.0.0.1:${port}` });
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** Lets the in-memory queue run while the SDK is polling. */
  const whileQueued = async <R>(pending: Promise<R>): Promise<R> => {
    for (let i = 0; i < 400 && t.queues.jobs.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await drain(t.deps, t.queues);
    return pending;
  };

  it('scrape returns a document with markdown and our trust block', async () => {
    const doc = await app.scrape(`${E}/a`, { formats: ['markdown', 'links'] });
    expect(doc.markdown).toContain('Real readable sentence');
    expect(doc.metadata?.sourceURL).toBe(`${E}/a`);
    expect((doc as unknown as { trust: { verdict: string } }).trust.verdict).toBe('ok');
  });

  it('scrape surfaces an untrustworthy page as an error', async () => {
    await expect(app.scrape(`${E}/walled`)).rejects.toThrow(/captcha/i);
  });

  it('map lists links', async () => {
    const r = await app.map(`${E}/`);
    expect(r.links.map((l) => l.url)).toContain(`${E}/a`);
  });

  it('crawl starts, polls and returns the pages', async () => {
    const result = await whileQueued(app.crawl(`${E}/`, { limit: 5, sitemap: 'skip', pollInterval: 1, timeout: 30 }));
    expect(result.status).toBe('completed');
    expect(result.data.map((d) => d.metadata?.sourceURL).sort()).toEqual([`${E}/`, `${E}/a`, `${E}/b`]);
  });

  it('batchScrape returns the pages', async () => {
    const result = await whileQueued(app.batchScrape([`${E}/a`, `${E}/b`], { options: { formats: ['markdown'] }, pollInterval: 1, timeout: 30 }));
    expect(result.status).toBe('completed');
    expect(result.data).toHaveLength(2);
  });

  it('search returns web results', async () => {
    const r = await app.search('anything', { limit: 3 });
    expect(r.web?.[0]).toMatchObject({ url: `${E}/a`, title: 'Page A' });
  });

  it('extract returns the extracted data', async () => {
    const r = await whileQueued(app.extract({ urls: [`${E}/a`], prompt: 'Find a fact', schema: { type: 'object', properties: { fact: { type: 'string' } } }, pollInterval: 1, timeout: 30 }));
    expect(r.status).toBe('completed');
    expect(r.data).toEqual({ fact: SENTENCE });
  });
});
