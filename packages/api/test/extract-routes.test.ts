import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IceCrawlError } from '@icecrawl/core';
import { sha256Hex } from '@icecrawl/trust';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';
import { extractionDeps, fakeLlm } from './llm-helpers';

const E = 'https://example.com';
const SENTENCE = 'Real readable sentence about a real topic';
const site = { [`${E}/a`]: { html: pageHtml('A') } };
const answer = JSON.stringify({ fact: SENTENCE });

type T = Awaited<ReturnType<typeof makeJobsApp>>;
const post = (t: T, body: Record<string, unknown>, headers: Record<string, string> = t.auth) =>
  t.app.inject({ method: 'POST', url: '/v2/extract', headers, payload: body });
const get = (t: T, id: string, headers: Record<string, string> = t.auth) => t.app.inject({ method: 'GET', url: `/v2/extract/${id}`, headers });

describe('POST /v2/extract', () => {
  it('answers 501 LLM_NOT_CONFIGURED without a model', async () => {
    const t = await makeJobsApp({ site });
    const res = await post(t, { urls: [`${E}/a`], prompt: 'p' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ success: false, code: 'LLM_NOT_CONFIGURED' });
  });

  it('validates the request, the schema and the URLs, and needs the API key', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(fakeLlm(answer)) });
    expect((await post(t, { urls: [`${E}/a`] })).statusCode).toBe(400);
    expect((await post(t, { urls: [], prompt: 'p' })).statusCode).toBe(400);
    const badSchema = await post(t, { urls: [`${E}/a`], schema: { type: 'nonsense' } });
    expect(badSchema.statusCode).toBe(400);
    expect(badSchema.json().code).toBe('VALIDATION');
    const priv = await post(t, { urls: ['http://127.0.0.1/admin'], prompt: 'p' });
    expect(priv.statusCode).toBe(400);
    expect(priv.json().code).toBe('SSRF_BLOCKED');
    const anon = await t.app.inject({ method: 'POST', url: '/v2/extract', payload: { urls: [`${E}/a`], prompt: 'p' } });
    expect(anon.statusCode).toBe(401);
  });

  it('starts a job and reports processing, then the completed result', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(fakeLlm(answer)) });
    const start = await post(t, { urls: [`${E}/a`, 'nope'], prompt: 'Find a fact', scrapeOptions: { formats: ['html'] }, agent: true });
    expect(start.statusCode).toBe(200);
    const { id, invalidURLs, warning } = start.json();
    expect(start.json().success).toBe(true);
    expect(invalidURLs).toEqual(['nope']);
    expect(warning).toContain('markdown');
    expect(warning).toContain('agent');

    const waiting = await get(t, id);
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toMatchObject({ success: true, status: 'processing' });
    expect(waiting.json().data).toBeUndefined();

    await drain(t.deps, t.queues);
    const done = (await get(t, id)).json();
    expect(done).toMatchObject({ success: true, status: 'completed', tokensUsed: 110, data: { fact: SENTENCE } });
    expect(typeof done.expiresAt).toBe('string');
    expect(done.trust.extraction.grounding.grounded).toBe(1);
    expect(done.trust.sources).toEqual([{ url: `${E}/a`, receiptId: expect.any(String), verdict: 'ok', injectionFlagged: false }]);
    const receipt = await t.app.inject({ method: 'GET', url: `/v2/receipts/${done.trust.sources[0].receiptId}`, headers: t.auth });
    expect(receipt.statusCode).toBe(200);
  });

  it('returns invalidURLs as an empty array when every URL was valid', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(fakeLlm(answer)) });
    expect((await post(t, { urls: [`${E}/a`], prompt: 'p' })).json().invalidURLs).toEqual([]);
    expect((await post(t, { urls: [`${E}/a`], prompt: 'p', ignoreInvalidURLs: false })).json().invalidURLs).toBeUndefined();
  });

  it('reports a failed job with its error and code', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(fakeLlm(new IceCrawlError('LLM_ERROR', 'The language model answered HTTP 500'))) });
    const { id } = (await post(t, { urls: [`${E}/a`], prompt: 'p' })).json();
    await drain(t.deps, t.queues);
    expect((await get(t, id)).json()).toMatchObject({ success: true, status: 'failed', code: 'LLM_ERROR', error: 'The language model answered HTTP 500' });
  });

  it('keeps jobs private to their key and to their type', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(fakeLlm(answer)) });
    const { id } = (await post(t, { urls: [`${E}/a`], prompt: 'p' })).json();
    await t.store.createApiKey({ id: randomUUID(), hash: sha256Hex('ic-other'), name: 'other' });
    expect((await get(t, id, { authorization: 'Bearer ic-other' })).statusCode).toBe(404);
    expect((await get(t, randomUUID())).statusCode).toBe(404);
    expect((await get(t, 'not-a-uuid')).statusCode).toBe(404);
    const crawl = await t.app.inject({ method: 'POST', url: '/v2/crawl', headers: t.auth, payload: { url: `${E}/` } });
    expect((await get(t, crawl.json().id)).statusCode).toBe(404);
    const asCrawl = await t.app.inject({ method: 'GET', url: `/v2/crawl/${id}`, headers: t.auth });
    expect(asCrawl.statusCode).toBe(404);
  });
});
