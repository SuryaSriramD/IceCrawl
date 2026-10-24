import { createHmac, randomUUID } from 'node:crypto';
import { assertUrlAllowed, createSafeLookup } from '@icecrawl/engines';
import { PermanentError, type JobQueues, type WebhookJobData } from '@icecrawl/queue';
import { Agent, request } from 'undici';
import type { JobRecord } from '../store/types';

export type WebhookEvent = 'started' | 'page' | 'completed' | 'failed';

export interface WebhookPayload {
  success: boolean;
  type: string;
  id: string;
  webhookId: string;
  data: unknown[];
  metadata: Record<string, unknown>;
  error?: string;
}

const PREFIX = { crawl: 'crawl', batch: 'batch_scrape' } as const;

/** Batch scrapes have no failed event; a failed batch is reported as completed with success false. */
const effectiveEvent = (job: JobRecord, event: WebhookEvent): WebhookEvent =>
  job.type === 'batch' && event === 'failed' ? 'completed' : event;

export function buildWebhookPayload(
  job: JobRecord,
  event: WebhookEvent,
  data: unknown[],
  o: { success?: boolean; error?: string } = {},
): WebhookPayload {
  const payload: WebhookPayload = {
    success: o.success ?? event !== 'failed',
    type: `${PREFIX[job.type]}.${effectiveEvent(job, event)}`,
    id: job.id,
    webhookId: randomUUID(),
    data,
    metadata: job.webhook?.metadata ?? {},
  };
  if (o.error !== undefined) payload.error = o.error;
  return payload;
}

export async function sendWebhook(
  queues: JobQueues,
  job: JobRecord,
  event: WebhookEvent,
  data: unknown[],
  o: { success?: boolean; error?: string } = {},
): Promise<void> {
  const cfg = job.webhook;
  if (!cfg) return;
  const wanted = cfg.events ?? ['started', 'page', 'completed', 'failed'];
  if (!wanted.includes(effectiveEvent(job, event))) return;
  const payload = buildWebhookPayload(job, event, data, o);
  await queues.addWebhook({
    jobId: job.id,
    webhookId: payload.webhookId,
    url: cfg.url,
    headers: cfg.headers ?? {},
    body: JSON.stringify(payload),
  });
}

export const signBody = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export interface DeliveryDeps {
  secret: string | null;
  allowPrivate: boolean;
  timeoutMs?: number;
}

const RESERVED = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'x-icecrawl-signature', 'x-firecrawl-signature', 'x-icecrawl-webhook-id', 'user-agent']);

export async function deliverWebhook(deps: DeliveryDeps, data: WebhookJobData): Promise<void> {
  try {
    assertUrlAllowed(data.url, deps.allowPrivate);
  } catch (err) {
    throw new PermanentError(`webhook URL not allowed: ${(err as Error).message}`);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.headers)) if (!RESERVED.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  headers['content-type'] = 'application/json';
  headers['user-agent'] = 'IceCrawl-Webhook/0.1';
  headers['x-icecrawl-webhook-id'] = data.webhookId;
  if (deps.secret) {
    const sig = signBody(deps.secret, data.body);
    headers['x-icecrawl-signature'] = sig;
    headers['x-firecrawl-signature'] = sig;
  }

  const timeout = deps.timeoutMs ?? 10_000;
  const agent = new Agent({
    connect: { lookup: createSafeLookup(deps.allowPrivate) as never },
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  try {
    const res = await request(data.url, { method: 'POST', headers, body: data.body, dispatcher: agent, signal: AbortSignal.timeout(timeout) });
    await res.body.dump();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`webhook responded with HTTP ${res.statusCode}`);
  } finally {
    await agent.close().catch(() => undefined);
  }
}
