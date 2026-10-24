import type { Store } from '../store/types';

/** Deletes expired jobs (and their pages and receipts) on an interval. Returns a stop function. */
export function startReaper(store: Store, intervalMs = 3_600_000): () => void {
  const timer = setInterval(() => {
    store.deleteExpiredJobs(new Date()).catch((err) => console.error('[icecrawl] reaper failed:', (err as Error).message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
