import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { drain, makeJobsApp, pageHtml } from './jobs-helpers';
import { extractionDeps, fakeLlm } from './llm-helpers';
import { fakeSearch, webHit } from './search-helpers';

const E = 'https://example.com';
const site = { [`${E}/a`]: { html: pageHtml('Page A') }, [`${E}/walled`]: { html: '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>' } };
const search = () => fakeSearch({ web: [webHit(`${E}/a`, 'Page A', 'About A')] });
const plan = (...turns: Array<Record<string, unknown>>) => fakeLlm(...turns.map((t) => JSON.stringify(t)));

type T = Awaited<ReturnType<typeof makeJobsApp>>;
const post = (t: T, body: Record<string, unknown>, headers: Record<string, string> = t.auth) => t.app.inject({ method: 'POST', url: '/v2/agent', headers, payload: body });
const get = (t: T, path: string, headers: Record<string, string> = t.auth) => t.app.inject({ method: 'GET', url: `/v2/agent${path}`, headers });

describe('/v2/agent', () => {
  it('runs search, scrape and finish, then serves the result, trace and snapshot', async () => {
    const llm = plan(
      { thought: 'search first', action: 'search', query: 'page a' },
      { thought: 'read it', action: 'scrape', url: `${E}/a` },
      { thought: 'done', action: 'finish', answer: { fact: 'Real readable sentence about a real topic' } },
    );
    const t = await makeJobsApp({ site, search: search(), extraction: extractionDeps(llm) });
    const started = (await post(t, { prompt: 'What does page A say?', schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] }, model: 'spark-2', maxCredits: 5 })).json();
    expect(started).toMatchObject({ success: true, id: expect.any(String) });
    expect(started.warning).toContain('model');
    expect((await get(t, `/${started.id}`)).json()).toMatchObject({ success: true, status: 'processing' });

    await drain(t.deps, t.queues);
    const done = (await get(t, `/${started.id}`)).json();
    expect(done).toMatchObject({ status: 'completed', data: { fact: 'Real readable sentence about a real topic' }, sources: [{ url: `${E}/a`, receiptId: expect.any(String) }] });

    const trace = (await get(t, `/${started.id}/trace`)).json();
    expect(trace.id).toBe(started.id);
    expect(trace.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['run.started', 'tool_call.started', 'tool_call.finished', 'run.finished']));
    expect(trace.events.at(-1)).toMatchObject({ type: 'run.finished', outcome: 'succeeded' });

    const job = await t.store.getJob(started.id);
    const [snapshotId] = Object.keys((job?.result as { snapshots: Record<string, string> }).snapshots);
    const snap = (await get(t, `/${started.id}/snapshots/${snapshotId}`)).json();
    expect(JSON.parse(snap.snapshot)).toEqual({ fact: 'Real readable sentence about a real topic' });
    expect((await get(t, `/${started.id}/snapshots/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).statusCode).toBe(404);

    const list = (await get(t, '')).json();
    expect(list.agents).toMatchObject([{ id: started.id, status: 'completed', options: { prompt: 'What does page A say?' } }]);
  });

  it('reports a failed run with the reason, and an unreadable page as a tool result', async () => {
    const llm = plan({ action: 'scrape', url: `${E}/walled` }, { action: 'finish', answer: 'unknown' });
    const t = await makeJobsApp({ site, extraction: extractionDeps(llm) });
    const id = (await post(t, { prompt: 'q', urls: [`${E}/walled`] })).json().id;
    await drain(t.deps, t.queues);
    expect((await get(t, `/${id}`)).json()).toMatchObject({ status: 'completed', data: { answer: 'unknown' }, sources: [] });
    expect(llm.requests[1].user).toContain('could not be read (CAPTCHA)');

    const lost = await makeJobsApp({ site, extraction: extractionDeps(plan({ action: 'search', query: 'x' })) });
    const lostId = (await post(lost, { prompt: 'q', effort: 'low' })).json().id;
    await drain(lost.deps, lost.queues);
    expect((await get(lost, `/${lostId}`)).json()).toMatchObject({ status: 'failed', code: 'EXTRACTION_FAILED' });
  });

  it('cancels a run', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(plan({ action: 'search', query: 'x' })) });
    const id = (await post(t, { prompt: 'q' })).json().id;
    expect((await t.app.inject({ method: 'DELETE', url: `/v2/agent/${id}`, headers: t.auth })).json()).toEqual({ success: true });
    await drain(t.deps, t.queues);
    expect((await get(t, `/${id}`)).json()).toMatchObject({ status: 'failed' });
  });

  it('validates input, needs a model, and keeps runs private to their key', async () => {
    const t = await makeJobsApp({ site, extraction: extractionDeps(plan({ action: 'finish', answer: 1 })) });
    expect((await post(t, {})).statusCode).toBe(400);
    expect((await post(t, { prompt: 'p', urls: ['http://127.0.0.1/admin'] })).json().code).toBe('SSRF_BLOCKED');
    expect((await post(t, { prompt: 'p', schema: { type: 'nonsense' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/v2/agent', payload: { prompt: 'p' } })).statusCode).toBe(401);

    const none = await makeJobsApp({ site });
    expect((await post(none, { prompt: 'p' })).json().code).toBe('LLM_NOT_CONFIGURED');

    const id = (await post(t, { prompt: 'p' })).json().id;
    await t.store.createApiKey({ id: '11111111-1111-4111-8111-111111111111', hash: sha256Hex('ic-other'), name: 'other' });
    expect((await get(t, `/${id}`, { authorization: 'Bearer ic-other' })).statusCode).toBe(404);
    expect((await get(t, '/not-a-uuid')).statusCode).toBe(404);
  });
});
