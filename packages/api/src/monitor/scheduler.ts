import { randomUUID } from 'node:crypto';
import type { JobQueues } from '@icecrawl/queue';
import { nextRun } from './schedule';
import type { CheckRecord, MonitorRecord, MonitorStore } from './types';

export interface SchedulerDeps {
  monitors: MonitorStore;
  queues: JobQueues;
}

/** Records a check for the monitor and queues it, unless the previous check is still going (then it is recorded as skipped). */
export async function createCheck(deps: SchedulerDeps, m: MonitorRecord, trigger: 'scheduled' | 'manual', scheduledFor: string | null, now: Date = new Date()): Promise<CheckRecord> {
  const busy = m.currentCheckId ? await deps.monitors.findCheck(m.currentCheckId) : null;
  const overlapping = busy !== null && (busy.status === 'queued' || busy.status === 'running');
  const check = await deps.monitors.createCheck({
    id: randomUUID(),
    monitorId: m.id,
    status: overlapping ? 'skipped_overlap' : 'queued',
    trigger,
    scheduledFor,
    startedAt: null,
    finishedAt: overlapping ? now.toISOString() : null,
    summary: null,
    targetResults: null,
    error: overlapping ? 'The previous check was still running.' : null,
  });
  if (!overlapping) {
    await deps.monitors.updateMonitor(m.id, { currentCheckId: check.id });
    await deps.queues.addMonitor(check.id);
  }
  return check;
}

/** Starts the checks that are due. Safe to run in several processes: claiming a monitor moves its next run forward. */
export async function startDueChecks(deps: SchedulerDeps, now: Date = new Date()): Promise<number> {
  const claimed = await deps.monitors.claimDue(now, 20, (m) => nextRun(m.cron, m.timezone, now));
  for (const m of claimed) await createCheck(deps, m, 'scheduled', m.nextRunAt, now);
  return claimed.length;
}

export interface SchedulerOptions {
  intervalMs?: number;
  /** A check still queued or running after this long is marked failed. */
  maxRuntimeMs?: number;
}

/** Ticks `startDueChecks` and, now and then, applies retention and fails lost checks. Returns a stop function. */
export function startMonitorScheduler(deps: SchedulerDeps, o: SchedulerOptions = {}): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    const housekeeping = ticks++ % 20 === 0;
    const run = async () => {
      await startDueChecks(deps);
      if (housekeeping) {
        await deps.monitors.failStaleChecks(new Date(Date.now() - (o.maxRuntimeMs ?? 3_600_000)));
        await deps.monitors.deleteExpiredChecks(new Date());
      }
    };
    run().catch((err) => console.error('[icecrawl] monitor scheduler failed:', (err as Error).message));
  }, o.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
