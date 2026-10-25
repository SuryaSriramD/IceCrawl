import cronParser from 'cron-parser';
import { IceCrawlError } from '@icecrawl/core';

/** The next run strictly after `from`, or null when the expression never fires again. */
export function nextRun(cron: string, timezone: string, from: Date): Date | null {
  try {
    return cronParser.parseExpression(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Checks a schedule and returns its first run. Natural-language schedules are not supported (use `cron`),
 * and a schedule that runs more often than `minIntervalMinutes` is refused so a monitor cannot hammer a site.
 */
export function validateSchedule(s: { cron?: string; text?: string; timezone?: string }, minIntervalMinutes: number, from: Date = new Date()): { cron: string; timezone: string; first: Date } {
  if (!s.cron) {
    throw new IceCrawlError('VALIDATION', s.text ? 'schedule.text is not supported; give a 5-field cron expression in schedule.cron.' : 'schedule.cron is required.');
  }
  const timezone = s.timezone ?? 'UTC';
  let it;
  try {
    it = cronParser.parseExpression(s.cron, { currentDate: from, tz: timezone });
  } catch {
    throw new IceCrawlError('VALIDATION', 'schedule.cron or schedule.timezone is not valid (use a 5-field cron expression and an IANA time zone).');
  }
  if (s.cron.trim().split(/\s+/).length !== 5) throw new IceCrawlError('VALIDATION', 'schedule.cron must have 5 fields (minute hour day month weekday).');
  const first = it.next().toDate();
  // look at a day of runs, not just two: an irregular cron such as `0,20 * * * *` has uneven gaps
  let closest = Infinity;
  let prev = first;
  for (let i = 0; i < 48 && it.hasNext(); i++) {
    const next = it.next().toDate();
    closest = Math.min(closest, next.getTime() - prev.getTime());
    prev = next;
  }
  if (closest < minIntervalMinutes * 60_000) {
    throw new IceCrawlError('VALIDATION', `schedule.cron runs more often than every ${minIntervalMinutes} minutes, which this server does not allow (ICECRAWL_MONITOR_MIN_INTERVAL_MINUTES).`);
  }
  return { cron: s.cron, timezone, first };
}
