export type CheckStatus = 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'skipped_overlap' | 'skipped_no_credits';
export type PageStatus = 'same' | 'new' | 'changed' | 'removed' | 'error';

export type MonitorTarget =
  | { id: string; type: 'scrape'; urls: string[]; scrapeOptions?: Record<string, unknown> }
  | { id: string; type: 'crawl'; url: string; crawlOptions?: Record<string, unknown>; scrapeOptions?: Record<string, unknown> }
  | {
      id: string;
      type: 'search';
      queries: string[];
      searchWindow: '5m' | '15m' | '1h' | '6h' | '24h' | '7d';
      maxResults: number;
      includeDomains?: string[];
      excludeDomains?: string[];
    };

export interface MonitorWebhook {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  events?: Array<'monitor.page' | 'monitor.check.completed'>;
}

export interface CheckSummary {
  totalPages: number;
  same: number;
  changed: number;
  new: number;
  removed: number;
  error: number;
}

export interface MonitorRecord {
  id: string;
  apiKeyId: string | null;
  name: string;
  status: 'active' | 'paused';
  cron: string;
  timezone: string;
  targets: MonitorTarget[];
  webhook: MonitorWebhook | null;
  notification: Record<string, unknown> | null;
  retentionDays: number;
  goal: string | null;
  judgeEnabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  currentCheckId: string | null;
  lastCheckSummary: CheckSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type NewMonitor = Omit<MonitorRecord, 'createdAt' | 'updatedAt' | 'lastRunAt' | 'currentCheckId' | 'lastCheckSummary'>;

export interface CheckRecord {
  id: string;
  monitorId: string;
  status: CheckStatus;
  trigger: 'scheduled' | 'manual';
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: CheckSummary | null;
  targetResults: Array<Record<string, unknown>> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageRecord {
  id: string;
  checkId: string;
  targetId: string;
  url: string;
  status: PageStatus;
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  statusCode: number | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  diff: { text: string } | null;
  createdAt: string;
}

export interface Baseline {
  monitorId: string;
  url: string;
  targetId: string;
  contentHash: string;
  markdown: string;
  scrapeId: string | null;
}

/** Persistence of monitors, their checks, the per-page results and the last good content of every watched URL. */
export interface MonitorStore {
  createMonitor(m: NewMonitor): Promise<MonitorRecord>;
  getMonitor(id: string): Promise<MonitorRecord | null>;
  listMonitors(apiKeyId: string | null, limit: number, offset: number): Promise<MonitorRecord[]>;
  updateMonitor(id: string, patch: Partial<Omit<MonitorRecord, 'id' | 'apiKeyId' | 'createdAt' | 'updatedAt'>>): Promise<MonitorRecord | null>;
  deleteMonitor(id: string): Promise<boolean>;
  /**
   * Atomically takes the active monitors whose next run is due and moves each one's next run forward with `advance`,
   * so that two schedulers never start the same run.
   */
  claimDue(now: Date, limit: number, advance: (m: MonitorRecord) => Date | null): Promise<MonitorRecord[]>;

  createCheck(c: Omit<CheckRecord, 'createdAt' | 'updatedAt'>): Promise<CheckRecord>;
  getCheck(monitorId: string, checkId: string): Promise<CheckRecord | null>;
  /** A check by id alone, for the worker. */
  findCheck(checkId: string): Promise<CheckRecord | null>;
  listChecks(monitorId: string, o: { limit: number; offset: number; status?: CheckStatus }): Promise<CheckRecord[]>;
  updateCheck(id: string, patch: Partial<Pick<CheckRecord, 'status' | 'startedAt' | 'finishedAt' | 'summary' | 'targetResults' | 'error'>>): Promise<void>;

  addPage(p: Omit<PageRecord, 'createdAt'>): Promise<void>;
  listPages(checkId: string, o: { skip: number; limit: number; status?: PageStatus }): Promise<PageRecord[]>;

  listBaselines(monitorId: string): Promise<Baseline[]>;
  upsertBaseline(b: Baseline): Promise<void>;
  deleteBaselines(monitorId: string, urls: string[]): Promise<void>;

  /** Deletes checks older than each monitor's retention. */
  deleteExpiredChecks(now: Date): Promise<number>;
  /** Marks checks still queued or running since before `olderThan` as failed. */
  failStaleChecks(olderThan: Date): Promise<number>;
}
