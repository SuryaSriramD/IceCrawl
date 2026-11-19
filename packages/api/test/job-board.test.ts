import { describe, expect, it } from 'vitest';
import { jobPostingsFromHtml } from '@icecrawl/scraper';
import { detectBoard, findBoard, listBoardJobs, type JsonFetcher } from '../src/jobs/careers';
import { fakeEngine, makeApp, article } from './helpers';

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const page = (head: string) => `<html lang="en"><head><title>Careers</title>${head}</head><body>${article}</body></html>`;

const POSTING = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  description: '<p>Build <b>APIs</b></p>',
  datePosted: '2026-11-01',
  employmentType: ['FULL_TIME'],
  hiringOrganization: { '@type': 'Organization', name: 'Acme' },
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Pune', addressCountry: 'IN' } },
  jobLocationType: 'TELECOMMUTE',
  baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { minValue: 1000000, maxValue: 2000000, unitText: 'YEAR' } },
};

describe('jobPostingsFromHtml', () => {
  it('reads JobPosting data from plain, graph and list JSON-LD, skipping broken scripts and duplicates', () => {
    const html = page(
      ld(POSTING) + ld({ '@graph': [{ '@type': 'WebSite' }, { ...POSTING, title: 'Designer' }] }) + ld([POSTING]) + '<script type="application/ld+json">{oops</script>',
    );
    const jobs = jobPostingsFromHtml(html, 'https://acme.test/careers');
    expect(jobs.map((j) => j.title)).toEqual(['Backend Engineer', 'Designer']);
    expect(jobs[0]).toMatchObject({
      company: 'Acme',
      location: 'Pune, IN',
      remote: true,
      employmentType: 'FULL_TIME',
      salary: 'INR 1000000-2000000 per year',
      description: 'Build APIs',
      source: 'json-ld',
      url: 'https://acme.test/careers',
    });
  });

  it('returns nothing for a page without job data', () => {
    expect(jobPostingsFromHtml(page(ld({ '@type': 'Organization', name: 'Acme' })), 'https://acme.test/')).toEqual([]);
  });
});

