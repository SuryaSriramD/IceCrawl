import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import type { JobPosting, ScraperConfig } from '@icecrawl/scraper';
import { detectBoard, findBoard, listBoardJobs, makeJsonFetcher, type AtsBoard, type AtsKind, type JsonFetcher } from '../jobs/careers';
import { mapPool } from '../pool';
import { scrapeAndPersist, type ScrapeServiceDeps } from '../scrape-service';

export interface JobBoardRouteDeps extends ScrapeServiceDeps {
  scraper: ScraperConfig;
  /** Reads the applicant-tracking-system APIs; tests replace it. */
  jsonFetcher?: JsonFetcher;
}

interface JobsData {
  source: string;
  board?: string;
  total: number;
  jobs: JobPosting[];
  trust?: unknown;
  warning?: string;
}
type Read = { ok: true; data: JobsData } | { ok: false; status: number; payload: Record<string, unknown> };

const readSchema = z.object({ url: z.string().url(), limit: z.number().int().min(1).max(500).default(100) });
const MAX_BOARDS = 25;
const searchSchema = z.object({
  boards: z.array(z.string().min(1).max(500)).min(1).max(MAX_BOARDS),
  query: z.string().max(200).optional(),
  location: z.string().max(100).optional(),
  remote: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

const FOLLOW_PAGES = 3;
const CAREERS_PATH = /\/(careers?|jobs?|openings|positions|vacancies|join(-us)?|work-with-us|opportunities)(\/|$)/i;
const SHORTHAND = /^(greenhouse|lever|ashby|smartrecruiters|recruitee|workday):([\w./-]{1,120})$/i;

const bad = (e: z.ZodError) => new IceCrawlError('VALIDATION', e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));

/** `greenhouse:acme` or `workday:tenant/wd5/Site` as a board, otherwise null (the entry is a URL). */
function shorthandBoard(entry: string): AtsBoard | null {
  const m = SHORTHAND.exec(entry);
  if (!m) return null;
  const kind = m[1].toLowerCase() as AtsKind;
  const id = m[2];
  return detectBoard(
    {
      greenhouse: `https://boards.greenhouse.io/${id}`,
      lever: `https://jobs.lever.co/${id}`,
      ashby: `https://jobs.ashbyhq.com/${id}`,
      smartrecruiters: `https://jobs.smartrecruiters.com/${id}`,
      recruitee: `https://${id}.recruitee.com/`,
      workday: `https://${id.split('/')[0]}.${id.split('/')[1]}.myworkdayjobs.com/${id.split('/')[2] ?? ''}`,
    }[kind],
  );
}

/** Links of a company page that probably lead to its job listings, on the same site. */
function careersLinks(links: readonly string[], pageUrl: string): string[] {
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const seen = new Set([pageUrl]);
  const out: string[] = [];
  for (const l of links) {
    try {
      const u = new URL(l);
      u.hash = '';
      if (u.hostname.replace(/^www\./, '') !== host || !CAREERS_PATH.test(u.pathname) || seen.has(u.href)) continue;
      seen.add(u.href);
      out.push(u.href);
    } catch {
      // not a URL
    }
  }
  return out.slice(0, FOLLOW_PAGES);
}

/** Case-insensitive match of every word of `query` against a job's title, company and description. */
function matches(j: JobPosting, o: { query?: string; location?: string; remote?: boolean }): boolean {
  const hay = `${j.title} ${j.company ?? ''} ${j.description ?? ''}`.toLowerCase();
  if (o.query && !o.query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  const loc = (j.location ?? '').toLowerCase();
  if (o.location && !loc.includes(o.location.toLowerCase())) return false;
  if (o.remote === true && !(j.remote || /remote/.test(loc))) return false;
  return true;
}

/**
 * Jobs endpoints. A page of a supported applicant-tracking system (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Recruitee) is
 * read from that system's public API. Any other page is scraped: the schema.org JobPosting data it embeds is returned; otherwise a
 * board it links to or embeds is followed, and failing that the careers pages it links to (up to three) are looked at the same way.
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

  const boardResult = async (board: AtsBoard, limit: number, trust?: unknown): Promise<Read> => {
    const jobs = await fromBoard(board, limit);
    return { ok: true, data: { source: board.kind, board: board.id, total: jobs.length, jobs, ...(trust ? { trust } : {}) } };
  };

  /** Scrapes one page and looks for jobs, a board, or careers pages to follow. */
  const readPage = async (url: string, limit: number, apiKeyId: string | null, follow: boolean): Promise<Read> => {
    const { run, status, payload } = await scrapeAndPersist(deps, normalizeScrapeRequest({ url, formats: ['jobs', 'links'] }), { apiKeyId });
    if (payload.success !== true) return { ok: false, status, payload };
    const data = payload.data as { jobs: JobPosting[]; links?: string[]; trust: unknown };
    if (data.jobs.length > 0) return { ok: true, data: { source: 'page', total: data.jobs.length, jobs: data.jobs.slice(0, limit), trust: data.trust } };
    // the scripts of a rendered page often carry the board's address even when no link does
    const board = findBoard(data.links ?? [], run.rawHtml);
    if (board) return boardResult(board, limit, data.trust);
    if (follow) {
      for (const next of careersLinks(data.links ?? [], run.finalUrl)) {
        try {
          assertUrlAllowed(next, deps.scraper.allowPrivateNetworks);
          const r = await readPage(next, limit, apiKeyId, false);
          if (r.ok && r.data.total > 0) return r;
        } catch {
          // a careers page that fails to load does not stop the others from being tried
        }
      }
    }
    return {
      ok: true,
      data: {
        source: 'page',
        total: 0,
        jobs: [],
        trust: data.trust,
        warning: 'No job data found on this page: it has no schema.org JobPosting records and links to no supported job board. Try scrape with the browser engine, or open a single job page.',
      },
    };
  };

  const read = async (entry: string, limit: number, apiKeyId: string | null): Promise<Read> => {
    const board = shorthandBoard(entry) ?? detectBoard(entry);
    if (board) return boardResult(board, limit);
    assertUrlAllowed(entry, deps.scraper.allowPrivateNetworks);
    return readPage(entry, limit, apiKeyId, true);
  };

  v2.post('/jobs', async (req, reply) => {
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error);
    const r = await read(parsed.data.url, parsed.data.limit, req.apiKeyId);
    return r.ok ? { success: true, data: r.data } : reply.status(r.status).send(r.payload);
  });

  // POST /v2/jobs/search: several company boards at once, one filtered list back
  v2.post('/jobs/search', async (req) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error);
    const { boards, limit, ...filter } = parsed.data;
    const entries = [...new Set(boards.map((b) => b.trim()))];
    for (const e of entries) {
      if (!shorthandBoard(e) && !z.string().url().safeParse(e).success) throw new IceCrawlError('VALIDATION', `boards: "${e}" is neither a URL nor a board such as greenhouse:acme`);
    }
    const results = await mapPool(entries, 4, async (entry) => {
      try {
        return { entry, r: await read(entry, 200, req.apiKeyId) };
      } catch (err) {
        return { entry, error: err instanceof Error ? err.message : String(err) };
      }
    });
    const jobs: JobPosting[] = [];
    const errors: Array<{ board: string; error: string }> = [];
    let scanned = 0;
    for (const x of results) {
      if ('error' in x) errors.push({ board: x.entry, error: x.error ?? 'failed' });
      else if (!x.r.ok) errors.push({ board: x.entry, error: String(x.r.payload.error ?? x.r.payload.code ?? 'not readable') });
      else {
        scanned += x.r.data.total;
        jobs.push(...x.r.data.jobs.filter((j) => matches(j, filter)));
      }
    }
    // jobs whose title has every word come first, then the ones that only mention them in the description
    const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const inTitle = (j: JobPosting) => (words.every((w) => j.title.toLowerCase().includes(w)) ? 0 : 1);
    jobs.sort((a, b) => inTitle(a) - inTitle(b));
    return { success: true, data: { boardsRead: entries.length - errors.length, scanned, total: jobs.length, jobs: jobs.slice(0, limit), errors } };
  });
}
