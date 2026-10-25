import { IceCrawlError, type NormalizedScrape, type TrustBlock } from '@icecrawl/core';
import type { Engine } from '@icecrawl/engines';
import { enforceGrounding, extractStructured, summarizePage, type LlmClient } from '@icecrawl/extract';
import { runScrape, type ScrapeRun, type ScraperConfig } from '@icecrawl/scraper';
import { signReceipt, type PrivateSigningKey } from '@icecrawl/trust';
import { buildResponse } from './response';
import type { SnapshotStore, Store } from './store/types';

export interface ExtractionDeps {
  llm: LlmClient | null;
  maxInputChars: number;
  maxOutputTokens: number;
}

export const LLM_HELP =
  'No language model is configured. Set ICECRAWL_LLM_PROVIDER, ICECRAWL_LLM_MODEL and ICECRAWL_LLM_API_KEY (see the README).';

export interface ScrapeServiceDeps {
  store: Store;
  snapshots: SnapshotStore;
  engines: readonly Engine[];
  scraper: ScraperConfig;
  signer?: PrivateSigningKey;
  extraction?: ExtractionDeps;
}

/** Adds the model-written formats (json, summary) to the response data of an accepted scrape. */
async function addModelOutputs(
  deps: ScrapeServiceDeps,
  llm: LlmClient,
  normalized: NormalizedScrape,
  run: ScrapeRun,
  data: Record<string, unknown> & { trust: TrustBlock },
): Promise<void> {
  const ex = deps.extraction as ExtractionDeps;
  const opts = { llm, maxInputChars: ex.maxInputChars, maxOutputTokens: ex.maxOutputTokens };
  const source = { url: run.finalUrl, markdown: run.markdown };
  if (normalized.json) {
    const r = await extractStructured(opts, { sources: [source], prompt: normalized.json.prompt, schema: normalized.json.schema });
    enforceGrounding(r.report, deps.scraper.strict);
    data.json = r.data;
    data.trust.extraction = r.report;
  }
  if (normalized.formats.includes('summary')) data.summary = (await summarizePage(opts, source)).summary;
}

export async function scrapeAndPersist(
  deps: ScrapeServiceDeps,
  normalized: NormalizedScrape,
  ctx: { apiKeyId: string | null; jobId?: string | null },
): Promise<{ run: ScrapeRun; status: number; payload: Record<string, unknown> }> {
  const wantsModel = normalized.json !== null || normalized.formats.includes('summary');
  const llm = deps.extraction?.llm ?? null;
  if (wantsModel && !llm) throw new IceCrawlError('LLM_NOT_CONFIGURED', LLM_HELP);

  const run = await runScrape({ engines: deps.engines, config: deps.scraper }, normalized);
  let { status, payload } = buildResponse(run, normalized.formats);
  if (wantsModel && llm && payload.success === true) {
    try {
      await addModelOutputs(deps, llm, normalized, run, payload.data as Record<string, unknown> & { trust: TrustBlock });
    } catch (err) {
      if (!(err instanceof IceCrawlError)) throw err;
      const trust = (payload.data as { trust: TrustBlock }).trust;
      status = err.status;
      payload = { success: false, code: err.code, error: err.message, trust };
    }
  }

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
