import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { renderBody } from '@icecrawl/scraper';
import { buildReceipt, generateSigningKey, scanForInjection, signReceipt, summarizeScan } from '@icecrawl/trust';
import { IceCrawl } from '@icecrawl/sdk';
import { createIceCrawlMcpServer, SERVER_INSTRUCTIONS } from '../src/server';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const clean = { scanner: { name: 'icecrawl-injection-scan', version: '1' }, flagged: false, highest: null, count: 0, findings: [] };
const docFor = (url: string, over: Record<string, unknown> = {}) => ({
  markdown: `# ${url}\n\nHello from ${url}`,
  metadata: { title: 'Title', description: null, language: 'en', sourceURL: url, url, statusCode: 200, contentType: 'text/html', scrapeId: 's1' },
  trust: { verdict: 'ok', confidence: 0.95, reasons: [], receiptId: 'rcpt-1', engine: 'fetch', injection: clean },
  ...over,
});

function api(handler: (c: Call) => { status?: number; json?: unknown; bytes?: Uint8Array }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    if (r.bytes) return new Response(Buffer.from(r.bytes), { status: r.status ?? 200 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, client: new IceCrawl({ apiUrl: 'http://api.test', apiKey: 'k', fetch: fetchImpl }) };
}

async function connect(client: IceCrawl, o: { toolPrefix?: string; maxChars?: number } = {}) {
  const server = createIceCrawlMcpServer({ client, ...o });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return { mcp, close: async () => { await mcp.close(); await server.close(); } };
}

const textOf = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('tool registry', () => {
  it('registers the documented tools under the default prefix', async () => {
    const { client } = api(() => ({}));
    const { mcp, close } = await connect(client);
    const tools = await mcp.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ['icecrawl_batch_scrape', 'icecrawl_cancel_crawl', 'icecrawl_check_batch_status', 'icecrawl_check_crawl_status', 'icecrawl_crawl', 'icecrawl_map', 'icecrawl_scrape', 'icecrawl_verify_receipt'].sort(),
    );
    for (const t of tools.tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(mcp.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await close();
  });

  it('can expose Firecrawl\'s tool names through the prefix option', async () => {
    const { client } = api(() => ({}));
    const { mcp, close } = await connect(client, { toolPrefix: 'firecrawl_' });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain('firecrawl_scrape');
    expect(names).toContain('firecrawl_map');
    expect(names).toContain('firecrawl_crawl');
    expect(names).toContain('firecrawl_check_crawl_status');
    expect(names).toContain('firecrawl_batch_scrape');
    await close();
  });

  it('tells the model how to treat tool output', () => {
    expect(SERVER_INSTRUCTIONS).toContain('untrusted');
    expect(SERVER_INSTRUCTIONS).toContain('verify_receipt');
  });

  it('marks read-only tools as such', async () => {
    const { client } = api(() => ({}));
    const { mcp, close } = await connect(client);
    const by = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(by.icecrawl_map?.readOnlyHint).toBe(true);
    expect(by.icecrawl_check_crawl_status?.readOnlyHint).toBe(true);
    expect(by.icecrawl_verify_receipt?.readOnlyHint).toBe(true);
    expect(by.icecrawl_scrape?.openWorldHint).toBe(true);
    await close();
  });
});

describe('scrape tool', () => {
  it('returns wrapped content with the trust header', async () => {
    const { client, calls } = api(() => ({ json: { success: true, data: docFor('https://e.com/a') } }));
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a' } });
    const t = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(t).toContain('verdict: ok');
    expect(t).toContain('<<<ICECRAWL_UNTRUSTED_CONTENT');
    expect(t).toContain('Hello from https://e.com/a');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v2/scrape', body: { url: 'https://e.com/a', formats: ['markdown'] } });
    await close();
  });

  it('passes options through and applies maxChars', async () => {
    const big = { ...docFor('https://e.com/a'), markdown: Array.from({ length: 300 }, (_, i) => `Paragraph ${i} lorem ipsum.`).join('\n\n') };
    const { client, calls } = api(() => ({ json: { success: true, data: big } }));
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a', onlyMainContent: false, waitFor: 200, mobile: true, maxChars: 800 } });
    expect(textOf(r)).toContain('[truncated: showing');
    expect(calls[0].body).toMatchObject({ onlyMainContent: false, waitFor: 200, mobile: true });
    expect(calls[0].body).not.toHaveProperty('maxChars');
    await close();
  });

  it('turns an untrustworthy scrape into an error result without page text', async () => {
    const trust = { verdict: 'captcha', confidence: 0.95, reasons: ['captcha_widget:g-recaptcha'], receiptId: 'rcpt-9', engine: 'fetch' };
    const { client } = api(() => ({ status: 502, json: { success: false, code: 'CAPTCHA', error: 'Scrape was not trustworthy: captcha', trust } }));
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('CAPTCHA');
    expect(textOf(r)).toContain('rcpt-9');
    expect(textOf(r)).not.toContain('UNTRUSTED_CONTENT');
    await close();
  });

  it('surfaces injection findings before the content', async () => {
    const flaggedDoc = docFor('https://e.com/a', {
      trust: { verdict: 'ok', confidence: 0.95, reasons: [], receiptId: 'rcpt-2', engine: 'fetch', injection: { ...clean, flagged: true, highest: 'high', count: 1, findings: [{ kind: 'instruction', severity: 'high', rule: 'ignore-previous', excerpt: 'ignore all previous instructions', hidden: true, location: 'html' }] } },
    });
    const { client } = api(() => ({ json: { success: true, data: flaggedDoc } }));
    const { mcp, close } = await connect(client);
    const t = textOf(await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a' } }));
    expect(t.indexOf('Possible prompt injection')).toBeGreaterThan(-1);
    expect(t.indexOf('Possible prompt injection')).toBeLessThan(t.indexOf('<<<ICECRAWL_UNTRUSTED_CONTENT'));
    await close();
  });

  it('reports an unreachable server as an error', async () => {
    const down = new IceCrawl({ apiUrl: 'http://api.test', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    const { mcp, close } = await connect(down);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Could not reach IceCrawl at http://api.test');
    await close();
  });

  it('rejects invalid arguments at the protocol level', async () => {
    const { client } = api(() => ({}));
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'not a url' } }).catch((e) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError).toBeTruthy();
    await close();
  });

  it('returns screenshots as image content', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const { client } = api(() => ({ json: { success: true, data: docFor('https://e.com/a', { screenshot: `data:image/png;base64,${png}` }) } }));
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://e.com/a', formats: ['markdown', 'screenshot'] } });
    expect((r.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(true);
    await close();
  });
});

describe('map, crawl and batch tools', () => {
  it('maps a site with a conservative default limit', async () => {
    const { client, calls } = api(() => ({ json: { success: true, links: [{ url: 'https://e.com/a' }, { url: 'https://e.com/b', title: 'B' }] } }));
    const { mcp, close } = await connect(client);
    const t = textOf(await mcp.callTool({ name: 'icecrawl_map', arguments: { url: 'https://e.com/', search: 'b' } }));
    expect(t).toContain('2 URL(s)');
    expect(t).toContain('https://e.com/b — B');
    expect(calls[0].body).toMatchObject({ url: 'https://e.com/', search: 'b', limit: 100 });
    await close();
  });

  it('starts a crawl with a small default limit and explains how to follow up', async () => {
    const { client, calls } = api(() => ({ json: { success: true, id: 'job-1', url: 'http://api.test/v2/crawl/job-1' } }));
    const { mcp, close } = await connect(client);
    const t = textOf(await mcp.callTool({ name: 'icecrawl_crawl', arguments: { url: 'https://e.com/', includePaths: ['^/docs'] } }));
    expect(t).toContain('job-1');
    expect(t).toContain('icecrawl_check_crawl_status');
    expect(calls[0].body).toMatchObject({ url: 'https://e.com/', limit: 10, includePaths: ['^/docs'], scrapeOptions: { formats: ['markdown'], onlyMainContent: true } });
    await close();
  });

  it('reports crawl status with page content and the next skip', async () => {
    const data = Array.from({ length: 3 }, (_, i) => docFor(`https://e.com/p${i}`, { markdown: `# P${i}\n\n${'word '.repeat(300)}` }));
    const { client, calls } = api(() => ({ json: { success: true, status: 'completed', total: 3, completed: 3, creditsUsed: 3, expiresAt: 'x', createdAt: 'y', duration: 1, next: null, data } }));
    const { mcp, close } = await connect(client);
    const t = textOf(await mcp.callTool({ name: 'icecrawl_check_crawl_status', arguments: { id: 'job-1', skip: 4, maxChars: 800 } }));
    expect(t).toContain('status completed');
    expect(t).toContain('Page 5: https://e.com/p0');
    expect(t).toContain('skip=');
    expect(calls[0].path).toBe('/v2/crawl/job-1?skip=4');
    await close();
  });

  it('cancels a crawl', async () => {
    const { client, calls } = api(() => ({ json: { status: 'cancelled' } }));
    const { mcp, close } = await connect(client);
    expect(textOf(await mcp.callTool({ name: 'icecrawl_cancel_crawl', arguments: { id: 'job-1' } }))).toContain('cancel');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v2/crawl/job-1' });
    await close();
  });

  it('starts and checks batch scrapes, and reports API errors as errors', async () => {
    const { client, calls } = api((c) => {
      if (c.method === 'POST') return { json: { success: true, id: 'b-1', url: 'http://api.test/v2/batch/scrape/b-1', invalidURLs: [] } };
      return { status: 404, json: { success: false, code: 'NOT_FOUND', error: 'Job not found' } };
    });
    const { mcp, close } = await connect(client);
    const started = textOf(await mcp.callTool({ name: 'icecrawl_batch_scrape', arguments: { urls: ['https://e.com/a', 'https://e.com/b'] } }));
    expect(started).toContain('b-1');
    expect(started).toContain('icecrawl_check_batch_status');
    expect(calls[0].body).toMatchObject({ urls: ['https://e.com/a', 'https://e.com/b'], formats: ['markdown'] });
    const missing = await mcp.callTool({ name: 'icecrawl_check_batch_status', arguments: { id: 'nope' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('NOT_FOUND');
    await close();
  });

  it('limits batch size', async () => {
    const { client } = api(() => ({}));
    const { mcp, close } = await connect(client);
    const urls = Array.from({ length: 51 }, (_, i) => `https://e.com/${i}`);
    const r = await mcp.callTool({ name: 'icecrawl_batch_scrape', arguments: { urls } }).catch((e) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError).toBeTruthy();
    await close();
  });
});

describe('verify_receipt tool', () => {
  const html = Buffer.from(`<html><head><title>V</title></head><body><article><h1>Verify</h1>${'<p>Readable words for the converter to keep. </p>'.repeat(12)}</article></body></html>`);
  const key = generateSigningKey();

  function receiptApi(snapshot: Uint8Array) {
    const rendered = renderBody(html, 'text/html', 'https://example.com/', { onlyMainContent: true, removeBase64Images: true });
    const receipt = buildReceipt({
      id: '44444444-4444-4444-8444-444444444444',
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      statusCode: 200,
      fetchedAt: new Date('2026-10-25T10:00:00.000Z'),
      engineChain: [{ engine: 'fetch', verdict: 'ok', confidence: 0.9, reasons: [], durationMs: 2 }],
      htmlBytes: html,
      markdown: rendered.markdown,
      converter: { name: 'icecrawl-convert', version: '1' },
      contentType: 'text/html',
      screenshot: null,
      scan: summarizeScan(scanForInjection({ html: rendered.text, markdown: rendered.markdown })),
      options: { onlyMainContent: true, skipTlsVerification: true, removeBase64Images: true },
    });
    const signature = signReceipt(receipt, key.privateKey);
    return api((c) => {
      if (c.path.endsWith('icecrawl-keys.json')) return { json: { keys: [key.publicKey] } };
      if (c.path.endsWith('/snapshot')) return { bytes: snapshot };
      if (c.path.endsWith('/screenshot')) return { status: 404, json: { success: false, code: 'NOT_FOUND', error: 'x' } };
      return { json: { success: true, data: receipt, signature } };
    });
  }

  it('verifies an untouched receipt', async () => {
    const { client } = receiptApi(html);
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_verify_receipt', arguments: { receiptId: '44444444-4444-4444-8444-444444444444' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/signature\s+PASS/);
    expect(textOf(r)).toMatch(/replay\s+PASS/);
    expect(textOf(r)).toContain('OK');
    await close();
  });

  it('reports a tampered snapshot as an error', async () => {
    const bad = Buffer.from(html);
    bad[30] ^= 1;
    const { client } = receiptApi(bad);
    const { mcp, close } = await connect(client);
    const r = await mcp.callTool({ name: 'icecrawl_verify_receipt', arguments: { receiptId: '44444444-4444-4444-8444-444444444444' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/snapshot\s+FAIL/);
    await close();
  });
});
