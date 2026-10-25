import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IceCrawlError } from '@icecrawl/core';
import type { ExecResult, SessionManager } from '@icecrawl/engines';
import type { Store } from '../store/types';

export interface InteractRouteDeps {
  store: Store;
  useAuth: boolean;
  sessions?: SessionManager | null;
}

const createSchema = z
  .object({
    ttl: z.number().int().min(30).max(3600).default(300),
    activityTtl: z.number().int().min(10).max(3600).optional(),
    streamWebView: z.boolean().optional(),
    blockAds: z.boolean().optional(),
    profile: z.unknown().optional(),
    location: z.unknown().optional(),
  })
  .passthrough();

const executeSchema = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(['python', 'node', 'bash']).default('node'),
  timeout: z.number().int().min(1).max(300).default(30),
  origin: z.string().optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new IceCrawlError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const outcome = (r: ExecResult) => ({
  success: r.exitCode === 0 && !r.killed,
  stdout: r.stdout,
  result: r.result,
  stderr: r.stderr,
  exitCode: r.exitCode,
  killed: r.killed,
  error: r.killed ? 'The code ran past its timeout and was stopped.' : r.exitCode === 0 ? null : (r.stderr?.split('\n')[0] ?? 'The code failed.'),
});

export function registerInteractRoutes(v2: FastifyInstance, deps: InteractRouteDeps): void {
  const manager = (): SessionManager => {
    if (!deps.sessions) throw new IceCrawlError('NOT_IMPLEMENTED', 'Interact sessions need the browser engine, which is turned off on this server.');
    return deps.sessions;
  };
  const owner = (apiKeyId: string | null) => apiKeyId ?? 'anonymous';
  // the browser session of a scrape is created on first use and remembered here
  const byScrape = new Map<string, string>();

  v2.post('/interact', async (req) => {
    const o = parse(createSchema, req.body);
    const s = await manager().create({ ownerKey: owner(req.apiKeyId), ttlMs: o.ttl * 1000, activityTtlMs: o.activityTtl ? o.activityTtl * 1000 : undefined });
    const ignored = ['profile', 'location', 'blockAds', 'streamWebView'].filter((k) => o[k as keyof typeof o] !== undefined);
    return { success: true, id: s.id, expiresAt: s.expiresAt, ...(ignored.length > 0 ? { warning: `Ignored interact options: ${ignored.join(', ')}.` } : {}) };
  });

  v2.get('/interact', async (req) => ({
    success: true,
    sessions: manager()
      .list(owner(req.apiKeyId))
      .map((s) => ({ id: s.id, status: s.status, streamWebView: false, createdAt: s.createdAt, lastActivity: s.lastActivity })),
  }));

  v2.post<{ Params: { id: string } }>('/interact/:id/execute', async (req) => {
    const o = parse(executeSchema, req.body);
    return outcome(await manager().execute(req.params.id, owner(req.apiKeyId), { code: o.code, language: o.language, timeoutMs: o.timeout * 1000 }));
  });

  v2.delete<{ Params: { id: string } }>('/interact/:id', async (req) => {
    const { durationMs } = await manager().destroy(req.params.id, owner(req.apiKeyId));
    return { success: true, sessionDurationMs: durationMs };
  });

  // The browser session behind a scrape: opens the scrape's final page the first time code runs.
  v2.post<{ Params: { id: string } }>('/scrape/:id/interact', async (req) => {
    const o = parse(executeSchema, req.body);
    const m = manager();
    const key = owner(req.apiKeyId);
    const rec = UUID.test(req.params.id) ? await deps.store.getScrape(req.params.id) : null;
    if (!rec || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) throw new IceCrawlError('NOT_FOUND', 'Scrape not found');
    let sessionId = byScrape.get(rec.id);
    if (!sessionId || !m.has(sessionId, key)) {
      sessionId = (await m.create({ ownerKey: key, ttlMs: 300_000, url: rec.finalUrl })).id;
      byScrape.set(rec.id, sessionId);
    }
    const r = outcome(await m.execute(sessionId, key, { code: o.code, language: o.language, timeoutMs: o.timeout * 1000 }));
    return { ...r, output: r.result ?? r.stdout };
  });

  v2.delete<{ Params: { id: string } }>('/scrape/:id/interact', async (req) => {
    const sessionId = byScrape.get(req.params.id);
    if (!sessionId) throw new IceCrawlError('NOT_FOUND', 'This scrape has no interact session');
    byScrape.delete(req.params.id);
    await manager().destroy(sessionId, owner(req.apiKeyId));
    return { success: true };
  });
}
