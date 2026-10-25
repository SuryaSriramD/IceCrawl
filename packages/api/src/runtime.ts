import { createPlaywrightEngine, createSearxngProvider, fetchEngine, ProxyPool, SessionManager, type Engine, type PlaywrightEngine, type SearchProvider } from '@icecrawl/engines';
import { HostThrottle } from '@icecrawl/scraper';
import { createLlmClient } from '@icecrawl/extract';
import { BullQueues } from '@icecrawl/queue';
import type { PrivateSigningKey } from '@icecrawl/trust';
import type postgres from 'postgres';
import type { AppConfig } from './config';
import { makeFetcher } from './jobs/fetcher';
import type { JobDeps } from './jobs/processor';
import type { DeliveryDeps } from './jobs/webhooks';
import { RedisRateLimiter, type RateLimiter } from './ratelimit';
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
  sessions: SessionManager | null;
  queues: BullQueues;
  jobDeps: JobDeps;
  delivery: DeliveryDeps;
  extraction: ExtractionDeps;
  search: SearchProvider | null;
  rateLimiter: RateLimiter | null;
  /** 'ok' or a short reason for each dependency (served at /ready). */
  ready(): Promise<Record<string, string>>;
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
  const sessions = config.browserEnabled
    ? new SessionManager({ allowPrivateNetworks: config.allowPrivateNetworks, noSandbox: config.browserNoSandbox, allowCode: config.interactCode, maxSessions: config.interactMaxSessions })
    : null;

  const queues = new BullQueues({ redisUrl: config.redisUrl, prefix: config.queuePrefix, maxAttempts: config.scrapeMaxAttempts });
  const scraper = {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
    injection: config.injection,
    proxies: config.proxiesEnhanced.length + config.proxiesStealth.length > 0 ? new ProxyPool({ enhanced: config.proxiesEnhanced, stealth: config.proxiesStealth }) : null,
    throttle: new HostThrottle(config.proxyDomainIntervalMs),
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
    sessions,
    queues,
    jobDeps,
    extraction,
    search,
    rateLimiter: config.rateLimitPerMinute > 0 ? new RedisRateLimiter(queues.connection, config.queuePrefix, config.rateLimitPerMinute, 60_000) : null,
    async ready() {
      const check = (p: Promise<unknown>) => p.then(() => 'ok', (err: Error) => `unreachable: ${err.message}`.slice(0, 120));
      return { postgres: await check(store.ping()), redis: await check(queues.ping()) };
    },
    delivery: { secret: webhookSecret, allowPrivate: config.allowPrivateNetworks },
    async close() {
      await queues.close();
      await sessions?.close();
      await browser?.close();
      await sql.end();
    },
  };
}
