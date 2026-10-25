# Monitors

A monitor re-reads pages on a cron schedule and tells you what changed. It works with the Firecrawl v2 `/monitor` routes, so the official SDKs work against it.

```bash
curl -s -X POST localhost:3002/v2/monitor -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "name": "Pricing page",
  "schedule": { "cron": "0 */6 * * *", "timezone": "Europe/Berlin" },
  "targets": [{ "type": "scrape", "urls": ["https://example.com/pricing"] }],
  "webhook": { "url": "https://hooks.example/icecrawl" }
}'
```

- Routes: `POST/GET /v2/monitor`, `GET/PATCH/DELETE /v2/monitor/{id}`, `POST /v2/monitor/{id}/run`, `GET /v2/monitor/{id}/checks`, `GET /v2/monitor/{id}/checks/{checkId}` (pages, filterable by `status`, paged with `limit`/`skip` and a `next` link).
- Targets: `scrape` (URLs), `crawl` (the URLs `map` finds below one URL, up to `crawlOptions.limit`, default 20; it does not follow links page by page) and `search` (queries run through your SearXNG; each result is read).
- Each page in a check is `new` (first time seen), `same`, `changed` (with a unified `diff.text` against the last good copy), `removed` (no longer in a scrape or crawl target) or `error`. Search results that drop out of the results are not reported as removed.
- **Trust:** every page goes through the normal pipeline, so a blocked, captcha, login-wall or quarantined page is an `error` and never a change. The last good copy stays the baseline, so a site that is briefly behind a captcha does not produce a false change, and the page reads `same` when it comes back. `currentScrapeId` and `previousScrapeId` are receipt ids you can verify.
- Check status: `completed`, `partial` (some pages or targets failed), `failed` (nothing could be read), `skipped_overlap` (the previous check was still running).
- Webhooks: `monitor.page` (one per page that is not `same`) and `monitor.check.completed`, delivered and signed like crawl webhooks.
- Limits: schedules may not run more often than `ICECRAWL_MONITOR_MIN_INTERVAL_MINUTES` (15); a check reads at most `ICECRAWL_MONITOR_MAX_PAGES` (50) pages; checks are deleted after `retentionDays` (30). Checks left running by a crashed worker are failed after an hour.
- Not supported: natural-language `schedule.text` (use `cron`). Email notifications and the language-model judge (`goal`, `judgeEnabled`) are accepted, stored and named in `warning`, but do nothing. `changeTracking` formats and per-field JSON diffs are not implemented; diffs are of the page markdown.
- The scheduler runs in every API process with `ICECRAWL_RUN_WORKER` on and in each worker. Claiming a due monitor is atomic, so running several is safe.