describe('detectBoard and findBoard', () => {
  it.each([
    ['https://boards.greenhouse.io/acme', 'greenhouse', 'acme'],
    ['https://job-boards.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme'],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', 'acme'],
    ['https://jobs.lever.co/acme/abc', 'lever', 'acme'],
    ['https://jobs.ashbyhq.com/acme', 'ashby', 'acme'],
    ['https://jobs.smartrecruiters.com/Acme', 'smartrecruiters', 'Acme'],
    ['https://acme.recruitee.com/', 'recruitee', 'acme'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External', 'workday', 'acme/wd5/External'],
  ])('recognises %s', (url, kind, id) => {
    expect(detectBoard(url)).toEqual({ kind, id });
  });

  it('ignores other addresses and unsafe names', () => {
    expect(detectBoard('https://acme.test/careers')).toBeNull();
    expect(detectBoard('https://boards.greenhouse.io/')).toBeNull();
    expect(detectBoard('https://boards.greenhouse.io/..%2Fadmin')).toBeNull();
    expect(detectBoard('not a url')).toBeNull();
  });

  it('finds a board a company page links to or embeds', () => {
    expect(findBoard(['https://acme.test/about', 'https://jobs.lever.co/acme'], '')).toEqual({ kind: 'lever', id: 'acme' });
    expect(findBoard([], '<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme&amp;b=x"></iframe>')).toEqual({ kind: 'greenhouse', id: 'acme' });
    expect(findBoard(['https://acme.test/'], '<p>nothing</p>')).toBeNull();
  });
});

describe('listBoardJobs', () => {
  const asks: string[] = [];
  const get: JsonFetcher = async (url, body) => {
    asks.push(body === undefined ? url : `POST ${url} ${JSON.stringify(body)}`);
    if (url.includes('boards-api.greenhouse.io')) {
      return { jobs: [{ title: 'SRE', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', updated_at: '2026-11-02T10:00:00Z', content: '&lt;p&gt;Keep it &amp;amp; up&lt;/p&gt;' }] };
    }
    if (url.includes('api.lever.co')) {
      return [{ text: 'PM', categories: { location: 'Mumbai', commitment: 'Full-time' }, hostedUrl: 'https://jobs.lever.co/acme/1', applyUrl: 'https://jobs.lever.co/acme/1/apply', createdAt: 1_762_000_000_000, descriptionPlain: 'Lead' }];
    }
    if (url.includes('ashbyhq.com')) {
      return { jobs: [{ title: 'Data', location: 'Remote', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/acme/1', compensation: { compensationTierSummary: '$100K - $150K' } }] };
    }
    if (url.includes('smartrecruiters.com')) {
      return { content: [{ id: '77', name: 'QA', company: { name: 'Acme' }, location: { city: 'Delhi', country: 'in' } }] };
    }
    if (url.includes('recruitee.com')) return { offers: [{ title: 'Ops', location: 'Pune', careers_url: 'https://acme.recruitee.com/o/ops', description: '<p>Run</p>' }] };
    // workday: a full first page, then a short one
    const offset = (body as { offset: number }).offset;
    return { jobPostings: Array.from({ length: offset === 0 ? 20 : 3 }, (_, i) => ({ title: `Job ${offset + i}`, externalPath: `/job/x/${offset + i}`, locationsText: 'Pune' })) };
  };

  it('reads each system into the same shape', async () => {
    const gh = await listBoardJobs({ kind: 'greenhouse', id: 'acme' }, get);
    expect(gh[0]).toMatchObject({ title: 'SRE', location: 'Remote', description: 'Keep it & up', source: 'greenhouse' });
    const lv = await listBoardJobs({ kind: 'lever', id: 'acme' }, get);
    expect(lv[0]).toMatchObject({ title: 'PM', location: 'Mumbai', employmentType: 'Full-time', applyUrl: 'https://jobs.lever.co/acme/1/apply', postedAt: '2025-11-01T12:26:40.000Z' });
    expect((await listBoardJobs({ kind: 'ashby', id: 'acme' }, get))[0]).toMatchObject({ title: 'Data', remote: true, salary: '$100K - $150K' });
    expect((await listBoardJobs({ kind: 'smartrecruiters', id: 'acme' }, get))[0]).toMatchObject({ title: 'QA', location: 'Delhi, IN', url: 'https://jobs.smartrecruiters.com/acme/77' });
    expect((await listBoardJobs({ kind: 'recruitee', id: 'acme' }, get))[0]).toMatchObject({ title: 'Ops', description: 'Run' });
  });

  it('pages through Workday and honours the limit', async () => {
    const all = await listBoardJobs({ kind: 'workday', id: 'acme/wd5/External' }, get, 100);
    expect(all).toHaveLength(23);
    expect(all[0].url).toBe('https://acme.wd5.myworkdayjobs.com/External/job/x/0');
    expect(asks.some((a) => a.startsWith('POST https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs'))).toBe(true);
    expect(await listBoardJobs({ kind: 'workday', id: 'acme/wd5/External' }, get, 5)).toHaveLength(5);
  });
});

describe('POST /v2/jobs', () => {
  const post = (t: Awaited<ReturnType<typeof makeApp>>, body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/v2/jobs', headers: t.auth, payload: body });
  const board: JsonFetcher = async () => ({ jobs: [{ title: 'SRE', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }, { title: 'PM' }] });

  it('lists a board address through its API without scraping', async () => {
    const t = await makeApp({ jsonFetcher: board });
    const res = await post(t, { url: 'https://boards.greenhouse.io/acme', limit: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ source: 'greenhouse', board: 'acme', total: 1, jobs: [{ title: 'SRE' }] });
  });

  it('reads JSON-LD from an ordinary careers page', async () => {
    const t = await makeApp({ engine: fakeEngine({ html: page(ld(POSTING)) }), jsonFetcher: board });
    const data = (await post(t, { url: 'https://acme.test/careers' })).json().data;
    expect(data).toMatchObject({ source: 'page', total: 1, jobs: [{ title: 'Backend Engineer', company: 'Acme' }], trust: { verdict: 'ok' } });
  });

  it('follows a link from a company page to its job board', async () => {
    const html = `<html><head><title>Careers</title></head><body>${article}<a href="https://boards.greenhouse.io/acme">Open roles</a></body></html>`;
    const t = await makeApp({ engine: fakeEngine({ html }), jsonFetcher: board });
    expect((await post(t, { url: 'https://acme.test/careers' })).json().data).toMatchObject({ source: 'greenhouse', total: 2 });
  });

  it('says so when a page has no job data, and reports a failing board', async () => {
    const t = await makeApp({ jsonFetcher: board });
    expect((await post(t, { url: 'https://acme.test/' })).json().data).toMatchObject({ total: 0, jobs: [], warning: expect.stringContaining('No job data') });
    const broken = await makeApp({
      jsonFetcher: async () => {
        throw new Error('HTTP 404');
      },
    });
    const res = await post(broken, { url: 'https://boards.greenhouse.io/nope' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toContain('HTTP 404');
  });

  it('validates input and needs an API key', async () => {
    const t = await makeApp({ jsonFetcher: board });
    expect((await post(t, { url: 'nope' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/v2/jobs', payload: { url: 'https://acme.test/' } })).statusCode).toBe(401);
  });

  it('adds jobs to scrape as a format', async () => {
    const t = await makeApp({ engine: fakeEngine({ html: page(ld(POSTING)) }) });
    const res = await t.app.inject({ method: 'POST', url: '/v2/scrape', headers: t.auth, payload: { url: 'https://acme.test/job/1', formats: ['jobs'] } });
    expect(res.json().data.jobs[0]).toMatchObject({ title: 'Backend Engineer' });
  });
});

describe('JavaScript app shells', () => {
  it('warns when the fetch engine got an empty app shell', async () => {
    const shell = '<html lang="en"><head><title>Jobs</title></head><body><div id="root"></div><footer>About us, contact us, terms, privacy and many other footer links to read.</footer></body></html>';
    const engine = { ...fakeEngine({ html: shell }), name: 'fetch' };
    const t = await makeApp({ engine });
    const res = await t.app.inject({ method: 'POST', url: '/v2/scrape', headers: t.auth, payload: { url: 'https://acme.test/jobs' } });
    expect(res.json().data?.warning ?? res.json().error).toMatch(/builds its content with JavaScript|not trustworthy/);
  });
});
