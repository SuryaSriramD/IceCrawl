import { randomUUID } from 'node:crypto';
import { featureSet, type Engine, type EngineResult, type SearchProvider } from '@icecrawl/engines';
import { sha256Hex, type PrivateSigningKey } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import type { ExtractionDeps } from '../src/scrape-service';
import { MemorySnapshotStore, MemoryStore } from '../src/store/memory';

export const article = `<article><h1>Hello world</h1>${'<p>Some real content about things that matter. </p>'.repeat(30)}</article>`;
export const okHtml = `<html lang="en"><head><title>Test Page</title><meta name="description" content="d"></head><body>${article}<a href="/next">next</a></body></html>`;

export function fakeEngine(result: Partial<EngineResult> & { html?: string }): Engine {
  const { html, ...rest } = result;
  return {
    name: 'fake',
    quality: 10,
    features: featureSet(['skipTlsVerification']),
    maxReasonableTimeMs: 1000,
    scrape: async () => ({
      finalUrl: 'https://example.com/final',
      statusCode: 200,
      headers: {},
      body: Buffer.from(html ?? okHtml),
      contentType: 'text/html; charset=utf-8',
      truncated: false,
      ...rest,
    }),
  };
}

export async function makeApp(
  opts: { engine?: Engine; useAuth?: boolean; strict?: boolean; injection?: 'off' | 'flag' | 'quarantine'; signer?: PrivateSigningKey; extraction?: ExtractionDeps; search?: SearchProvider | null; searchMaxScrape?: number; maxUploadBytes?: number } = {},
) {
  const store = new MemoryStore();
  const snapshots = new MemorySnapshotStore();
  const keyId = randomUUID();
  await store.createApiKey({ id: keyId, hash: sha256Hex('ic-test'), name: 'test' });
  const app = buildApp({
    store,
    snapshots,
    engines: [opts.engine ?? fakeEngine({})],
    scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: opts.strict ?? false, injection: opts.injection },
    useAuth: opts.useAuth ?? true,
    signer: opts.signer,
    extraction: opts.extraction,
    search: opts.search,
    searchMaxScrape: opts.searchMaxScrape,
    maxUploadBytes: opts.maxUploadBytes,
  });
  return { app, store, snapshots, keyId, auth: { authorization: 'Bearer ic-test' } };
}
