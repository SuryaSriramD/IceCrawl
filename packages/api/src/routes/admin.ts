import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IceCrawlError } from '@icecrawl/core';
import { sha256Hex } from '@icecrawl/trust';
import type { Store } from '../store/types';

export interface AdminRouteDeps {
  store: Store;
  /** The secret that allows key management; the routes answer 404 when it is not set. */
  adminToken?: string;
}

const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const createSchema = z.object({ name: z.string().trim().min(1).max(100).default('default') });

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(sha256Hex(given));
  const b = Buffer.from(sha256Hex(expected));
  return timingSafeEqual(a, b);
};

/**
 * Key management for the dashboard: create, list and revoke API keys. It is guarded by one admin token set by the operator
 * (`ICECRAWL_ADMIN_TOKEN`), which is not an API key: a leaked API key cannot make more keys. Wrong tokens are counted per
 * client address, and ten in a minute lock that address out for the rest of the minute.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  if (!deps.adminToken) return;
  const expected = deps.adminToken;
  const failures = new Map<string, { count: number; since: number }>();

  app.register(
    async (admin) => {
      admin.addHook('preHandler', async (req: FastifyRequest) => {
        const now = Date.now();
        const seen = failures.get(req.ip);
        if (seen && now - seen.since > WINDOW_MS) failures.delete(req.ip);
        const current = failures.get(req.ip);
        if (current && current.count >= MAX_FAILURES) throw new IceCrawlError('RATE_LIMITED', 'Too many wrong admin tokens; wait a minute.');
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!match || !sameSecret(match[1], expected)) {
          failures.set(req.ip, { count: (current?.count ?? 0) + 1, since: current?.since ?? now });
          throw new IceCrawlError('UNAUTHORIZED', 'Missing or wrong admin token');
        }
        failures.delete(req.ip);
      });

      admin.get('/keys', async () => ({ success: true, data: { keys: await deps.store.listApiKeys() } }));

      admin.post('/keys', async (req) => {
        const parsed = createSchema.safeParse(req.body ?? {});
        if (!parsed.success) throw new IceCrawlError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
        const key = `ic-${randomBytes(24).toString('hex')}`;
        const id = randomUUID();
        await deps.store.createApiKey({ id, hash: sha256Hex(key), name: parsed.data.name });
        // the key is shown once: only its hash is stored
        return { success: true, data: { id, name: parsed.data.name, key } };
      });

      admin.delete<{ Params: { id: string } }>('/keys/:id', async (req) => {
        if (!UUID.test(req.params.id) || !(await deps.store.listApiKeys()).some((k) => k.id === req.params.id)) throw new IceCrawlError('NOT_FOUND', 'Key not found');
        await deps.store.revokeApiKey(req.params.id);
        return { success: true };
      });
    },
    { prefix: '/admin' },
  );
}
