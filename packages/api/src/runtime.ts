import { createPlaywrightEngine, fetchEngine, type Engine, type PlaywrightEngine } from '@icecrawl/engines';
import { BullQueues } from '@icecrawl/queue';
import type { PrivateSigningKey } from '@icecrawl/trust';
import type postgres from 'postgres';
import type { AppConfig } from './config';
import { makeFetcher } from './jobs/fetcher';
import type { JobDeps } from './jobs/processor';
import type { DeliveryDeps } from './jobs/webhooks';
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
  const jobDeps: JobDeps = {
    store,
    snapshots,
    engines,
    scraper,
    signer,
    queues,
    fetcher: makeFetcher({ allowPrivateNetworks: config.allowPrivateNetworks }),
    allowIgnoreRobots: config.allowIgnoreRobots,
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
    delivery: { secret: webhookSecret, allowPrivate: config.allowPrivateNetworks },
    async close() {
      await queues.close();
      await browser?.close();
      await sql.end();
    },
  };
}
