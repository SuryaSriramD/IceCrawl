import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { runAgent, type AgentTools, type TraceEvent } from '@icecrawl/agent';
import { randomUUID } from 'node:crypto';
import { LLM_HELP, scrapeAndPersist } from '../scrape-service';
import type { JobRecord } from '../store/types';
import type { JobDeps } from './processor';

export interface StoredAgent {
  urls: string[];
  prompt: string;
  schema?: Record<string, unknown>;
  strictConstrainToURLs: boolean;
  effort: 'low' | 'medium' | 'high';
}

/** Turns the agent may take per effort level. */
export const AGENT_STEPS = { low: 4, medium: 8, high: 14 } as const;
const PAGE_CHARS = 20_000;

function toolsFor(deps: JobDeps, job: JobRecord): AgentTools {
  const search = deps.search;
  return {
    search: search
      ? async (query) => {
          const found = await search.search({ query, limit: 5, sources: ['web'], categories: [], timeoutMs: 30_000 });
          return found.web.map((h) => ({ title: h.title, url: h.url, description: h.description ?? '' }));
        }
      : null,
    async scrape(url) {
      try {
        const normalized = normalizeScrapeRequest({ url, formats: ['markdown'] });
        const { payload } = await scrapeAndPersist(deps, normalized, { apiKeyId: job.apiKeyId, jobId: job.id });
        if (payload.success === true) {
          const data = payload.data as { markdown: string; trust: { receiptId: string } };
          return { ok: true, url, markdown: data.markdown, receiptId: data.trust.receiptId };
        }
        // the reason is a fixed sentence built from our own error code, never page text
        return { ok: false, url, problem: `the page could not be read (${String(payload.code ?? 'TARGET_ERROR')})` };
      } catch (err) {
        return { ok: false, url, problem: `the page could not be read (${err instanceof IceCrawlError ? err.code : 'TARGET_ERROR'})` };
      }
    },
  };
}

export async function processAgentJob(deps: JobDeps, job: JobRecord): Promise<void> {
  const req = job.request as unknown as StoredAgent;
  const save = (result: Record<string, unknown>, tokens: number | null = null) => deps.store.saveJobResult(job.id, result, tokens);
  try {
    const llm = deps.extraction?.llm;
    if (!deps.extraction || !llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);
    const outcome = await runAgent(
      {
        llm,
        tools: toolsFor(deps, job),
        maxOutputTokens: deps.extraction.maxOutputTokens,
        maxPageChars: Math.min(PAGE_CHARS, deps.extraction.maxInputChars),
        isCancelled: async () => (await deps.store.getJob(job.id))?.status === 'cancelled',
        onEvents: async (events: readonly TraceEvent[]) => void (await save({ trace: [...events] })),
      },
      { prompt: req.prompt, urls: req.urls, schema: req.schema, strictConstrainToURLs: req.strictConstrainToURLs, maxSteps: AGENT_STEPS[req.effort] },
    );
    if (outcome.status === 'completed') {
      const snapshotId = randomUUID();
      await save(
        { data: outcome.data, sources: outcome.sources, trace: outcome.events, snapshots: { [snapshotId]: JSON.stringify(outcome.data) } },
        outcome.tokensUsed,
      );
      await deps.store.finalizeJob(job.id, 'completed');
    } else if (outcome.status === 'failed') {
      await save({ error: outcome.error, code: outcome.code, trace: outcome.events }, outcome.tokensUsed);
      await deps.store.finalizeJob(job.id, 'failed');
    } else {
      // the job is already marked cancelled; keep the trace
      await save({ error: 'The run was cancelled.', code: 'cancelled', trace: outcome.events }, outcome.tokensUsed);
    }
  } catch (err) {
    if (!(err instanceof IceCrawlError)) console.error('[icecrawl] agent job failed:', err);
    const e = err instanceof IceCrawlError ? err : new IceCrawlError('INTERNAL', 'The agent run failed unexpectedly.');
    await save({ error: e.message, code: e.code });
    await deps.store.finalizeJob(job.id, 'failed');
  }
}
