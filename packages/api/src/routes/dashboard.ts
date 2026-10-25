import type { FastifyInstance } from 'fastify';
import { DASHBOARD_CSP, loadDashboard } from '@icecrawl/dashboard';

/** Serves the dashboard at /dashboard. It is static: the page asks for an API key and then calls the normal /v2 routes. */
export function registerDashboardRoutes(app: FastifyInstance): void {
  const files = loadDashboard();
  app.get('/', async (_req, reply) => reply.redirect('/dashboard/'));
  app.get<{ Params: { '*': string } }>('/dashboard/*', async (req, reply) => {
    const file = files.get(req.params['*']);
    if (!file) return reply.status(404).send({ success: false, code: 'NOT_FOUND', error: 'Route not found' });
    return reply
      .header('content-type', file.type)
      .header('content-security-policy', DASHBOARD_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .send(file.body);
  });
  app.get('/dashboard', async (_req, reply) => reply.redirect('/dashboard/'));
}
