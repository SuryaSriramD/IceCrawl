import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryQueues, PermanentError } from '@icecrawl/queue';
import { buildWebhookPayload, deliverWebhook, sendWebhook, signBody } from '../src/jobs/webhooks';
import type { JobRecord } from '../src/store/types';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'crawl',
  apiKeyId: null,
  status: 'scraping',
  request: {},
  webhook: { url: 'https://hooks.example.com/x', metadata: { run: 7 } },
  limit: 10,
  total: 0,
  completed: 0,
  failed: 0,
  createdAt: new Date().toISOString(),
  completedAt: null,
  expiresAt: new Date(Date.now() + 1000).toISOString(),
  result: null,
  tokensUsed: null,
  ...over,
});

describe('buildWebhookPayload', () => {
  it('uses the Firecrawl envelope with a type prefix per job type', () => {
    const p = buildWebhookPayload(job(), 'page', [{ markdown: '# hi' }]);
    expect(p).toMatchObject({ success: true, type: 'crawl.page', id: job().id, data: [{ markdown: '# hi' }], metadata: { run: 7 } });
    expect(p.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.error).toBeUndefined();
    expect(buildWebhookPayload(job({ type: 'batch' }), 'started', []).type).toBe('batch_scrape.started');
  });

  it('carries failure details and maps a failed batch to batch_scrape.completed', () => {
    expect(buildWebhookPayload(job(), 'failed', [], { success: false, error: 'boom' })).toMatchObject({ type: 'crawl.failed', success: false, error: 'boom' });
    expect(buildWebhookPayload(job({ type: 'batch' }), 'failed', [], { success: false })).toMatchObject({ type: 'batch_scrape.completed', success: false });
    expect(buildWebhookPayload(job(), 'page', [], { success: false, error: 'robots' })).toMatchObject({ success: false, error: 'robots' });
  });

  it('defaults metadata to an empty object', () => {
    expect(buildWebhookPayload(job({ webhook: { url: 'https://h.example/x' } }), 'started', []).metadata).toEqual({});
  });
});

describe('sendWebhook', () => {
  it('queues a delivery with the serialized payload and the configured headers', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ webhook: { url: 'https://hooks.example.com/x', headers: { 'X-Mine': '1' } } }), 'started', []);
    expect(q.webhooks).toHaveLength(1);
    const d = q.webhooks[0];
    expect(d).toMatchObject({ jobId: job().id, url: 'https://hooks.example.com/x', headers: { 'X-Mine': '1' } });
    expect(JSON.parse(d.body)).toMatchObject({ type: 'crawl.started', webhookId: d.webhookId });
  });

  it('does nothing without a webhook or for filtered events', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ webhook: null }), 'started', []);
    await sendWebhook(q, job({ webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'page', []);
    expect(q.webhooks).toHaveLength(0);
    await sendWebhook(q, job({ webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'completed', []);
    expect(q.webhooks).toHaveLength(1);
  });

  it('applies the events filter to the mapped event for failed batches', async () => {
    const q = new MemoryQueues();
    await sendWebhook(q, job({ type: 'batch', webhook: { url: 'https://h.example/x', events: ['completed'] } }), 'failed', [], { success: false });
    expect(q.webhooks).toHaveLength(1);
  });
});

describe('signBody', () => {
  it('is HMAC-SHA256 over the raw body in sha256=<hex> form', () => {
    expect(signBody('secret', '{"a":1}')).toBe(`sha256=${createHmac('sha256', 'secret').update('{"a":1}').digest('hex')}`);
  });
});

describe('deliverWebhook', () => {
  let server: Server;
  let port: number;
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const data = (over: Record<string, unknown> = {}) => ({
    jobId: 'j',
    webhookId: 'wh-1',
    url: `http://127.0.0.1:${port}/hook`,
    headers: {},
    body: '{"type":"crawl.page"}',
    ...over,
  });

  it('POSTs the exact body with both signature headers and the webhook id', async () => {
    received.length = 0;
    await deliverWebhook({ secret: 's3cret', allowPrivate: true }, data({ headers: { 'X-Custom': 'yes' } }));
    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.body).toBe('{"type":"crawl.page"}');
    const expected = signBody('s3cret', r.body);
    expect(r.headers['x-icecrawl-signature']).toBe(expected);
    expect(r.headers['x-firecrawl-signature']).toBe(expected);
    expect(r.headers['x-icecrawl-webhook-id']).toBe('wh-1');
    expect(r.headers['x-custom']).toBe('yes');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['user-agent']).toContain('IceCrawl-Webhook');
  });

  it('sends no signature when no secret is configured', async () => {
    received.length = 0;
    await deliverWebhook({ secret: null, allowPrivate: true }, data());
    expect(received[0].headers['x-icecrawl-signature']).toBeUndefined();
  });

  it('does not let user headers override signature or framing headers', async () => {
    received.length = 0;
    await deliverWebhook(
      { secret: 'k', allowPrivate: true },
      data({ headers: { 'X-IceCrawl-Signature': 'forged', 'X-Firecrawl-Signature': 'forged', 'Content-Length': '1', Host: 'evil.example' } }),
    );
    const r = received[0];
    expect(r.headers['x-icecrawl-signature']).toBe(signBody('k', r.body));
    expect(r.headers['x-firecrawl-signature']).toBe(signBody('k', r.body));
    expect(r.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('throws a retryable error on a non-2xx response', async () => {
    status = 500;
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data())).rejects.toThrow(/500/);
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data())).rejects.not.toBeInstanceOf(PermanentError);
    status = 200;
  });

  it('throws a retryable error when the receiver is unreachable', async () => {
    await expect(deliverWebhook({ secret: null, allowPrivate: true, timeoutMs: 1000 }, data({ url: 'http://127.0.0.1:1/x' }))).rejects.not.toBeInstanceOf(PermanentError);
  });

  it('refuses private targets as a permanent failure', async () => {
    await expect(deliverWebhook({ secret: null, allowPrivate: false }, data())).rejects.toBeInstanceOf(PermanentError);
    await expect(deliverWebhook({ secret: null, allowPrivate: false }, data({ url: 'http://169.254.169.254/x' }))).rejects.toBeInstanceOf(PermanentError);
    await expect(deliverWebhook({ secret: null, allowPrivate: true }, data({ url: 'ftp://example.com/x' }))).rejects.toBeInstanceOf(PermanentError);
  });
});
