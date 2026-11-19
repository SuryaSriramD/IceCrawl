# Jobs

`POST /v2/jobs` returns the open jobs of a company careers page or job board as plain records, so an agent does not have to read job listings out of page text.

```bash
curl -s localhost:3002/v2/jobs -H "authorization: Bearer $ICECRAWL_API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://boards.greenhouse.io/<company>","limit":50}'
```

The answer is `{ success, data: { source, board?, total, jobs: [...], trust?, warning? } }`. Each job has `title`, and when known `company`, `location`, `remote`, `employmentType`, `salary`, `postedAt`, `description`, `url`, `applyUrl` and `source`.

## How a page is read

1. **A job-board address of a supported system** is read from that system's public API, with no page scraping: Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`), Lever (`jobs.lever.co`), Ashby (`jobs.ashbyhq.com`), SmartRecruiters (`jobs.smartrecruiters.com`), Recruitee (`<company>.recruitee.com`) and Workday (`<tenant>.wdN.myworkdayjobs.com`). Most company careers pages are one of these.
2. **Any other page** is scraped, and the schema.org `JobPosting` data in it (`application/ld+json`) is returned. Google for Jobs depends on this data, so many career pages and single job pages carry it. This is the `jobs` format of `/v2/scrape` too.
3. **A company page that links to a supported board** (for example a "See open roles" button) is followed to that board.
4. **Nothing found:** the answer has `total: 0` and a `warning`. A page that builds its content with JavaScript needs the browser engine (`ICECRAWL_BROWSER=true`); IceCrawl warns when it sees an empty app shell without it.

## Limits

- It reads one company at a time. It does not search across companies or job-board sites.
- It does not get past sites that block the request (Indeed, Glassdoor, Naukri and similar block cloud addresses); those return a blocked verdict as any scrape does.
- Job text comes from outside and is untrusted: the MCP tool marks it so, and the usual injection scan runs on scraped pages.
- Workday returns at most the `limit` newest postings, 20 per request. The ATS API calls go straight to the vendors' public hosts, which are fixed in the code and never taken from the request.
