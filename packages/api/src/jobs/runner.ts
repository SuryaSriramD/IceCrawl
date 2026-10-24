import { startWorkers, type BullQueues } from '@icecrawl/queue';
import { processScrapeJob, type JobDeps } from './processor';
import { deliverWebhook, type DeliveryDeps } from './webhooks';

export function startJobWorkers(
  q: BullQueues,
  deps: JobDeps,
  delivery: DeliveryDeps,
  o: { concurrency: number },
): { close(): Promise<void> } {
  return startWorkers(
    q,
    {
      scrape: (data, ctx) => processScrapeJob(deps, data, ctx),
      webhook: (data) => deliverWebhook(delivery, data),
    },
    { concurrency: o.concurrency },
  );
}
