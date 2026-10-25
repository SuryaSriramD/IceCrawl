import type { LlmClient, LlmRequest, LlmResponse } from '@icecrawl/extract';
import type { ExtractionDeps } from '../src/scrape-service';

export type Answer = string | Error | { text: string; truncated?: boolean };

/** A scripted language model: answers in order (the last answer repeats) and records every request. */
export function fakeLlm(...answers: Answer[]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    provider: 'fake',
    model: 'fake-1',
    requests,
    async complete(req) {
      requests.push(req);
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a instanceof Error) throw a;
      const r = typeof a === 'string' ? { text: a, truncated: false } : { truncated: false, ...a };
      return { ...r, inputTokens: 100, outputTokens: 10 } satisfies LlmResponse;
    },
  };
}

export const extractionDeps = (llm: LlmClient | null): ExtractionDeps => ({ llm, maxInputChars: 100_000, maxOutputTokens: 1000 });
