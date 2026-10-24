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

export interface SnapshotMeta {
  sha256: string;
  key: string;
  bytes: number;
}

export type JobType = 'crawl' | 'batch';
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
  addJobError(
    jobId: string,
    e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' },
  ): Promise<void>;
  listJobErrors(jobId: string): Promise<JobError[]>;
  listJobPages(jobId: string, skip: number, maxBytes: number): Promise<{ items: Record<string, unknown>[]; nextSkip: number | null }>;
  listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]>;
  deleteExpiredJobs(now: Date): Promise<number>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  put(bytes: Uint8Array): Promise<SnapshotMeta>;
  get(key: string): Promise<Uint8Array | null>;
}
