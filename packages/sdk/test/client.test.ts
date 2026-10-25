import { describe, expect, it } from 'vitest';
import { IceCrawl, IceCrawlApiError } from '../src';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (c: Call) => { status?: number; json?: unknown; text?: string; bytes?: Uint8Array }) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    const status = r.status ?? 200;
    if (r.bytes) return new Response(Buffer.from(r.bytes), { status });
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const doc = (url: string) => ({
  markdown: `# ${url}`,
  metadata: { title: 't', description: null, language: 'en', sourceURL: url, url, statusCode: 200, contentType: 'text/html', scrapeId: 's' },
  trust: { verdict: 'ok', confidence: 0.9, reasons: [], receiptId: 'r1', engine: 'fetch' },
});

describe('IceCrawl client parse', () => {
  it('uploads the file and options as multipart and unwraps the document', async () => {
    let seen: { body: unknown; headers: Record<string, string> } | undefined;
    const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = { body: init?.body, headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify({ success: true, data: doc('upload://x/a.csv') }), { status: 200 });
    }) as typeof fetch;
    const ic = new IceCrawl({ apiUrl: 'http://api.test', apiKey: 'k', fetch: fn });
    const d = await ic.parse({ name: 'a.csv', data: new TextEncoder().encode('a,b\n1,2\n'), type: 'text/csv' }, { onlyMainContent: false });
    expect(d.trust.receiptId).toBe('r1');
    expect(seen?.headers['content-type']).toBeUndefined();
    const form = seen?.body as FormData;
    expect((form.get('file') as File).name).toBe('a.csv');
    expect(JSON.parse(String(form.get('options')))).toEqual({ onlyMainContent: false });
  });
});

