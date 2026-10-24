import type { NormalizedScrape } from '@icecrawl/core';
import type { Engine } from '@icecrawl/engines';
import { runScrape, type ScrapeRun, type ScraperConfig } from '@icecrawl/scraper';
import { signReceipt, type PrivateSigningKey } from '@icecrawl/trust';
import { buildResponse } from './response';
import type { SnapshotStore, Store } from './store/types';

export interface ScrapeServiceDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  signer?: PrivateSigningKey;
}

export async function scrapeAndPersist(
  deps: ScrapeServiceDeps,
  normalized: NormalizedScrape,
  ctx: { apiKeyId: string | null; jobId?: string | null },
): Promise<{ run: ScrapeRun; status: number; payload: Record<string, unknown> }> {
  const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
  const { status, payload } = buildResponse(run, normalized.formats);
  const snapshot = await deps.snapshots.put(run.snapshot.bytes);
  if (run.screenshot) await deps.snapshots.put(run.screenshot);
  const signature = deps.signer ? signReceipt(run.receipt, deps.signer) : null;
  await deps.store.saveScrape(
    {
      id: run.id,
      apiKeyId: ctx.apiKeyId,
      jobId: ctx.jobId ?? null,
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
  return { run, status, payload };
}
