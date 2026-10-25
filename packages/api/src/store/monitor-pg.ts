import type postgres from 'postgres';
import type { Baseline, CheckRecord, CheckStatus, MonitorRecord, MonitorStore, NewMonitor, PageRecord, PageStatus } from '../monitor/types';

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const monitorFrom = (r: postgres.Row): MonitorRecord => ({
  id: r.id,
  apiKeyId: r.api_key_id,
  name: r.name,
  status: r.status,
  cron: r.cron,
  timezone: r.timezone,
  targets: r.targets,
  webhook: r.webhook,
  notification: r.notification,
  retentionDays: r.retention_days,
  goal: r.goal,
  judgeEnabled: r.judge_enabled,
  nextRunAt: iso(r.next_run_at),
  lastRunAt: iso(r.last_run_at),
  currentCheckId: r.current_check_id,
  lastCheckSummary: r.last_check_summary,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const checkFrom = (r: postgres.Row): CheckRecord => ({
  id: r.id,
  monitorId: r.monitor_id,
  status: r.status,
  trigger: r.trigger,
  scheduledFor: iso(r.scheduled_for),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  summary: r.summary,
  targetResults: r.target_results,
  error: r.error,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const pageFrom = (r: postgres.Row): PageRecord => ({
  id: r.id,
  checkId: r.check_id,
  targetId: r.target_id,
  url: r.url,
  status: r.status,
  previousScrapeId: r.previous_scrape_id,
  currentScrapeId: r.current_scrape_id,
  statusCode: r.status_code,
  error: r.error,
  metadata: r.metadata,
  diff: r.diff,
  createdAt: iso(r.created_at)!,
});

export class PgMonitorStore implements MonitorStore {
  constructor(private readonly sql: postgres.Sql) {}

  private json(v: unknown) {
    return v === null || v === undefined ? null : this.sql.json(v as never);
  }

  async createMonitor(m: NewMonitor): Promise<MonitorRecord> {
    const [r] = await this.sql`
      insert into monitors (id, api_key_id, name, status, cron, timezone, targets, webhook, notification, retention_days, goal, judge_enabled, next_run_at)
      values (${m.id}, ${m.apiKeyId}, ${m.name}, ${m.status}, ${m.cron}, ${m.timezone}, ${this.sql.json(m.targets as never)}, ${this.json(m.webhook)},
              ${this.json(m.notification)}, ${m.retentionDays}, ${m.goal}, ${m.judgeEnabled}, ${m.nextRunAt})
      returning *`;
    return monitorFrom(r);
  }

  async getMonitor(id: string) {
    const [r] = await this.sql`select * from monitors where id = ${id}`;
    return r ? monitorFrom(r) : null;
  }

  async listMonitors(apiKeyId: string | null, limit: number, offset: number) {
    const rows = await this.sql`select * from monitors where api_key_id is not distinct from ${apiKeyId} order by created_at desc limit ${limit} offset ${offset}`;
    return rows.map(monitorFrom);
  }

  async updateMonitor(id: string, p: Partial<MonitorRecord>) {
    const [cur] = await this.sql`select * from monitors where id = ${id}`;
    if (!cur) return null;
    const m = { ...monitorFrom(cur), ...p };
    const [r] = await this.sql`
      update monitors set name = ${m.name}, status = ${m.status}, cron = ${m.cron}, timezone = ${m.timezone}, targets = ${this.sql.json(m.targets as never)},
        webhook = ${this.json(m.webhook)}, notification = ${this.json(m.notification)}, retention_days = ${m.retentionDays}, goal = ${m.goal},
        judge_enabled = ${m.judgeEnabled}, next_run_at = ${m.nextRunAt}, last_run_at = ${m.lastRunAt}, current_check_id = ${m.currentCheckId},
        last_check_summary = ${this.json(m.lastCheckSummary)}, updated_at = now()
      where id = ${id} returning *`;
    return monitorFrom(r);
  }

  async deleteMonitor(id: string) {
    const rows = await this.sql`delete from monitors where id = ${id} returning id`;
    return rows.length > 0;
  }

  async claimDue(at: Date, limit: number, advance: (m: MonitorRecord) => Date | null) {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        select * from monitors where status = 'active' and next_run_at is not null and next_run_at <= ${at.toISOString()}
        order by next_run_at limit ${limit} for update skip locked`;
      const claimed = rows.map(monitorFrom);
      for (const m of claimed) {
        await tx`update monitors set next_run_at = ${advance(m)?.toISOString() ?? null} where id = ${m.id}`;
      }
      return claimed;
    });
  }

  async createCheck(c: Omit<CheckRecord, 'createdAt' | 'updatedAt'>) {
    const [r] = await this.sql`
      insert into monitor_checks (id, monitor_id, status, trigger, scheduled_for, started_at, finished_at, summary, target_results, error)
      values (${c.id}, ${c.monitorId}, ${c.status}, ${c.trigger}, ${c.scheduledFor}, ${c.startedAt}, ${c.finishedAt}, ${this.json(c.summary)}, ${this.json(c.targetResults)}, ${c.error})
      returning *`;
    return checkFrom(r);
  }

  async getCheck(monitorId: string, checkId: string) {
    const [r] = await this.sql`select * from monitor_checks where id = ${checkId} and monitor_id = ${monitorId}`;
    return r ? checkFrom(r) : null;
  }

  async findCheck(checkId: string) {
    const [r] = await this.sql`select * from monitor_checks where id = ${checkId}`;
    return r ? checkFrom(r) : null;
  }

  async listChecks(monitorId: string, o: { limit: number; offset: number; status?: CheckStatus }) {
    const rows = o.status
      ? await this.sql`select * from monitor_checks where monitor_id = ${monitorId} and status = ${o.status} order by created_at desc, id desc limit ${o.limit} offset ${o.offset}`
      : await this.sql`select * from monitor_checks where monitor_id = ${monitorId} order by created_at desc, id desc limit ${o.limit} offset ${o.offset}`;
    return rows.map(checkFrom);
  }

  async updateCheck(id: string, p: Partial<CheckRecord>) {
    const [cur] = await this.sql`select * from monitor_checks where id = ${id}`;
    if (!cur) return;
    const c = { ...checkFrom(cur), ...p };
    await this.sql`
      update monitor_checks set status = ${c.status}, started_at = ${c.startedAt}, finished_at = ${c.finishedAt}, summary = ${this.json(c.summary)},
        target_results = ${this.json(c.targetResults)}, error = ${c.error}, updated_at = now() where id = ${id}`;
  }

  async addPage(p: Omit<PageRecord, 'createdAt'>) {
    await this.sql`
      insert into monitor_pages (id, check_id, target_id, url, status, previous_scrape_id, current_scrape_id, status_code, error, metadata, diff)
      values (${p.id}, ${p.checkId}, ${p.targetId}, ${p.url}, ${p.status}, ${p.previousScrapeId}, ${p.currentScrapeId}, ${p.statusCode}, ${p.error}, ${this.json(p.metadata)}, ${this.json(p.diff)})`;
  }

  async listPages(checkId: string, o: { skip: number; limit: number; status?: PageStatus }) {
    const rows = o.status
      ? await this.sql`select * from monitor_pages where check_id = ${checkId} and status = ${o.status} order by seq limit ${o.limit} offset ${o.skip}`
      : await this.sql`select * from monitor_pages where check_id = ${checkId} order by seq limit ${o.limit} offset ${o.skip}`;
    return rows.map(pageFrom);
  }

  async listBaselines(monitorId: string): Promise<Baseline[]> {
    const rows = await this.sql`select * from monitor_baselines where monitor_id = ${monitorId}`;
    return rows.map((r) => ({ monitorId: r.monitor_id, url: r.url, targetId: r.target_id, contentHash: r.content_hash, markdown: r.markdown, scrapeId: r.scrape_id }));
  }

  async upsertBaseline(b: Baseline) {
    await this.sql`
      insert into monitor_baselines (monitor_id, url, target_id, content_hash, markdown, scrape_id)
      values (${b.monitorId}, ${b.url}, ${b.targetId}, ${b.contentHash}, ${b.markdown}, ${b.scrapeId})
      on conflict (monitor_id, url) do update set target_id = excluded.target_id, content_hash = excluded.content_hash,
        markdown = excluded.markdown, scrape_id = excluded.scrape_id, seen_at = now()`;
  }

  async deleteBaselines(monitorId: string, urls: string[]) {
    if (urls.length > 0) await this.sql`delete from monitor_baselines where monitor_id = ${monitorId} and url in ${this.sql(urls)}`;
  }

  async deleteExpiredChecks(at: Date) {
    const rows = await this.sql`
      delete from monitor_checks c using monitors m
      where c.monitor_id = m.id and c.created_at < ${at.toISOString()}::timestamptz - (m.retention_days * interval '1 day') returning c.id`;
    return rows.length;
  }

  async failStaleChecks(olderThan: Date) {
    const rows = await this.sql`
      update monitor_checks set status = 'failed', error = 'The check did not finish in time and was stopped.', finished_at = now(), updated_at = now()
      where status in ('queued', 'running') and created_at < ${olderThan.toISOString()} returning id`;
    if (rows.length > 0) await this.sql`update monitors set current_check_id = null where current_check_id in ${this.sql(rows.map((r) => r.id as string))}`;
    return rows.length;
  }
}
