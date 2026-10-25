import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IceCrawlError } from '@icecrawl/core';
import { assertUrlAllowed } from '@icecrawl/engines';
import type { JobQueues } from '@icecrawl/queue';
import { createCheck } from '../monitor/scheduler';
import { nextRun, validateSchedule } from '../monitor/schedule';
import type { CheckRecord, MonitorRecord, MonitorStore, MonitorTarget, PageRecord } from '../monitor/types';

export interface MonitorRouteDeps {
  monitors?: MonitorStore | null;
  queues?: JobQueues;
  useAuth: boolean;
  allowPrivateNetworks?: boolean;
  /** Shortest time between two scheduled runs. */
  monitorMinIntervalMinutes?: number;
}

const scrapeOptions = z.record(z.unknown());
const targetSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().uuid().optional(), type: z.literal('scrape'), urls: z.array(z.string().url()).min(1).max(100), scrapeOptions: scrapeOptions.optional() }),
  z.object({ id: z.string().uuid().optional(), type: z.literal('crawl'), url: z.string().url(), crawlOptions: z.record(z.unknown()).optional(), scrapeOptions: scrapeOptions.optional() }),
  z.object({
    id: z.string().uuid().optional(),
    type: z.literal('search'),
    queries: z.array(z.string().min(1).max(256)).min(1).max(12),
    searchWindow: z.enum(['5m', '15m', '1h', '6h', '24h', '7d']).default('24h'),
    maxResults: z.number().int().min(1).max(50).default(10),
    includeDomains: z.array(z.string()).max(50).optional(),
    excludeDomains: z.array(z.string()).max(50).optional(),
  }),
]);
const webhookSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  events: z.array(z.enum(['monitor.page', 'monitor.check.completed'])).optional(),
});
const scheduleSchema = z.object({ cron: z.string().optional(), text: z.string().optional(), timezone: z.string().optional() });
const common = {
  webhook: webhookSchema.optional(),
  notification: z.record(z.unknown()).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  goal: z.string().max(2000).nullable().optional(),
  judgeEnabled: z.boolean().optional(),
};
const createSchema = z.object({ name: z.string().min(1).max(256), schedule: scheduleSchema, targets: z.array(targetSchema).min(1).max(50), ...common });
const patchSchema = z.object({ name: z.string().min(1).max(256).optional(), schedule: scheduleSchema.optional(), targets: z.array(targetSchema).min(1).max(50).optional(), status: z.enum(['active', 'paused']).optional(), ...common });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_STATUS = ['same', 'new', 'changed', 'removed', 'error'] as const;
const CHECK_STATUS = ['queued', 'running', 'completed', 'failed', 'partial', 'skipped_overlap', 'skipped_no_credits'] as const;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new IceCrawlError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const monitorView = (m: MonitorRecord) => ({
  id: m.id,
  name: m.name,
  status: m.status,
  schedule: { cron: m.cron, timezone: m.timezone },
  nextRunAt: m.nextRunAt,
  lastRunAt: m.lastRunAt,
  currentCheckId: m.currentCheckId,
  targets: m.targets,
  ...(m.webhook ? { webhook: m.webhook } : {}),
  ...(m.notification ? { notification: m.notification } : {}),
  retentionDays: m.retentionDays,
  estimatedCreditsPerMonth: null,
  ...(m.lastCheckSummary ? { lastCheckSummary: m.lastCheckSummary } : {}),
  goal: m.goal,
  judgeEnabled: m.judgeEnabled,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

const checkView = (c: CheckRecord) => ({
  id: c.id,
  monitorId: c.monitorId,
  status: c.status,
  trigger: c.trigger,
  scheduledFor: c.scheduledFor,
  startedAt: c.startedAt,
  finishedAt: c.finishedAt,
  estimatedCredits: null,
  reservedCredits: null,
  actualCredits: null,
  billingStatus: 'not_applicable',
  ...(c.summary ? { summary: c.summary } : {}),
  targetResults: c.targetResults,
  notificationStatus: null,
  error: c.error,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const pageView = (p: PageRecord) => ({
  id: p.id,
  targetId: p.targetId,
  url: p.url,
  status: p.status,
  previousScrapeId: p.previousScrapeId,
  currentScrapeId: p.currentScrapeId,
  statusCode: p.statusCode,
  error: p.error,
  metadata: p.metadata,
  diff: p.diff,
  createdAt: p.createdAt,
});

const withIds = (targets: z.infer<typeof targetSchema>[]): MonitorTarget[] => targets.map((t) => ({ ...t, id: t.id ?? randomUUID() }) as MonitorTarget);

export function registerMonitorRoutes(v2: FastifyInstance, deps: MonitorRouteDeps): void {
  const store = (): MonitorStore => {
    if (!deps.monitors || !deps.queues) throw new IceCrawlError('NOT_IMPLEMENTED', 'Monitors are not configured on this server.');
    return deps.monitors;
  };
  const allow = deps.allowPrivateNetworks ?? false;
  const minutes = deps.monitorMinIntervalMinutes ?? 15;

  const checkTargets = (targets: MonitorTarget[]) => {
    for (const t of targets) {
      if (t.type === 'scrape') t.urls.forEach((u) => assertUrlAllowed(u, allow));
      if (t.type === 'crawl') assertUrlAllowed(t.url, allow);
    }
  };
  const find = async (req: FastifyRequest, id: string): Promise<MonitorRecord> => {
    const m = UUID.test(id) ? await store().getMonitor(id) : null;
    if (!m || (deps.useAuth && m.apiKeyId !== req.apiKeyId)) throw new IceCrawlError('NOT_FOUND', 'Monitor not found');
    return m;
  };
  const warnings = (b: { notification?: Record<string, unknown>; judgeEnabled?: boolean }) => [
    ...((b.notification as { email?: { enabled?: boolean } } | undefined)?.email?.enabled ? ['Email notifications are not supported by IceCrawl; use a webhook.'] : []),
    ...(b.judgeEnabled ? ['judgeEnabled is stored but IceCrawl does not judge changes; every change is reported.'] : []),
  ];

  v2.post('/monitor', async (req) => {
    const m = store();
    const b = parse(createSchema, req.body);
    const s = validateSchedule(b.schedule, minutes);
    const targets = withIds(b.targets);
    checkTargets(targets);
    if (b.webhook) assertUrlAllowed(b.webhook.url, allow);
    const created = await m.createMonitor({
      id: randomUUID(),
      apiKeyId: req.apiKeyId,
      name: b.name,
      status: 'active',
      cron: s.cron,
      timezone: s.timezone,
      targets,
      webhook: b.webhook ?? null,
      notification: b.notification ?? null,
      retentionDays: b.retentionDays ?? 30,
      goal: b.goal ?? null,
      judgeEnabled: b.judgeEnabled ?? false,
      nextRunAt: s.first.toISOString(),
    });
    const w = warnings(b);
    return { success: true, data: monitorView(created), ...(w.length > 0 ? { warning: w.join(' ') } : {}) };
  });

  v2.get<{ Querystring: { limit?: string; offset?: string } }>('/monitor', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    return { success: true, data: (await store().listMonitors(req.apiKeyId, limit, offset)).map(monitorView) };
  });

  v2.get<{ Params: { id: string } }>('/monitor/:id', async (req) => ({ success: true, data: monitorView(await find(req, req.params.id)) }));

  v2.patch<{ Params: { id: string } }>('/monitor/:id', async (req) => {
    const cur = await find(req, req.params.id);
    const b = parse(patchSchema, req.body);
    const patch: Partial<MonitorRecord> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.webhook) assertUrlAllowed(b.webhook.url, allow), (patch.webhook = b.webhook);
    if (b.notification !== undefined) patch.notification = b.notification;
    if (b.retentionDays !== undefined) patch.retentionDays = b.retentionDays;
    if (b.goal !== undefined) patch.goal = b.goal;
    if (b.judgeEnabled !== undefined) patch.judgeEnabled = b.judgeEnabled;
    if (b.targets) {
      patch.targets = withIds(b.targets);
      checkTargets(patch.targets);
    }
    const status = b.status ?? cur.status;
    if (b.status) patch.status = b.status;
    if (b.schedule) {
      const s = validateSchedule({ timezone: cur.timezone, ...b.schedule }, minutes);
      patch.cron = s.cron;
      patch.timezone = s.timezone;
    }
    if (b.schedule || (b.status === 'active' && cur.status === 'paused')) {
      patch.nextRunAt = status === 'active' ? (nextRun(patch.cron ?? cur.cron, patch.timezone ?? cur.timezone, new Date())?.toISOString() ?? null) : null;
    }
    if (status === 'paused') patch.nextRunAt = null;
    const updated = await store().updateMonitor(cur.id, patch);
    const w = warnings(b);
    return { success: true, data: monitorView(updated!), ...(w.length > 0 ? { warning: w.join(' ') } : {}) };
  });

  v2.delete<{ Params: { id: string } }>('/monitor/:id', async (req) => {
    const m = await find(req, req.params.id);
    await store().deleteMonitor(m.id);
    return { success: true };
  });

  v2.post<{ Params: { id: string } }>('/monitor/:id/run', async (req) => {
    const m = await find(req, req.params.id);
    store();
    const check = await createCheck({ monitors: deps.monitors!, queues: deps.queues! }, m, 'manual', new Date().toISOString());
    return { success: true, id: check.id, data: checkView(check) };
  });

  v2.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; status?: string } }>('/monitor/:id/checks', async (req) => {
    const m = await find(req, req.params.id);
    const status = req.query.status;
    if (status && !(CHECK_STATUS as readonly string[]).includes(status)) throw new IceCrawlError('VALIDATION', `status must be one of ${CHECK_STATUS.join(', ')}`);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const checks = await store().listChecks(m.id, { limit, offset, status: status as (typeof CHECK_STATUS)[number] | undefined });
    return { success: true, data: checks.map(checkView) };
  });

  v2.get<{ Params: { id: string; checkId: string }; Querystring: { limit?: string; skip?: string; status?: string } }>('/monitor/:id/checks/:checkId', async (req) => {
    const m = await find(req, req.params.id);
    const check = UUID.test(req.params.checkId) ? await store().getCheck(m.id, req.params.checkId) : null;
    if (!check) throw new IceCrawlError('NOT_FOUND', 'Check not found');
    const status = req.query.status;
    if (status && !(PAGE_STATUS as readonly string[]).includes(status)) throw new IceCrawlError('VALIDATION', `status must be one of ${PAGE_STATUS.join(', ')}`);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
    const skip = Math.max(0, Number(req.query.skip ?? 0) || 0);
    const rows = await store().listPages(check.id, { skip, limit: limit + 1, status: status as (typeof PAGE_STATUS)[number] | undefined });
    const pages = rows.slice(0, limit);
    const next = rows.length > limit ? `${req.protocol}://${req.headers.host}/v2/monitor/${m.id}/checks/${check.id}?skip=${skip + limit}&limit=${limit}${status ? `&status=${status}` : ''}` : null;
    return { success: true, next, data: { ...checkView(check), pages: pages.map(pageView), next } };
  });
}
