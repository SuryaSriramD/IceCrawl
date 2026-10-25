import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IceCrawlError } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import { makeValidator } from '@icecrawl/extract';
import { LLM_HELP, type ExtractionDeps } from '../scrape-service';
import type { Store } from '../store/types';
import type { JobsDeps } from './jobs';

export interface AgentRouteDeps {
  store: Store;
  useAuth: boolean;
  jobs?: JobsDeps;
  extraction?: ExtractionDeps;
}

const requestSchema = z
  .object({
    urls: z.array(z.string().url()).max(20).default([]),
    prompt: z.string().min(1).max(10_000),
    schema: z.record(z.unknown()).optional(),
    strictConstrainToURLs: z.boolean().default(false),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
  })
  .passthrough();

/** Accepted for compatibility with Firecrawl clients; IceCrawl has no credits, models, threads or paid providers. */
const IGNORED = ['maxCredits', 'model', 'webhook', 'auditMetadata', 'threatProtection', 'threadId', 'mode', 'zeroDataRetention', 'location', 'exchange'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerAgentRoutes(v2: FastifyInstance, deps: AgentRouteDeps): void {
  const find = async (id: string, apiKeyId: string | null) => {
    const job = UUID.test(id) ? await deps.store.getJob(id) : null;
    if (!job || job.type !== 'agent' || (deps.useAuth && job.apiKeyId !== apiKeyId) || Date.parse(job.expiresAt) < Date.now()) {
      throw new IceCrawlError('NOT_FOUND', 'Agent run not found');
    }
    return job;
  };
  const statusOf = (s: string) => (s === 'scraping' ? 'processing' : s === 'completed' ? 'completed' : 'failed');

  v2.post('/agent', async (req) => {
    if (!deps.jobs) throw new IceCrawlError('NOT_IMPLEMENTED', 'The job queue is not configured on this server.');
    if (!deps.extraction?.llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new IceCrawlError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const body = parsed.data;
    if (body.schema) makeValidator(body.schema);
    for (const u of body.urls) assertUrlAllowed(u, deps.jobs.allowPrivateNetworks);
    const ignored = IGNORED.filter((k) => body[k] !== undefined);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'agent',
      apiKeyId: req.apiKeyId,
      request: { urls: body.urls, prompt: body.prompt, schema: body.schema, strictConstrainToURLs: body.strictConstrainToURLs, effort: body.effort },
      webhook: null,
      limit: 0,
      expiresAt: new Date(Date.now() + deps.jobs.ttlHours * 3_600_000),
    });
    await deps.jobs.queues.addAgent(id);
    return { success: true, id, ...(ignored.length > 0 ? { warning: `Ignored agent options: ${ignored.join(', ')}.` } : {}) };
  });

  v2.get('/agent', async (req) => {
    const jobs = await deps.store.listJobs(req.apiKeyId, 'agent', 100);
    return {
      success: true,
      agents: jobs
        .filter((j) => Date.parse(j.expiresAt) >= Date.now())
        .map((j) => {
          const r = j.request as { urls: string[]; prompt: string; schema?: unknown; effort: string };
          return { id: j.id, createdAt: j.createdAt, status: statusOf(j.status), options: { urls: r.urls, prompt: r.prompt, schema: r.schema, effort: r.effort } };
        }),
    };
  });

  v2.get<{ Params: { id: string } }>('/agent/:id', async (req) => {
    const job = await find(req.params.id, req.apiKeyId);
    const status = statusOf(job.status);
    const result = (job.result ?? {}) as Record<string, unknown>;
    if (status === 'processing') return { success: true, status, expiresAt: job.expiresAt };
    if (status === 'completed') {
      return { success: true, status, expiresAt: job.expiresAt, data: result.data, sources: result.sources, tokensUsed: job.tokensUsed ?? undefined };
    }
    return { success: true, status, expiresAt: job.expiresAt, error: result.error ?? `The run ${job.status}.`, code: result.code };
  });

  v2.delete<{ Params: { id: string } }>('/agent/:id', async (req) => {
    const job = await find(req.params.id, req.apiKeyId);
    await deps.store.cancelJob(job.id);
    return { success: true };
  });

  v2.get<{ Params: { id: string } }>('/agent/:id/trace', async (req) => {
    const job = await find(req.params.id, req.apiKeyId);
    const trace = ((job.result ?? {}) as { trace?: unknown[] }).trace ?? [];
    return { success: true, id: job.id, events: trace };
  });

  v2.get<{ Params: { id: string; snapshotId: string } }>('/agent/:id/snapshots/:snapshotId', async (req) => {
    const job = await find(req.params.id, req.apiKeyId);
    const snapshots = ((job.result ?? {}) as { snapshots?: Record<string, string> }).snapshots ?? {};
    const snapshot = snapshots[req.params.snapshotId];
    if (snapshot === undefined) throw new IceCrawlError('NOT_FOUND', 'Snapshot not found');
    return { success: true, id: job.id, snapshotId: req.params.snapshotId, snapshot };
  });
}
