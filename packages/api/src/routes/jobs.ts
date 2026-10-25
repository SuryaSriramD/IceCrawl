import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IceCrawlError, normalizeBatchRequest, normalizeCrawlRequest } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import type { JobQueues } from '@icecrawl/queue';
import { sendWebhook } from '../jobs/webhooks';
import type { JobRecord, JobType, Store } from '../store/types';

export interface JobsDeps {
  queues: JobQueues;
  publicUrl?: string;
  ttlHours: number;
  pageBytes: number;
  maxCrawlLimit: number;
  allowPrivateNetworks: boolean;
  allowIgnoreRobots: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS: Record<JobType, string> = { crawl: 'crawl', batch: 'batch/scrape' };

export function registerJobRoutes(v2: FastifyInstance, deps: { store: Store; useAuth: boolean; jobs?: JobsDeps }): void {
  const need = (): JobsDeps => {
    if (!deps.jobs) throw new IceCrawlError('NOT_IMPLEMENTED', 'The job queue is not configured on this server.');
    return deps.jobs;
  };
  const baseOf = (req: FastifyRequest) => (deps.jobs?.publicUrl ?? `${req.protocol}://${req.headers.host}`).replace(/\/+$/, '');

  async function loadJob(req: FastifyRequest, id: string, type: JobType): Promise<JobRecord> {
    const job = UUID.test(id) ? await deps.store.getJob(id) : null;
    if (
      !job ||
      job.type !== type ||
      (deps.useAuth && job.apiKeyId !== req.apiKeyId) ||
      Date.parse(job.expiresAt) < Date.now()
    ) {
      throw new IceCrawlError('NOT_FOUND', 'Job not found');
    }
    return job;
  }

  async function statusBody(req: FastifyRequest, job: JobRecord, skipParam: unknown) {
    const j = need();
    const skip = Number.isInteger(Number(skipParam)) && Number(skipParam) > 0 ? Number(skipParam) : 0;
    const { items, nextSkip } = await deps.store.listJobPages(job.id, skip, j.pageBytes);
    const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
    return {
      success: true,
      status: job.status,
      total: job.total,
      completed: job.completed,
      creditsUsed: job.completed,
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      duration: Math.max(0, (end - Date.parse(job.createdAt)) / 1000),
      next: nextSkip === null ? null : `${baseOf(req)}/v2/${PATHS[job.type]}/${job.id}?skip=${nextSkip}`,
      data: items,
    };
  }

  async function errorsBody(job: JobRecord) {
    const all = await deps.store.listJobErrors(job.id);
    return {
      errors: all.filter((e) => e.kind === 'error').map((e) => ({ id: e.id, timestamp: e.timestamp, url: e.url, error: e.error })),
      robotsBlocked: all.filter((e) => e.kind === 'robots').map((e) => e.url),
    };
  }

  async function cancel(job: JobRecord) {
    if (!(await deps.store.cancelJob(job.id))) throw new IceCrawlError('CONFLICT', `The ${job.type} is already ${job.status}.`);
    await need().queues.clearJob(job.id);
    return { status: 'cancelled' };
  }

  function checkWebhook(webhook: { url: string } | undefined) {
    if (webhook) assertUrlAllowed(webhook.url, need().allowPrivateNetworks);
  }

  v2.post('/crawl', async (req) => {
    const j = need();
    const n = normalizeCrawlRequest(req.body);
    if (n.request.ignoreRobotsTxt && !j.allowIgnoreRobots) {
      throw new IceCrawlError('VALIDATION', 'ignoreRobotsTxt is disabled on this server.');
    }
    assertUrlAllowed(n.request.url, j.allowPrivateNetworks);
    checkWebhook(n.request.webhook);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'crawl',
      apiKeyId: req.apiKeyId,
      request: { ...n.request, scrapeOptions: n.scrapeOptions },
      webhook: n.request.webhook ?? null,
      limit: Math.min(n.request.limit, j.maxCrawlLimit),
      expiresAt: new Date(Date.now() + j.ttlHours * 3_600_000),
    });
    await j.queues.addDiscover(id);
    return {
      success: true,
      id,
      url: `${baseOf(req)}/v2/crawl/${id}`,
      ...(n.warnings.length > 0 ? { warning: n.warnings.join(' ') } : {}),
    };
  });

  v2.get('/crawl/active', async (req) => {
    need();
    const jobs = await deps.store.listActiveJobs(req.apiKeyId);
    return {
      success: true,
      crawls: jobs
        .filter((job) => job.type === 'crawl')
        .map((job) => ({
          id: job.id,
          teamId: job.apiKeyId,
          url: (job.request as { url: string }).url,
          status: job.status,
          options: { scrapeOptions: (job.request as { scrapeOptions?: unknown }).scrapeOptions ?? {} },
        })),
    };
  });

  v2.post('/crawl/params-preview', async () => {
    throw new IceCrawlError('NOT_IMPLEMENTED', '/v2/crawl/params-preview is not implemented yet.');
  });

  v2.get<{ Params: { id: string }; Querystring: { skip?: string } }>('/crawl/:id', async (req) =>
    statusBody(req, await loadJob(req, req.params.id, 'crawl'), req.query.skip),
  );
  v2.delete<{ Params: { id: string } }>('/crawl/:id', async (req) => cancel(await loadJob(req, req.params.id, 'crawl')));
  v2.get<{ Params: { id: string } }>('/crawl/:id/errors', async (req) => errorsBody(await loadJob(req, req.params.id, 'crawl')));

  v2.post('/batch/scrape', async (req) => {
    const j = need();
    const n = normalizeBatchRequest(req.body);
    for (const u of n.urls) assertUrlAllowed(u, j.allowPrivateNetworks);
    checkWebhook(n.request.webhook);

    const id = randomUUID();
    await deps.store.createJob({
      id,
      type: 'batch',
      apiKeyId: req.apiKeyId,
      request: { urls: n.urls, maxConcurrency: n.request.maxConcurrency, scrapeOptions: n.scrapeOptions },
      webhook: n.request.webhook ?? null,
      limit: n.urls.length,
      expiresAt: new Date(Date.now() + j.ttlHours * 3_600_000),
    });
    await deps.store.reserveUrls(id, n.urls.length);
    const job = (await deps.store.getJob(id))!;
    await sendWebhook(j.queues, job, 'started', []);
    await j.queues.addPages(n.urls.map((url) => ({ jobId: id, url, depth: 0, external: false })));
    return {
      success: true,
      id,
      url: `${baseOf(req)}/v2/batch/scrape/${id}`,
      ...(n.invalidURLs !== undefined ? { invalidURLs: n.invalidURLs } : {}),
      ...(n.warnings.length > 0 ? { warning: n.warnings.join(' ') } : {}),
    };
  });

  v2.get<{ Params: { id: string }; Querystring: { skip?: string } }>('/batch/scrape/:id', async (req) =>
    statusBody(req, await loadJob(req, req.params.id, 'batch'), req.query.skip),
  );
  v2.delete<{ Params: { id: string } }>('/batch/scrape/:id', async (req) => cancel(await loadJob(req, req.params.id, 'batch')));
  v2.get<{ Params: { id: string } }>('/batch/scrape/:id/errors', async (req) => errorsBody(await loadJob(req, req.params.id, 'batch')));
}
