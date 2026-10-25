import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  PermanentError,
  type JobQueues,
  type PageJobData,
  type ScrapeJobData,
  type SlotResult,
  type WebhookJobData,
  type WorkerHandlers,
} from './types';

export interface BullQueuesOptions {
  redisUrl: string;
  prefix?: string;
  maxAttempts?: number;
  seenTtlSeconds?: number;
}

const SCRAPE_QUEUE = 'scrape';
const WEBHOOK_QUEUE = 'webhook';

export class BullQueues implements JobQueues {
  readonly connection: IORedis;
  readonly prefix: string;
  readonly scrapeQueue: Queue<ScrapeJobData>;
  readonly webhookQueue: Queue<WebhookJobData>;
  private readonly maxAttempts: number;
  private readonly seenTtl: number;

  constructor(o: BullQueuesOptions) {
    this.prefix = o.prefix ?? 'icecrawl';
    this.maxAttempts = o.maxAttempts ?? 3;
    this.seenTtl = o.seenTtlSeconds ?? 3 * 24 * 3600;
    this.connection = new IORedis(o.redisUrl, { maxRetriesPerRequest: null });
    this.scrapeQueue = new Queue<ScrapeJobData>(SCRAPE_QUEUE, { connection: this.connection, prefix: this.prefix });
    this.webhookQueue = new Queue<WebhookJobData>(WEBHOOK_QUEUE, { connection: this.connection, prefix: this.prefix });
  }

  async addExtract(jobId: string): Promise<void> {
    await this.scrapeQueue.add('extract', { kind: 'extract', jobId }, { attempts: 1, removeOnComplete: true, removeOnFail: 1000 });
  }

  async addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void> {
    if (items.length === 0) return;
    await this.scrapeQueue.addBulk(
      items.map((i) => ({
        name: 'page',
        data: { kind: 'page' as const, ...i },
        opts: { attempts: this.maxAttempts, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: 1000 },
      })),
    );
  }

  async addDiscover(jobId: string): Promise<void> {
    await this.scrapeQueue.add('discover', { kind: 'discover', jobId }, { attempts: 1, removeOnComplete: true, removeOnFail: 1000 });
  }

  async addWebhook(data: WebhookJobData): Promise<void> {
    await this.webhookQueue.add('deliver', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  async markSeen(jobId: string, urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    const key = `${this.prefix}:seen:${jobId}`;
    const pipe = this.connection.pipeline();
    for (const u of urls) pipe.sadd(key, u);
    pipe.expire(key, this.seenTtl);
    const results = (await pipe.exec()) ?? [];
    return urls.filter((_, i) => results[i]?.[1] === 1);
  }

  // shortcut: slot counters expire after 10 minutes, so a crashed worker can hold a concurrency slot until then. Upgrade by storing a per-slot lease with its own TTL.
  async acquireSlot(jobId: string, o: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult> {
    let release = async () => {};
    if (o.maxConcurrency) {
      const key = `${this.prefix}:active:${jobId}`;
      const n = await this.connection.incr(key);
      await this.connection.expire(key, 600);
      if (n > o.maxConcurrency) {
        await this.connection.decr(key);
        return { ok: false, retryInMs: 200 };
      }
      release = async () => {
        await this.connection.decr(key);
      };
    }
    if (o.delayMs && o.delayMs > 0) {
      const key = `${this.prefix}:slot:${jobId}`;
      const got = await this.connection.set(key, '1', 'PX', o.delayMs, 'NX');
      if (got !== 'OK') {
        await release();
        const ttl = await this.connection.pttl(key);
        return { ok: false, retryInMs: Math.max(ttl, 50) };
      }
    }
    return { ok: true, release };
  }

  async clearJob(jobId: string): Promise<void> {
    await this.connection.del(`${this.prefix}:seen:${jobId}`, `${this.prefix}:active:${jobId}`, `${this.prefix}:slot:${jobId}`);
  }

  /** Throws when Redis cannot be reached. */
  async ping(): Promise<void> {
    await this.connection.ping();
  }

  async close(): Promise<void> {
    await this.scrapeQueue.close();
    await this.webhookQueue.close();
    this.connection.disconnect();
  }
}

export function startWorkers(
  q: BullQueues,
  h: WorkerHandlers,
  o: { concurrency: number; webhookConcurrency?: number },
): { close(): Promise<void> } {
  const scrapeWorker = new Worker<ScrapeJobData>(
    SCRAPE_QUEUE,
    async (job: Job<ScrapeJobData>, token?: string) => {
      const result = await h.scrape(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      if (result.delayMs) {
        await job.moveToDelayed(Date.now() + result.delayMs, token);
        throw new DelayedError();
      }
    },
    { connection: q.connection, prefix: q.prefix, concurrency: o.concurrency },
  );

  const webhookWorker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookJobData>) => {
      try {
        await h.webhook(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      } catch (err) {
        if (err instanceof PermanentError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: q.connection, prefix: q.prefix, concurrency: o.webhookConcurrency ?? 4 },
  );

  for (const w of [scrapeWorker, webhookWorker]) w.on('error', (err) => console.error('[icecrawl] queue worker error:', err.message));

  return {
    async close() {
      await Promise.all([scrapeWorker.close(), webhookWorker.close()]);
    },
  };
}
