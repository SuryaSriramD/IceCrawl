import { IceCrawlError } from '@icecrawl/core';

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Ask the model for a JSON object (JSON mode where the provider has one). */
  json: boolean;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider stopped because of the output token limit. */
  truncated: boolean;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface LlmConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  /** OpenAI-compatible: up to and including `/v1`. Anthropic: the origin, without `/v1`. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_BASE = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' } as const;

interface ErrorBody {
  error?: { message?: string };
}
interface OpenAiBody extends ErrorBody {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
interface AnthropicBody extends ErrorBody {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const base = (cfg.baseUrl ?? DEFAULT_BASE[cfg.provider]).replace(/\/+$/, '');
  const redact = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join('[redacted]') : s);

  async function post<T extends ErrorBody>(url: string, headers: Record<string, string>, body: unknown) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new IceCrawlError(
        'LLM_ERROR',
        timedOut
          ? `The language model did not answer within ${timeoutMs} ms`
          : `Could not reach the language model: ${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
    const raw = await res.text();
    let json: T | null = null;
    try {
      json = JSON.parse(raw) as T;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, raw };
  }

  const failure = (status: number, json: ErrorBody | null, raw: string) => {
    const detail = redact(json?.error?.message ?? raw).replace(/\s+/g, ' ').slice(0, 300);
    return new IceCrawlError('LLM_ERROR', `The language model answered HTTP ${status}${detail ? `: ${detail}` : ''}`);
  };

  async function openai(req: LlmRequest): Promise<LlmResponse> {
    const isOpenAi = new URL(base).hostname === 'api.openai.com';
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
    body[isOpenAi ? 'max_completion_tokens' : 'max_tokens'] = req.maxOutputTokens;
    if (!isOpenAi) body.temperature = 0;
    if (req.json) body.response_format = { type: 'json_object' };
    const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};

    let r = await post<OpenAiBody>(`${base}/chat/completions`, headers, body);
    if (r.status === 400 && req.json && /response_format/i.test(r.raw)) {
      delete body.response_format;
      r = await post<OpenAiBody>(`${base}/chat/completions`, headers, body);
    }
    if (!r.ok) throw failure(r.status, r.json, r.raw);

    const choice = r.json?.choices?.[0];
    const content = choice?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('')
          : '';
    if (!text) throw new IceCrawlError('LLM_ERROR', 'The language model returned an empty answer');
    return {
      text,
      inputTokens: r.json?.usage?.prompt_tokens ?? 0,
      outputTokens: r.json?.usage?.completion_tokens ?? 0,
      truncated: choice?.finish_reason === 'length',
    };
  }

  async function anthropic(req: LlmRequest): Promise<LlmResponse> {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01', ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {}) };
    const r = await post<AnthropicBody>(`${base}/v1/messages`, headers, {
      model: cfg.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });
    if (!r.ok) throw failure(r.status, r.json, r.raw);
    const text = (r.json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!text) throw new IceCrawlError('LLM_ERROR', 'The language model returned an empty answer');
    return {
      text,
      inputTokens: r.json?.usage?.input_tokens ?? 0,
      outputTokens: r.json?.usage?.output_tokens ?? 0,
      truncated: r.json?.stop_reason === 'max_tokens',
    };
  }

  return { provider: cfg.provider, model: cfg.model, complete: cfg.provider === 'anthropic' ? anthropic : openai };
}
