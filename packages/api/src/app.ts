import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { IceCrawlError, normalizeScrapeRequest, type SignedReceipt } from '@icecrawl/core';
import type { Engine } from '@icecrawl/engines';
import { runScrape, type ScraperConfig } from '@icecrawl/scraper';
import { sha256Hex, signReceipt, type PrivateSigningKey } from '@icecrawl/trust';
import { buildResponse } from './response';
import { snapshotKey, type SnapshotStore, type Store } from './store/types';

export interface AppDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  useAuth: boolean;
  signer?: PrivateSigningKey;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLANNED: Record<string, number> = {
  crawl: 3,
  map: 3,
  batch: 3,
  search: 5,
  extract: 5,
  parse: 7,
  interact: 8,
  agent: 8,
  monitor: 9,
};

function errorHandler(err: unknown, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof IceCrawlError) {
    return reply.status(err.status).send({ success: false, code: err.code, error: err.message });
  }
  const fe = err as { statusCode?: number; message?: string };
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ success: false, code: 'VALIDATION', error: fe.message ?? 'Bad request' });
  }
  console.error(err);
  return reply.status(500).send({ success: false, code: 'INTERNAL', error: 'Internal server error' });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.decorateRequest('apiKeyId', null);
  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler((req, reply) => {
    const segment = req.url.split('?')[0].split('/')[2];
    if (req.url.startsWith('/v2/') && segment && PLANNED[segment] !== undefined) {
      return reply.status(501).send({
        success: false,
        code: 'NOT_IMPLEMENTED',
        error: `/v2/${segment} is planned for phase ${PLANNED[segment]} of the IceCrawl roadmap.`,
      });
    }
    return reply.status(404).send({ success: false, code: 'NOT_FOUND', error: 'Route not found' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/.well-known/icecrawl-keys.json', async () => ({ keys: await deps.store.listPublicKeys() }));

  app.register(
    async (v2) => {
      v2.addHook('preHandler', async (req) => {
        if (!deps.useAuth) return;
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!match) throw new IceCrawlError('UNAUTHORIZED', 'Missing bearer token');
        const row = await deps.store.findApiKeyByHash(sha256Hex(match[1]));
        if (!row || row.revoked) throw new IceCrawlError('UNAUTHORIZED', 'Invalid API key');
        req.apiKeyId = row.id;
      });

      v2.post('/scrape', async (req, reply) => {
        const normalized = normalizeScrapeRequest(req.body);
        const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
        const { status, payload } = buildResponse(run, normalized.formats);
        const snapshot = await deps.snapshots.put(run.snapshot.bytes);
        if (run.screenshot) await deps.snapshots.put(run.screenshot);
        const signature = deps.signer ? signReceipt(run.receipt, deps.signer) : null;
        await deps.store.saveScrape(
          {
            id: run.id,
            apiKeyId: req.apiKeyId,
            url: run.requestedUrl,
            finalUrl: run.finalUrl,
            verdict: run.verdict,
            confidence: run.confidence,
            engine: run.engine,
            statusCode: run.statusCode,
            markdown: run.markdown,
            metadata: { title: run.title, description: run.description, language: run.language, contentType: run.contentType },
            response: payload,
            createdAt: new Date().toISOString(),
          },
          run.receipt,
          snapshot,
          signature,
        );
        return reply.status(status).send(payload);
      });

      v2.get<{ Params: { id: string } }>('/scrape/:id', async (req) => {
        const rec = UUID.test(req.params.id) ? await deps.store.getScrape(req.params.id) : null;
        if (!rec || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) throw new IceCrawlError('NOT_FOUND', 'Scrape not found');
        return rec.response;
      });

      const loadReceipt = async (req: FastifyRequest, id: string): Promise<SignedReceipt> => {
        const rec = UUID.test(id) ? await deps.store.getScrape(id) : null;
        const signed = rec ? await deps.store.getSignedReceipt(rec.id) : null;
        if (!rec || !signed || (deps.useAuth && rec.apiKeyId !== req.apiKeyId)) {
          throw new IceCrawlError('NOT_FOUND', 'Receipt not found');
        }
        return signed;
      };

      v2.get<{ Params: { id: string } }>('/receipts/:id', async (req) => {
        const { receipt, signature } = await loadReceipt(req, req.params.id);
        return { success: true, data: receipt, signature };
      });

      v2.get<{ Params: { id: string } }>('/receipts/:id/snapshot', async (req, reply) => {
        const { receipt } = await loadReceipt(req, req.params.id);
        const bytes = receipt.htmlSha256 ? await deps.snapshots.get(snapshotKey(receipt.htmlSha256)) : null;
        if (!bytes) throw new IceCrawlError('NOT_FOUND', 'Snapshot not found');
        return reply.header('content-type', receipt.contentType || 'application/octet-stream').send(Buffer.from(bytes));
      });

      v2.get<{ Params: { id: string } }>('/receipts/:id/screenshot', async (req, reply) => {
        const { receipt } = await loadReceipt(req, req.params.id);
        const bytes = receipt.screenshotSha256 ? await deps.snapshots.get(snapshotKey(receipt.screenshotSha256)) : null;
        if (!bytes) throw new IceCrawlError('NOT_FOUND', 'Screenshot not found');
        return reply.header('content-type', 'image/png').send(Buffer.from(bytes));
      });
    },
    { prefix: '/v2' },
  );

  return app;
}
