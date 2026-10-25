import type { Store } from '../store/types';

export interface ReaperOptions {
  intervalMs?: number;
  /** A job still running after this long is considered lost with its worker and is marked failed. */
  maxRuntimeMs?: number;
}

/** One pass: stops jobs that outlived their worker, then deletes expired jobs (and their pages and receipts). */
export async function reapOnce(store: Store, maxRuntimeMs: number, now: Date = new Date()): Promise<{ failed: number; deleted: number }> {
  const failed = await store.failStaleJobs(new Date(now.getTime() - maxRuntimeMs));
  const deleted = await store.deleteExpiredJobs(now);
  return { failed, deleted };
}

/** Runs `reapOnce` on an interval. Returns a stop function. */
export function startReaper(store: Store, o: ReaperOptions = {}): () => void {
  const maxRuntimeMs = o.maxRuntimeMs ?? 6 * 3_600_000;
  const timer = setInterval(() => {
    reapOnce(store, maxRuntimeMs).catch((err) => console.error('[icecrawl] reaper failed:', (err as Error).message));
  }, o.intervalMs ?? 300_000);
  timer.unref();
  return () => clearInterval(timer);
}
