import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import type { JobPosting, ScraperConfig } from '@icecrawl/scraper';
import { detectBoard, findBoard, listBoardJobs, makeJsonFetcher, type AtsBoard, type JsonFetcher } from '../jobs/careers';
import { scrapeAndPersist, type ScrapeServiceDeps } from '../scrape-service';

export interface JobBoardRouteDeps extends ScrapeServiceDeps {
  scraper: ScraperConfig;
  /** Reads the applicant-tracking-system APIs; tests replace it. */
  jsonFetcher?: JsonFetcher;
}

const schema = z.object({ url: z.string().url(), limit: z.number().int().min(1).max(500).default(100) });

/**
 * POST /v2/jobs: the open jobs of a company's careers page, as clean records. A page of a supported applicant-tracking system
 * (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Recruitee) is read from that system's public API; any other page is scraped and
 * the schema.org JobPosting data it embeds is returned, and a page that links to one of those systems is followed there.
 */
export function registerJobBoardRoute(v2: FastifyInstance, deps: JobBoardRouteDeps): void {
  const get = deps.jsonFetcher ?? makeJsonFetcher();

  const fromBoard = async (board: AtsBoard, limit: number): Promise<JobPosting[]> => {
    try {
      return await listBoardJobs(board, get, limit);
    } catch (err) {
      throw new IceCrawlError('TARGET_ERROR', `Could not read the ${board.kind} job board "${board.id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  v2.post('/jobs', async (req, reply) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new IceCrawlError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const { url, limit } = parsed.data;
    assertUrlAllowed(url, deps.scraper.allowPrivateNetworks);

    const direct = detectBoard(url);
    if (direct) {
      const jobs = await fromBoard(direct, limit);
      return { success: true, data: { source: direct.kind, board: direct.id, total: jobs.length, jobs } };
    }

    const normalized = normalizeScrapeRequest({ url, formats: ['jobs', 'links'] });
    const { status, payload } = await scrapeAndPersist(deps, normalized, { apiKeyId: req.apiKeyId });
    if (payload.success !== true) return reply.status(status).send(payload);
    const data = payload.data as { jobs: JobPosting[]; links?: string[]; trust: unknown; metadata: { url: string } };

    if (data.jobs.length > 0) {
      const jobs = data.jobs.slice(0, limit);
      return { success: true, data: { source: 'page', total: data.jobs.length, jobs, trust: data.trust } };
    }
    const board = findBoard(data.links ?? [], '');
    if (board) {
      const jobs = await fromBoard(board, limit);
      return { success: true, data: { source: board.kind, board: board.id, total: jobs.length, jobs, trust: data.trust } };
    }
    return {
      success: true,
      data: {
        source: 'page',
        total: 0,
        jobs: [],
        trust: data.trust,
        warning: 'No job data found on this page: it has no schema.org JobPosting records and links to no supported job board. Try scrape with the browser engine, or open a single job page.',
      },
    };
  });
}
