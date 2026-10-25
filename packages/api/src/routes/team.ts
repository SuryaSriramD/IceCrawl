import type { FastifyInstance } from 'fastify';
import { IceCrawlError } from '@icecrawl/core';
import { lastMonths, type Store } from '../store/types';

export interface TeamRouteDeps {
  store: Store;
  /** How many jobs the workers run at once (reported as maxConcurrency). */
  workerConcurrency?: number;
}

/** IceCrawl does not charge: balances are reported as this many units so clients that check them keep working. */
export const UNLIMITED = 1_000_000_000;

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

/** Firecrawl's /team endpoints, answered with metering only (no billing, no plans). */
export function registerTeamRoutes(v2: FastifyInstance, deps: TeamRouteDeps & { useAuth: boolean }): void {
  const scope = (req: { apiKeyId: string | null }) => req.apiKeyId;
  // shortcut: one small query per month; group by month in SQL if this endpoint ever shows up in profiles.
  const monthly = async (apiKeyId: string | null) =>
    Promise.all(
      lastMonths(12).map(async (m) => ({
        start: m.start.toISOString(),
        end: m.end.toISOString(),
        ...(await deps.store.usageBetween(apiKeyId, m.start, m.end)),
      })),
    );

  v2.get('/team/credit-usage', async (req) => {
    const start = monthStart(new Date());
    const used = await deps.store.usageBetween(scope(req), start, nextMonth(start));
    return {
      success: true,
      data: {
        remainingCredits: UNLIMITED,
        planCredits: UNLIMITED,
        billingPeriodStart: start.toISOString(),
        billingPeriodEnd: nextMonth(start).toISOString(),
        usedCredits: used.scrapes,
      },
    };
  });

  v2.get('/team/token-usage', async (req) => {
    const start = monthStart(new Date());
    const used = await deps.store.usageBetween(scope(req), start, nextMonth(start));
    return {
      success: true,
      data: {
        remainingTokens: UNLIMITED,
        planTokens: UNLIMITED,
        billingPeriodStart: start.toISOString(),
        billingPeriodEnd: nextMonth(start).toISOString(),
        usedTokens: used.tokens,
      },
    };
  });

  v2.get<{ Querystring: { byApiKey?: string } }>('/team/credit-usage/historical', async (req) => {
    const months = await monthly(scope(req));
    return {
      success: true,
      periods: months.map((m) => ({
        startDate: m.start,
        endDate: m.end,
        apiKey: req.query.byApiKey === 'true' ? scope(req) : null,
        totalCredits: m.scrapes,
      })),
    };
  });

  v2.get<{ Querystring: { byApiKey?: string } }>('/team/token-usage/historical', async (req) => {
    const months = await monthly(scope(req));
    return {
      success: true,
      periods: months.map((m) => ({
        startDate: m.start,
        endDate: m.end,
        apiKey: req.query.byApiKey === 'true' ? scope(req) : null,
        totalTokens: m.tokens,
      })),
    };
  });

  v2.get('/team/queue-status', async (req) => {
    const active = await deps.store.listActiveJobs(scope(req));
    return {
      success: true,
      jobsInQueue: active.length,
      activeJobsInQueue: active.length,
      waitingJobsInQueue: 0,
      maxConcurrency: deps.workerConcurrency ?? 0,
      mostRecentSuccess: await deps.store.latestScrapeAt(scope(req)),
    };
  });

  v2.get<{ Querystring: { endpoint?: string; limit?: string; cursor?: string } }>('/team/activity', async (req) => {
    if (req.query.cursor !== undefined && Number.isNaN(Date.parse(req.query.cursor))) {
      throw new IceCrawlError('VALIDATION', 'cursor must be a timestamp returned by a previous call');
    }
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? '20', 10) || 20));
    const rows = await deps.store.recentScrapes(scope(req), { limit: limit + 1, before: req.query.cursor, endpoint: req.query.endpoint });
    const page = rows.slice(0, limit);
    return {
      success: true,
      data: page.map((r) => ({ id: r.id, endpoint: r.endpoint, api_version: 'v2', created_at: r.createdAt, target: r.url })),
      cursor: rows.length > limit ? (page[page.length - 1]?.createdAt ?? null) : null,
      has_more: rows.length > limit,
    };
  });
}
