import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest } from '@icecrawl/extract';
import { runAgent, type AgentDeps, type AgentTools } from '../src';

/** A model that plays back scripted replies and records what it was asked. */
function scripted(replies: string[]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    provider: 'test',
    model: 'scripted',
    requests,
    complete: async (req) => {
      requests.push(req);
      const text = replies.shift() ?? '{"action":"finish","answer":{}}';
      return { text, inputTokens: 10, outputTokens: 5, truncated: false };
    },
  };
}

const page = (markdown: string, receiptId = 'r1') => ({ ok: true, url: 'x', markdown, receiptId });
const tools = (over: Partial<AgentTools> = {}): AgentTools => ({
  search: async () => [{ title: 'Hit', url: 'https://example.com/a', description: 'about a' }],
  scrape: async (url) => ({ ...page('The capital is Paris.'), url }),
  ...over,
});
const deps = (llm: LlmClient, t: AgentTools = tools(), over: Partial<AgentDeps> = {}): AgentDeps => ({
  llm,
  tools: t,
  maxOutputTokens: 500,
  maxPageChars: 1000,
  isCancelled: async () => false,
  random: () => 'BOUNDARY',
  ...over,
});
const input = { prompt: 'What is the capital?', urls: [] as string[], strictConstrainToURLs: false, maxSteps: 5 };

describe('runAgent', () => {
  it('searches, reads a page and answers against the schema, recording a trace', async () => {
    const llm = scripted([
      '{"thought":"look it up","action":"search","query":"capital"}',
      '{"thought":"read it","action":"scrape","url":"https://example.com/a"}',
      '{"thought":"done","action":"finish","answer":{"capital":"Paris"}}',
    ]);
    const schema = { type: 'object', properties: { capital: { type: 'string' } }, required: ['capital'] };
    const r = await runAgent(deps(llm), { ...input, schema });
    expect(r).toMatchObject({ status: 'completed', data: { capital: 'Paris' }, tokensUsed: 45, sources: [{ url: 'https://example.com/a', receiptId: 'r1' }] });
    const types = r.events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('tool_call.started');
    expect(types.slice(-2)).toEqual(['agent.finished', 'run.finished']);
    expect(r.events.map((e) => e.producerSequence)).toEqual(r.events.map((_, i) => i));
    expect(r.events.find((e) => e.type === 'run.finished')).toMatchObject({ outcome: 'succeeded', error: null });
    // the page text reaches the model inside the untrusted block
    expect(llm.requests[2].user).toContain('<page url="https://example.com/a" boundary=BOUNDARY>');
    expect(llm.requests[2].user).toContain('The capital is Paris.');
    expect(llm.requests[0].system).toContain('untrusted');
  });

  it('wraps a free answer in {answer} when there is no schema', async () => {
    const r = await runAgent(deps(scripted(['{"action":"finish","answer":"Paris"}'])), input);
    expect(r).toMatchObject({ status: 'completed', data: { answer: 'Paris' } });
  });

  it('sends a rejected answer back to the model once it fails the schema', async () => {
    const llm = scripted(['{"action":"finish","answer":{"capital":7}}', '{"action":"finish","answer":{"capital":"Paris"}}']);
    const schema = { type: 'object', properties: { capital: { type: 'string' } }, required: ['capital'] };
    const r = await runAgent(deps(llm), { ...input, schema });
    expect(r.status).toBe('completed');
    expect(llm.requests[1].user).toContain('your answer was rejected');
  });

  it('only reads the given URLs and does not search when strictConstrainToURLs is set', async () => {
    const scraped: string[] = [];
    const t = tools({ scrape: async (url) => (scraped.push(url), { ...page('ok'), url }) });
    const llm = scripted([
      '{"action":"search","query":"x"}',
      '{"action":"scrape","url":"https://evil.example/exfil"}',
      '{"action":"scrape","url":"https://example.com/a#section"}',
      '{"action":"finish","answer":"done"}',
    ]);
    const r = await runAgent(deps(llm, t), { ...input, urls: ['https://example.com/a'], strictConstrainToURLs: true });
    expect(r.status).toBe('completed');
    expect(scraped).toEqual(['https://example.com/a']);
    expect(llm.requests[3].user).toContain('not one of the allowed URLs');
    expect(llm.requests[1].user).toContain('search was refused');
  });

  it('tells the model when a page could not be used and never shows its text', async () => {
    const t = tools({ scrape: async (url) => ({ ok: false, url, problem: 'the page was a captcha wall' }) });
    const llm = scripted(['{"action":"scrape","url":"https://example.com/a"}', '{"action":"finish","answer":"unknown"}']);
    const r = await runAgent(deps(llm, t), input);
    expect(r.status).toBe('completed');
    expect(llm.requests[1].user).toContain('could not be used (the page was a captcha wall)');
    expect(r.status === 'completed' && r.sources).toEqual([]);
  });

  it('fails when the turns run out, and when the model cannot be reached', async () => {
    const r = await runAgent(deps(scripted(Array(3).fill('{"action":"search","query":"q"}'))), { ...input, maxSteps: 3 });
    expect(r).toMatchObject({ status: 'failed', code: 'EXTRACTION_FAILED' });
    expect(r.events.map((e) => e.type)).toContain('error.occurred');
    const broken: LlmClient = { provider: 't', model: 'm', complete: async () => { throw new Error('down'); } };
    expect(await runAgent(deps(broken), input)).toMatchObject({ status: 'failed', code: 'LLM_ERROR' });
  });

  it('stops when cancelled and reports progress to onEvents', async () => {
    let calls = 0;
    const seen: number[] = [];
    const r = await runAgent(
      deps(scripted(['{"action":"search","query":"q"}', '{"action":"search","query":"q"}']), tools(), {
        isCancelled: async () => ++calls > 1,
        onEvents: async (events) => void seen.push(events.length),
      }),
      input,
    );
    expect(r.status).toBe('cancelled');
    expect(r.events.map((e) => e.type)).toContain('run.cancel_requested');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('does not accept a finish without an answer', async () => {
    const llm = scripted(['{"action":"finish"}', '{"action":"finish","answer":"Paris"}']);
    const r = await runAgent(deps(llm), input);
    expect(r).toMatchObject({ status: 'completed', data: { answer: 'Paris' } });
    expect(llm.requests[1].user).toContain('finish needs an answer');
  });

  it('survives unparseable model replies', async () => {
    const r = await runAgent(deps(scripted(['I will think about it', '{"action":"finish","answer":"ok"}'])), input);
    expect(r.status).toBe('completed');
  });
});
