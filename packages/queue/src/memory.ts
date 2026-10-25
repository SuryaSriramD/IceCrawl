import type { JobQueues, PageJobData, ScrapeJobData, SlotResult, WebhookJobData } from './types';

export class MemoryQueues implements JobQueues {
  jobs: ScrapeJobData[] = [];
  webhooks: WebhookJobData[] = [];
  busy: number[] = [];
  cleared: string[] = [];
  private seen = new Map<string, Set<string>>();

  async addPages(items: Array<Omit<PageJobData, 'kind'>>): Promise<void> {
    for (const i of items) this.jobs.push({ kind: 'page', ...i });
  }
  async addExtract(jobId: string): Promise<void> {
    this.jobs.push({ kind: 'extract', jobId });
  }
  async addAgent(jobId: string): Promise<void> {
    this.jobs.push({ kind: 'agent', jobId });
  }
  async addDiscover(jobId: string): Promise<void> {
    this.jobs.push({ kind: 'discover', jobId });
  }
  async addWebhook(data: WebhookJobData): Promise<void> {
    this.webhooks.push(data);
  }
  async markSeen(jobId: string, urls: string[]): Promise<string[]> {
    let set = this.seen.get(jobId);
    if (!set) {
      set = new Set();
      this.seen.set(jobId, set);
    }
    const fresh: string[] = [];
    for (const u of urls) {
      if (!set.has(u)) {
        set.add(u);
        fresh.push(u);
      }
    }
    return fresh;
  }
  async acquireSlot(_jobId?: string, _o?: { maxConcurrency?: number; delayMs?: number }): Promise<SlotResult> {
    const wait = this.busy.shift();
    if (wait !== undefined) return { ok: false, retryInMs: wait };
    return { ok: true, release: async () => {} };
  }
  async clearJob(jobId: string): Promise<void> {
    this.cleared.push(jobId);
    this.seen.delete(jobId);
  }
  async close(): Promise<void> {}

  takeNext(): ScrapeJobData | undefined {
    return this.jobs.shift();
  }
}
