import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict, WebhookConfig } from '@icecrawl/core';

export interface ApiKeyRow {
  id: string;
  name: string;
  revoked: boolean;
}

export interface ScrapeRecord {
  id: string;
  apiKeyId: string | null;
  url: string;
  finalUrl: string;
  verdict: Verdict;
  confidence: number;
  engine: string | null;
  statusCode: number | null;
  markdown: string | null;
  metadata: Record<string, unknown>;
  response: Record<string, unknown>;
  createdAt: string;
  jobId?: string | null;
}

export interface IndexHit {
  scrapeId: string;
  url: string;
  title: string | null;
  /** A few words of the page around the match. Page text: untrusted. */
  snippet: string;
  score: number;
  createdAt: string;
}

export interface SnapshotMeta {
  sha256: string;
  key: string;
  bytes: number;
}

export type JobType = 'crawl' | 'batch' | 'extract' | 'agent';
export type JobStatus = 'scraping' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  type: JobType;
  apiKeyId: string | null;
  status: JobStatus;
  request: Record<string, unknown>;
  webhook: WebhookConfig | null;
  limit: number;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  /** The stored outcome of an extract job (its data and trust report, or `{ error, code }`); null until saved. */
  result: Record<string, unknown> | null;
  tokensUsed: number | null;
}

export interface NewJob {
  id: string;
  type: JobType;
  apiKeyId: string | null;
  request: Record<string, unknown>;
  webhook: WebhookConfig | null;
  limit: number;
  expiresAt: Date;
}

export interface JobError {
  id: string;
  url: string;
  error: string;
  code: string | null;
  kind: 'error' | 'robots';
  timestamp: string;
}

export interface Usage {
  scrapes: number;
  /** Tokens spent by /extract jobs (the only place IceCrawl records them). */
  tokens: number;
}

export interface ActivityRow {
  id: string;
  /** scrape, crawl, batch_scrape or extract */
  endpoint: string;
  createdAt: string;
  url: string;
}

/** The last `count` UTC calendar months, oldest first, the current one last. */
export function lastMonths(count: number, now: Date = new Date()): Array<{ start: Date; end: Date }> {
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1)),
    };
  });
}

export const snapshotKey = (sha256: string): string => `${sha256.slice(0, 2)}/${sha256}`;

export interface Store {
  findApiKeyByHash(hash: string): Promise<ApiKeyRow | null>;
  createApiKey(k: { id: string; hash: string; name: string }): Promise<void>;
  revokeApiKey(id: string): Promise<void>;
  saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    snapshot: SnapshotMeta | null,
    signature?: ReceiptSignature | null,
  ): Promise<void>;
  getScrape(id: string): Promise<ScrapeRecord | null>;
  getReceipt(id: string): Promise<Receipt | null>;
  getSignedReceipt(id: string): Promise<SignedReceipt | null>;
  registerPublicKey(entry: PublicKeyEntry): Promise<void>;
  listPublicKeys(): Promise<PublicKeyEntry[]>;
  retireKey(keyId: string): Promise<void>;
  createJob(job: NewJob): Promise<void>;
  getJob(id: string): Promise<JobRecord | null>;
  reserveUrls(jobId: string, requested: number): Promise<number>;
  recordPageResult(
    jobId: string,
    outcome: 'completed' | 'failed',
  ): Promise<{ total: number; completed: number; failed: number; status: JobStatus }>;
  finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null>;
  cancelJob(jobId: string): Promise<boolean>;
  saveJobResult(jobId: string, result: Record<string, unknown>, tokensUsed: number | null): Promise<void>;
  addJobError(
    jobId: string,
    e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' },
  ): Promise<void>;
  listJobErrors(jobId: string): Promise<JobError[]>;
  listJobPages(jobId: string, skip: number, maxBytes: number): Promise<{ items: Record<string, unknown>[]; nextSkip: number | null }>;
  listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]>;
  /** The newest jobs of one type for an API key, newest first. */
  listJobs(apiKeyId: string | null, type: JobType, limit: number): Promise<JobRecord[]>;
  deleteExpiredJobs(now: Date): Promise<number>;
  /** Marks jobs that are still running but were created before `olderThan` as failed (their worker is gone). */
  failStaleJobs(olderThan: Date): Promise<number>;
  usageBetween(apiKeyId: string | null, from: Date, to: Date): Promise<Usage>;
  recentScrapes(apiKeyId: string | null, o: { limit: number; before?: string; endpoint?: string }): Promise<ActivityRow[]>;
  latestScrapeAt(apiKeyId: string | null): Promise<string | null>;
  /**
   * Full-text search over the pages this key has scraped successfully (blocked, empty and quarantined scrapes are not
   * indexed). Only the latest copy of each URL is returned, best match first.
   */
  searchScrapes(apiKeyId: string | null, query: string, limit: number, urlPrefix?: string): Promise<IndexHit[]>;
  /** Throws when the database cannot be reached. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  put(bytes: Uint8Array): Promise<SnapshotMeta>;
  get(key: string): Promise<Uint8Array | null>;
}
