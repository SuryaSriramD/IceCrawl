import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../src';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Reply = { status?: number; json?: unknown; text?: string } | Error;

function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: JSON.parse(String(init?.body)),
    });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const req = { system: 'sys', user: 'usr', maxOutputTokens: 300, json: true };
const chat = (content: unknown, over: Record<string, unknown> = {}) => ({
  json: { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 }, ...over },
});

describe('OpenAI-compatible client', () => {
  it('calls api.openai.com with max_completion_tokens and no temperature', async () => {
    const { fn, calls } = fakeFetch(chat('{"a":1}'));
    const llm = createLlmClient({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-test', fetch: fn });
    const r = await llm.complete(req);
    expect(r).toEqual({ text: '{"a":1}', inputTokens: 11, outputTokens: 7, truncated: false });
    expect(llm).toMatchObject({ provider: 'openai', model: 'gpt-x' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer sk-test');
    expect(calls[0].body).toMatchObject({
      model: 'gpt-x',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
      max_completion_tokens: 300,
      response_format: { type: 'json_object' },
    });
    expect(calls[0].body).not.toHaveProperty('temperature');
    expect(calls[0].body).not.toHaveProperty('max_tokens');
  });

  it('uses max_tokens and temperature 0 for other OpenAI-compatible servers, with no key needed', async () => {
    const { fn, calls } = fakeFetch(chat('hi'));
    const llm = createLlmClient({ provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1/', fetch: fn });
    await llm.complete({ ...req, json: false });
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toMatchObject({ max_tokens: 300, temperature: 0 });
    expect(calls[0].body).not.toHaveProperty('response_format');
    expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
  });

  it('retries once without response_format when the server rejects it', async () => {
    const { fn, calls } = fakeFetch(
      { status: 400, json: { error: { message: "Unknown parameter: 'response_format'" } } },
      chat('{"a":1}'),
    );
    const r = await createLlmClient({ provider: 'openai', model: 'm', baseUrl: 'http://x/v1', fetch: fn }).complete(req);
    expect(r.text).toBe('{"a":1}');
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveProperty('response_format');
    expect(calls[1].body).not.toHaveProperty('response_format');
  });

  it('reports a cut-off answer and joins content parts', async () => {
    const { fn } = fakeFetch(
      { json: { choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }], usage: {} } },
      chat([{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }]),
    );
    const llm = createLlmClient({ provider: 'openai', model: 'm', baseUrl: 'http://x/v1', fetch: fn });
    expect(await llm.complete(req)).toMatchObject({ text: '{"a"', truncated: true, inputTokens: 0, outputTokens: 0 });
    expect((await llm.complete(req)).text).toBe('one two');
  });

  it('fails with LLM_ERROR on HTTP errors, redacting the key from the message', async () => {
    const { fn } = fakeFetch({ status: 401, json: { error: { message: 'Incorrect API key provided: sk-secret-123' } } });
    const llm = createLlmClient({ provider: 'openai', model: 'm', apiKey: 'sk-secret-123', fetch: fn });
    const err = await llm.complete(req).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'LLM_ERROR' });
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).not.toContain('sk-secret-123');
  });

  it('fails with LLM_ERROR on network errors, timeouts and empty answers', async () => {
    const make = (reply: Reply) => createLlmClient({ provider: 'openai', model: 'm', baseUrl: 'http://x/v1', fetch: fakeFetch(reply).fn, timeoutMs: 1234 });
    await expect(make(new TypeError('fetch failed')).complete(req)).rejects.toMatchObject({ code: 'LLM_ERROR', message: expect.stringContaining('Could not reach') });
    await expect(make(Object.assign(new Error('t'), { name: 'TimeoutError' })).complete(req)).rejects.toMatchObject({
      code: 'LLM_ERROR',
      message: expect.stringContaining('1234 ms'),
    });
    await expect(make(chat('')).complete(req)).rejects.toMatchObject({ code: 'LLM_ERROR', message: expect.stringContaining('empty') });
  });
});

describe('Anthropic client', () => {
  it('calls the Messages API', async () => {
    const { fn, calls } = fakeFetch({
      json: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } },
    });
    const llm = createLlmClient({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-ant', fetch: fn });
    const r = await llm.complete(req);
    expect(r).toEqual({ text: '{"a":1}', inputTokens: 20, outputTokens: 5, truncated: false });
    expect(llm).toMatchObject({ provider: 'anthropic', model: 'claude-x' });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers).toMatchObject({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' });
    expect(calls[0].body).toEqual({ model: 'claude-x', max_tokens: 300, system: 'sys', messages: [{ role: 'user', content: 'usr' }] });
  });

  it('flags max_tokens stops as truncated and surfaces API errors', async () => {
    const trunc = fakeFetch({ json: { content: [{ type: 'text', text: 'abc' }], stop_reason: 'max_tokens', usage: {} } });
    expect((await createLlmClient({ provider: 'anthropic', model: 'm', apiKey: 'k', fetch: trunc.fn }).complete(req)).truncated).toBe(true);
    const bad = fakeFetch({ status: 429, json: { error: { message: 'rate limited' } } });
    await expect(createLlmClient({ provider: 'anthropic', model: 'm', apiKey: 'k', fetch: bad.fn }).complete(req)).rejects.toMatchObject({
      code: 'LLM_ERROR',
      message: expect.stringContaining('rate limited'),
    });
  });
});
