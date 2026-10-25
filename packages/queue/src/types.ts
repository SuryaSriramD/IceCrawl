export interface PageJobData {
  kind: 'page';
  jobId: string;
  url: string;
  depth: number;
  external: boolean;
}

export interface DiscoverJobData {
  kind: 'discover';
  jobId: string;
}

export interface ExtractJobData {
  kind: 'extract';
  jobId: string;
}

export type ScrapeJobData = PageJobData | DiscoverJobData | ExtractJobData;

export interface WebhookJobData {
  jobId: string;
  webhookId: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type SlotResult = { ok: true; release(): Promise<void> } | { ok: false; retryInMs: number };

export interface JobQueues {
  addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void>;
  addDiscover(jobId: string): Promise<void>;
  addExtract(jobId: string): Promise<void>;
  addWebhook(data: WebhookJobData): Promise<void>;
  /** Returns the URLs not seen before for this job, in input order. */
  markSeen(jobId: string, urls: string[]): Promise<string[]>;
  acquireSlot(jobId: string, o: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult>;
  clearJob(jobId: string): Promise<void>;
  close(): Promise<void>;
}

/** A handler throws this to say the job must not be retried. */
export class PermanentError extends Error {}

export interface JobContext {
  attemptsMade: number;
  maxAttempts: number;
}

export interface WorkerHandlers {
  scrape(data: ScrapeJobData, ctx: JobContext): Promise<{ delayMs?: number }>;
  webhook(data: WebhookJobData, ctx: JobContext): Promise<void>;
}