describe('IceCrawl client', () => {
  it('sends the API key and request body and unwraps the scrape document', async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { success: true, data: doc('https://e.com/') } }));
    const ic = new IceCrawl({ apiUrl: 'http://api.test/', apiKey: 'ic-key', fetch: fn });
    const d = await ic.scrape('https://e.com/', { formats: ['markdown', 'links'], onlyMainContent: false });
    expect(d.markdown).toBe('# https://e.com/');
    expect(d.trust.receiptId).toBe('r1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v2/scrape',
      headers: { authorization: 'Bearer ic-key', 'content-type': 'application/json' },
      body: { url: 'https://e.com/', formats: ['markdown', 'links'], onlyMainContent: false },
    });
  });

  it('omits the authorization header without a key and defaults to localhost', async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { success: true, data: doc('https://e.com/') } }));
    const ic = new IceCrawl({ fetch: fn });
    await ic.scrape('https://e.com/');
    expect(calls[0].url).toBe('http://localhost:3002/v2/scrape');
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('throws IceCrawlApiError carrying the code, status and trust block of a failed scrape', async () => {
    const trust = { verdict: 'captcha', confidence: 0.95, reasons: ['captcha_widget:g-recaptcha'], receiptId: 'r9', engine: 'fetch' };
    const { fn } = fakeFetch(() => ({ status: 502, json: { success: false, code: 'CAPTCHA', error: 'Scrape was not trustworthy: captcha', trust } }));
    const err = await new IceCrawl({ fetch: fn }).scrape('https://e.com/').catch((e) => e);
    expect(err).toBeInstanceOf(IceCrawlApiError);
    expect(err).toMatchObject({ status: 502, code: 'CAPTCHA', message: 'Scrape was not trustworthy: captcha', trust });
  });

  it('handles non-JSON error bodies and network failures', async () => {
    const html = fakeFetch(() => ({ status: 500, text: '<html>boom</html>' }));
    const e1 = await new IceCrawl({ fetch: html.fn }).scrape('https://e.com/').catch((e) => e);
    expect(e1).toMatchObject({ status: 500, code: 'HTTP_500' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(new IceCrawl({ fetch: down }).scrape('https://e.com/')).rejects.toThrow('fetch failed');
  });

  it('maps a site', async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { success: true, links: [{ url: 'https://e.com/a', title: 'A' }, { url: 'https://e.com/b' }] } }));
    const links = await new IceCrawl({ fetch: fn }).map('https://e.com/', { limit: 2, search: 'a' });
    expect(links).toEqual([{ url: 'https://e.com/a', title: 'A' }, { url: 'https://e.com/b' }]);
    expect(calls[0]).toMatchObject({ url: 'http://localhost:3002/v2/map', body: { url: 'https://e.com/', limit: 2, search: 'a' } });
  });

  it('starts, polls, cancels and lists crawl errors', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === 'POST') return { json: { success: true, id: 'job1', url: 'http://api/v2/crawl/job1', warning: 'w' } };
      if (c.method === 'DELETE') return { json: { status: 'cancelled' } };
      if (c.url.endsWith('/errors')) return { json: { errors: [{ id: 'e', timestamp: 't', url: 'u', error: 'x' }], robotsBlocked: ['https://e.com/p'] } };
      return { json: { success: true, status: 'scraping', total: 1, completed: 0, creditsUsed: 0, expiresAt: 'x', createdAt: 'y', duration: 1, next: null, data: [] } };
    });
    const ic = new IceCrawl({ fetch: fn });
    expect(await ic.startCrawl('https://e.com/', { limit: 5, includePaths: ['^/docs'] })).toEqual({ success: true, id: 'job1', url: 'http://api/v2/crawl/job1', warning: 'w' });
    expect(calls[0].body).toEqual({ url: 'https://e.com/', limit: 5, includePaths: ['^/docs'] });
    expect((await ic.getCrawlStatus('job1', { skip: 3 })).status).toBe('scraping');
    expect(calls[1].url).toBe('http://localhost:3002/v2/crawl/job1?skip=3');
    await ic.cancelCrawl('job1');
    expect(calls[2]).toMatchObject({ method: 'DELETE', url: 'http://localhost:3002/v2/crawl/job1' });
    expect(await ic.getCrawlErrors('job1')).toMatchObject({ robotsBlocked: ['https://e.com/p'] });
  });

  it('crawl() waits for completion and gathers every page of results', async () => {
    let polls = 0;
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === 'POST') return { json: { success: true, id: 'job1', url: 'u' } };
      const skip = Number(new URL(c.url).searchParams.get('skip') ?? 0);
      polls++;
      const base = { success: true, total: 3, completed: 3, creditsUsed: 3, expiresAt: 'x', createdAt: 'y', duration: 1 };
      if (polls === 1) return { json: { ...base, status: 'scraping', completed: 1, next: null, data: [] } };
      if (skip === 0) return { json: { ...base, status: 'completed', next: 'http://api/v2/crawl/job1?skip=2', data: [doc('a'), doc('b')] } };
      return { json: { ...base, status: 'completed', next: null, data: [doc('c')] } };
    });
    const result = await new IceCrawl({ fetch: fn }).crawl('https://e.com/', { limit: 3 }, { pollIntervalMs: 5 });
    expect(result.status).toBe('completed');
    expect(result.data.map((d) => d.metadata.sourceURL)).toEqual(['a', 'b', 'c']);
    expect(result.next).toBeNull();
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'http://localhost:3002/v2/crawl/job1?skip=0',
      'http://localhost:3002/v2/crawl/job1?skip=0',
      'http://localhost:3002/v2/crawl/job1?skip=2',
    ]);
  });

  it('gives up waiting after the timeout', async () => {
    const { fn } = fakeFetch((c) => (c.method === 'POST' ? { json: { success: true, id: 'j', url: 'u' } } : { json: { success: true, status: 'scraping', total: 1, completed: 0, creditsUsed: 0, expiresAt: 'x', createdAt: 'y', duration: 1, next: null, data: [] } }));
    const err = await new IceCrawl({ fetch: fn }).crawl('https://e.com/', {}, { pollIntervalMs: 5, timeoutMs: 30 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'WAIT_TIMEOUT' });
  });

  it('runs batch scrapes', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === 'POST') return { json: { success: true, id: 'b1', url: 'u', invalidURLs: ['bad'] } };
      return { json: { success: true, status: 'completed', total: 1, completed: 1, creditsUsed: 1, expiresAt: 'x', createdAt: 'y', duration: 1, next: null, data: [doc('a')] } };
    });
    const ic = new IceCrawl({ fetch: fn });
    expect(await ic.startBatchScrape(['https://e.com/a', 'bad'], { formats: ['markdown'] })).toMatchObject({ id: 'b1', invalidURLs: ['bad'] });
    expect(calls[0].body).toEqual({ urls: ['https://e.com/a', 'bad'], formats: ['markdown'] });
    const all = await ic.batchScrape(['https://e.com/a'], {}, { pollIntervalMs: 5 });
    expect(all.data).toHaveLength(1);
    expect(calls.some((c) => c.url === 'http://localhost:3002/v2/batch/scrape/b1?skip=0')).toBe(true);
  });

  it('fetches receipts, snapshots, screenshots and public keys', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/snapshot')) return { bytes: new Uint8Array([1, 2, 3]) };
      if (c.url.endsWith('/screenshot')) return { status: 404, json: { success: false, code: 'NOT_FOUND', error: 'none' } };
      if (c.url.endsWith('icecrawl-keys.json')) return { json: { keys: [{ keyId: 'k_1', alg: 'Ed25519', publicKey: 'QQ==', createdAt: 't', retiredAt: null }] } };
      return { json: { success: true, data: { id: 'r1', version: 1 }, signature: { alg: 'Ed25519', keyId: 'k_1', sig: 'c2ln' } } };
    });
    const ic = new IceCrawl({ fetch: fn, apiKey: 'k' });
    expect(await ic.getReceipt('r1')).toMatchObject({ receipt: { id: 'r1' }, signature: { keyId: 'k_1' } });
    expect([...(await ic.getSnapshot('r1'))!]).toEqual([1, 2, 3]);
    expect(await ic.getScreenshot('r1')).toBeNull();
    expect((await ic.getPublicKeys())[0].keyId).toBe('k_1');
    expect(calls.at(-1)?.url).toBe('http://localhost:3002/.well-known/icecrawl-keys.json');
  });
});

