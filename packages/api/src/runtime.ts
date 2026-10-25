import { createPlaywrightEngine, createSearxngProvider, fetchEngine, type Engine, type PlaywrightEngine, type SearchProvider } from '@icecrawl/engines';
import { createLlmClient } from '@icecrawl/extract';
import { BullQueues } from '@icecrawl/queue';
import type { PrivateSigningKey } from '@icecrawl/trust';
import type postgres from 'postgres';
import type { AppConfig } from './config';
import { makeFetcher } from './jobs/fetcher';
import type { JobDeps } from './jobs/processor';
import type { DeliveryDeps } from './jobs/webhooks';
import type { ExtractionDeps } from './scrape-service';
import { loadOrCreateSigningKey } from './signing';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';
import type { SnapshotStore, Store } from './store/types';
import { loadOrCreateWebhookSecret } from './webhook-secret';

export interface Runtime {
  sql: postgres.Sql;
  store: Store;
  snapshots: SnapshotStore;
  signer: PrivateSigningKey;
  engines: Engine[];
  browser: PlaywrightEngine | null;
  queues: BullQueues;
  jobDeps: JobDeps;
  delivery: DeliveryDeps;
  extraction: ExtractionDeps;
  search: SearchProvider | null;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig): Promise<Runtime> {
  const sql = createSql(config.databaseUrl);
  await migrate(sql);
  const store = new PgStore(sql);
  const snapshots = new FileSnapshotStore(config.snapshotDir);
  const signer = await loadOrCreateSigningKey(config.signingKeyFile, store);
  const webhookSecret = await loadOrCreateWebhookSecret(config.webhookSecretFile);

  const browser = config.browserEnabled
    ? createPlaywrightEngine({
        quality: config.preferBrowser ? 20 : 4,
        maxConcurrency: config.browserConcurrency,
        noSandbox: config.browserNoSandbox,
      })
    : null;
  const engines: Engine[] = browser ? [browser, fetchEngine] : [fetchEngine];

  const queues = new BullQueues({ redisUrl: config.redisUrl, prefix: config.queuePrefix, maxAttempts: config.scrapeMaxAttempts });
  const scraper = {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
    injection: config.injection,
  };
  const extraction: ExtractionDeps = {
    llm: config.llm ? createLlmClient(config.llm) : null,
    maxInputChars: config.llmMaxInputChars,
    maxOutputTokens: config.llmMaxOutputTokens,
  };
  const search = config.searxngUrl ? createSearxngProvider({ baseUrl: config.searxngUrl }) : null;
  const jobDeps: JobDeps = {
    store,
    snapshots,
    engines,
    scraper,
    signer,
    queues,
    fetcher: makeFetcher({ allowPrivateNetworks: config.allowPrivateNetworks }),
    allowIgnoreRobots: config.allowIgnoreRobots,
    extraction,
    search,
    extractMaxPages: config.extractMaxPages,
  };

  return {
    sql,
    store,
    snapshots,
    signer,
    engines,
    browser,
    queues,
    jobDeps,
    extraction,
    search,
    delivery: { secret: webhookSecret, allowPrivate: config.allowPrivateNetworks },
    async close() {
      await queues.close();
      await browser?.close();
      await sql.end();
    },
  };
}
