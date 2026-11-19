import { htmlToText, type JobPosting } from '@icecrawl/scraper';

/** GET, or POST when `body` is given, a public JSON API; resolves to the parsed body or throws. */
export type JsonFetcher = (url: string, body?: unknown) => Promise<unknown>;

export type AtsKind = JobPosting['source'] extends infer S ? Exclude<S, 'json-ld'> : never;
export interface AtsBoard {
  kind: AtsKind;
  /** Company slug, or for Workday `tenant/dcN/site`. */
  id: string;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d{1,3})\.myworkdayjobs\.com$/i;

/** Recognises a careers-board address of a supported applicant-tracking system, or null. */
export function detectBoard(input: string): AtsBoard | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
  const slugged = (kind: AtsKind, slug: string): AtsBoard | null => (SLUG.test(slug) ? { kind, id: slug } : null);

  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) return slugged('greenhouse', first === 'embed' ? (u.searchParams.get('for') ?? '') : first);
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) return slugged('lever', first);
  if (host === 'jobs.ashbyhq.com') return slugged('ashby', first);
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') return slugged('smartrecruiters', first);
  const recruitee = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (recruitee) return slugged('recruitee', recruitee[1]);
  const wd = WORKDAY_HOST.exec(host);
  if (wd) {
    const parts = u.pathname.split('/').filter(Boolean);
    // /en-US/Site or /Site
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts[1] : parts[0];
    return site && SLUG.test(site) ? { kind: 'workday', id: `${wd[1]}/${wd[2]}/${site}` } : null;
  }
  return null;
}

/** The first supported board address found in a page's links or markup (for a company's own careers page that embeds one). */
export function findBoard(links: readonly string[], html: string): AtsBoard | null {
  for (const l of links) {
    const b = detectBoard(l);
    if (b) return b;
  }
  const re = /https?:\/\/[a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com)[^\s"'<>\\)]*/gi;
  for (const m of html.matchAll(re)) {
    const b = detectBoard(m[0].replace(/&amp;/g, '&'));
    if (b) return b;
  }
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const iso = (v: unknown): string | undefined => {
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};
const clip = (s?: string) => s?.slice(0, 20_000);

async function greenhouse(slug: string, get: JsonFetcher): Promise<JobPosting[]> {
  const data = rec(await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`));
  return arr(data.jobs).map((j) => ({
    title: str(j.title) ?? '',
    company: str(j.company_name) ?? slug,
    location: str(rec(j.location).name),
    postedAt: iso(j.first_published ?? j.updated_at),
    // Greenhouse sends the description as escaped HTML: unescape once, then strip the tags
    description: typeof j.content === 'string' ? clip(htmlToText(htmlToText(j.content))) : undefined,
    url: str(j.absolute_url),
    applyUrl: str(j.absolute_url),
    source: 'greenhouse' as const,
  }));
}

async function lever(slug: string, get: JsonFetcher): Promise<JobPosting[]> {
  const data = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return arr(data).map((j) => {
    const c = rec(j.categories);
    return {
      title: str(j.text) ?? '',
      company: slug,
      location: str(c.location),
      remote: str(j.workplaceType) === 'remote' ? true : undefined,
      employmentType: str(c.commitment),
      postedAt: iso(j.createdAt),
      description: clip(str(j.descriptionPlain)),
      url: str(j.hostedUrl),
      applyUrl: str(j.applyUrl),
      source: 'lever' as const,
    };
  });
}

async function ashby(slug: string, get: JsonFetcher): Promise<JobPosting[]> {
  const data = rec(await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`));
  return arr(data.jobs).map((j) => ({
    title: str(j.title) ?? '',
    company: slug,
    location: str(j.location),
    remote: j.isRemote === true ? true : undefined,
    employmentType: str(j.employmentType),
    salary: str(rec(j.compensation).compensationTierSummary),
    postedAt: iso(j.publishedAt),
    description: clip(str(j.descriptionPlain)),
    url: str(j.jobUrl),
    applyUrl: str(j.applyUrl),
    source: 'ashby' as const,
  }));
}

async function smartrecruiters(slug: string, get: JsonFetcher, limit: number): Promise<JobPosting[]> {
  const data = rec(await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${Math.min(limit, 100)}`));
  return arr(data.content).map((j) => {
    const l = rec(j.location);
    return {
      title: str(j.name) ?? '',
      company: str(rec(j.company).name) ?? slug,
      location: [str(l.city), str(l.region), str(l.country)?.toUpperCase()].filter(Boolean).join(', ') || undefined,
      remote: l.remote === true ? true : undefined,
      employmentType: str(rec(j.typeOfEmployment).label),
      postedAt: iso(j.releasedDate),
      url: typeof j.id === 'string' ? `https://jobs.smartrecruiters.com/${slug}/${j.id}` : undefined,
      source: 'smartrecruiters' as const,
    };
  });
}

async function recruitee(slug: string, get: JsonFetcher): Promise<JobPosting[]> {
  const data = rec(await get(`https://${slug}.recruitee.com/api/offers/`));
  return arr(data.offers).map((j) => ({
    title: str(j.title) ?? '',
    company: str(j.company_name) ?? slug,
    location: str(j.location),
    remote: j.remote === true ? true : undefined,
    employmentType: str(j.employment_type_code),
    postedAt: iso(j.published_at),
    description: typeof j.description === 'string' ? clip(htmlToText(j.description)) : undefined,
    url: str(j.careers_url),
    applyUrl: str(j.careers_apply_url),
    source: 'recruitee' as const,
  }));
}

async function workday(id: string, get: JsonFetcher, limit: number): Promise<JobPosting[]> {
  const [tenant, dc, site] = id.split('/');
  const origin = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const out: JobPosting[] = [];
  // Workday returns 20 postings a page
  for (let offset = 0; offset < limit; offset += 20) {
    const data = rec(await get(`${origin}/wday/cxs/${tenant}/${site}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: '' }));
    const page = arr(data.jobPostings);
    for (const j of page) {
      const path = str(j.externalPath);
      out.push({
        title: str(j.title) ?? '',
        company: tenant,
        location: str(j.locationsText),
        postedAt: str(j.postedOn),
        url: path ? `${origin}/${site}${path}` : undefined,
        source: 'workday',
      });
    }
    if (page.length < 20) break;
  }
  return out;
}

/** Every open job of a supported board, in one shape. `limit` caps what is returned. */
export async function listBoardJobs(board: AtsBoard, get: JsonFetcher, limit = 200): Promise<JobPosting[]> {
  const jobs = await (() => {
    switch (board.kind) {
      case 'greenhouse':
        return greenhouse(board.id, get);
      case 'lever':
        return lever(board.id, get);
      case 'ashby':
        return ashby(board.id, get);
      case 'smartrecruiters':
        return smartrecruiters(board.id, get, limit);
      case 'recruitee':
        return recruitee(board.id, get);
      case 'workday':
        return workday(board.id, get, limit);
    }
  })();
  return jobs.filter((j) => j.title).slice(0, limit);
}

/** Reads a public JSON API over HTTPS. Hosts come only from `detectBoard`, never from request input, so there is nothing to point at a private network. */
export function makeJsonFetcher(o: { timeoutMs?: number; maxBytes?: number } = {}): JsonFetcher {
  const maxBytes = o.maxBytes ?? 20 * 1024 * 1024;
  return async (url, body) => {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', 'user-agent': 'IceCrawl', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('response too large');
    return JSON.parse(text);
  };
}