describe('search and extract', () => {
  it('posts a search with the query and returns the whole response', async () => {
    const body = { success: true, id: 's1', creditsUsed: 1, data: { web: [{ title: 'T', description: 'D', url: 'https://e.com/' }] } };
    const { fn, calls } = fakeFetch(() => ({ json: body }));
    const ic = new IceCrawl({ apiUrl: 'http://api.test', fetch: fn });
    expect(await ic.search('ice crawl', { limit: 3, tbs: 'qdr:w' })).toEqual(body);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://api.test/v2/search', body: { query: 'ice crawl', limit: 3, tbs: 'qdr:w' } });
  });

  it('starts an extraction and polls until it completes', async () => {
    let polls = 0;
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === 'POST') return { json: { success: true, id: 'x1', invalidURLs: [] } };
      polls++;
      return {
        json:
          polls < 3
            ? { success: true, status: 'processing', expiresAt: 'later' }
            : { success: true, status: 'completed', expiresAt: 'later', data: { a: 1 }, tokensUsed: 5 },
      };
    });
    const ic = new IceCrawl({ apiUrl: 'http://api.test', fetch: fn });
    const r = await ic.extract(['https://e.com/a'], { prompt: 'p', schema: { type: 'object' } }, { pollIntervalMs: 1 });
    expect(r).toMatchObject({ status: 'completed', data: { a: 1 }, tokensUsed: 5 });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://api.test/v2/extract', body: { urls: ['https://e.com/a'], prompt: 'p', schema: { type: 'object' } } });
    expect(calls.at(-1)?.url).toBe('http://api.test/v2/extract/x1');
    expect(polls).toBe(3);
  });

  it('throws the job error when the extraction fails', async () => {
    const { fn } = fakeFetch((c) =>
      c.method === 'POST'
        ? { json: { success: true, id: 'x2' } }
        : { json: { success: true, status: 'failed', expiresAt: 'later', error: 'The model did not return data', code: 'EXTRACTION_FAILED' } },
    );
    const err = await new IceCrawl({ apiUrl: 'http://api.test', fetch: fn })
      .extract(['https://e.com/a'], { prompt: 'p' }, { pollIntervalMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IceCrawlApiError);
    expect(err).toMatchObject({ code: 'EXTRACTION_FAILED', message: 'The model did not return data' });
  });

  it('stops waiting after the timeout and names the job id', async () => {
    const { fn } = fakeFetch((c) =>
      c.method === 'POST' ? { json: { success: true, id: 'x3' } } : { json: { success: true, status: 'processing', expiresAt: 'later' } },
    );
    const err = await new IceCrawl({ apiUrl: 'http://api.test', fetch: fn })
      .extract(['https://e.com/a'], { prompt: 'p' }, { pollIntervalMs: 1, timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'WAIT_TIMEOUT' });
    expect((err as Error).message).toContain('x3');
  });

  it('getExtractStatus returns failed jobs as data', async () => {
    const { fn } = fakeFetch(() => ({ json: { success: true, status: 'failed', expiresAt: 'later', error: 'x', code: 'LLM_ERROR' } }));
    expect(await new IceCrawl({ apiUrl: 'http://api.test', fetch: fn }).getExtractStatus('x4')).toMatchObject({ status: 'failed', code: 'LLM_ERROR' });
  });
});
