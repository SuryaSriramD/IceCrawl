import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { IceCrawlError, isUrlPattern, normalizeExtractRequest, patternPrefix } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import { makeValidator } from '@icecrawl/extract';
import { LLM_HELP, type ExtractionDeps } from '../scrape-service';
import type { Store } from '../store/types';
import type { JobsDeps } from './jobs';

export interface ExtractRouteDeps {
  store: Store;
  useAuth: boolean;
  jobs?: JobsDeps;
  extraction?: ExtractionDeps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerExtractRoutes(v2: FastifyInstance, deps: ExtractRouteDeps): void {
  v2.post('/extract', async (req) => {
    if (!deps.jobs) throw new IceCrawlError('NOT_IMPLEMENTED', 'The job queue is not configured on this server.');
    if (!deps.extraction?.llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);
    const j = deps.jobs;
    const n = normalizeExtractRequest(req.body);
    if (n.request.schema) makeValidator(n.request.schema);
    for (const u of n.urls) assertUrlAllowed(isUrlPattern(u) ? patternPrefix(u) : u, j.allowPrivateNetworks);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'extract',
      apiKeyId: req.apiKeyId,
      request: {
        urls: n.urls,
        prompt: n.request.prompt,
        schema: n.request.schema,
        enableWebSearch: n.request.enableWebSearch,
        ignoreSitemap: n.request.ignoreSitemap,
        includeSubdomains: n.request.includeSubdomains,
        showSources: n.request.showSources,
        scrapeOptions: n.scrapeOptions,
      },
      webhook: null,
      limit: 0,
      expiresAt: new Date(Date.now() + j.ttlHours * 3_600_000),
    });
    await j.queues.addExtract(id);
    return {
      success: true,
      id,
      ...(n.invalidURLs ? { invalidURLs: n.invalidURLs } : {}),
      ...(n.warnings.length > 0 ? { warning: n.warnings.join(' ') } : {}),
    };
  });

  v2.get<{ Params: { id: string } }>('/extract/:id', async (req) => {
    const job = UUID.test(req.params.id) ? await deps.store.getJob(req.params.id) : null;
    if (!job || job.type !== 'extract' || (deps.useAuth && job.apiKeyId !== req.apiKeyId) || Date.parse(job.expiresAt) < Date.now()) {
      throw new IceCrawlError('NOT_FOUND', 'Extract job not found');
    }
    if (job.status === 'scraping') return { success: true, status: 'processing', expiresAt: job.expiresAt };
    const result = (job.result ?? {}) as Record<string, unknown>;
    if (job.status === 'completed') {
      return {
        success: true,
        status: 'completed',
        expiresAt: job.expiresAt,
        tokensUsed: job.tokensUsed ?? undefined,
        data: result.data,
        trust: result.trust,
        sources: result.sources,
        skipped: result.skipped,
        warning: result.warning,
      };
    }
    return {
      success: true,
      status: job.status,
      expiresAt: job.expiresAt,
      error: result.error ?? `The extraction ${job.status}.`,
      code: result.code,
    };
  });
}
