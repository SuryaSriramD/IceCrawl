export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  snapshotDir: string;
  useAuth: boolean;
  allowPrivateNetworks: boolean;
  strict: boolean;
  injection: 'off' | 'flag' | 'quarantine';
  maxResponseBytes: number;
  browserEnabled: boolean;
  preferBrowser: boolean;
  browserConcurrency: number;
  browserNoSandbox: boolean;
  signingKeyFile: string;
  webhookSecretFile: string;
  runWorker: boolean;
  workerConcurrency: number;
  scrapeMaxAttempts: number;
  jobTtlHours: number;
  jobPageBytes: number;
  maxCrawlLimit: number;
  allowIgnoreRobots: boolean;
  publicUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const injection = env.ICECRAWL_INJECTION ?? 'flag';
  if (injection !== 'off' && injection !== 'flag' && injection !== 'quarantine') {
    throw new Error(`ICECRAWL_INJECTION must be off, flag or quarantine (got "${injection}")`);
  }
  return {
    port: Number(env.PORT ?? 3002),
    databaseUrl: env.DATABASE_URL ?? 'postgres://icecrawl:icecrawl@localhost:5432/icecrawl',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    queuePrefix: env.ICECRAWL_QUEUE_PREFIX ?? 'icecrawl',
    snapshotDir: env.ICECRAWL_SNAPSHOT_DIR ?? './data/snapshots',
    useAuth: env.ICECRAWL_USE_AUTH !== 'false',
    allowPrivateNetworks: env.ICECRAWL_ALLOW_PRIVATE_NETWORKS === 'true',
    strict: env.ICECRAWL_STRICT === 'true',
    injection,
    maxResponseBytes: Number(env.ICECRAWL_MAX_RESPONSE_BYTES ?? 10 * 1024 * 1024),
    browserEnabled: env.ICECRAWL_BROWSER !== 'false',
    preferBrowser: env.ICECRAWL_PREFER_BROWSER !== 'false',
    browserConcurrency: Number(env.ICECRAWL_BROWSER_CONCURRENCY ?? 4),
    browserNoSandbox: env.ICECRAWL_BROWSER_NO_SANDBOX === 'true',
    signingKeyFile: env.ICECRAWL_SIGNING_KEY_FILE ?? './data/signing-key.pem',
    webhookSecretFile: env.ICECRAWL_WEBHOOK_SECRET_FILE ?? './data/webhook-secret',
    runWorker: env.ICECRAWL_RUN_WORKER !== 'false',
    workerConcurrency: Number(env.ICECRAWL_WORKER_CONCURRENCY ?? 8),
    scrapeMaxAttempts: Number(env.ICECRAWL_SCRAPE_MAX_ATTEMPTS ?? 3),
    jobTtlHours: Number(env.ICECRAWL_JOB_TTL_HOURS ?? 24),
    jobPageBytes: Number(env.ICECRAWL_JOB_PAGE_BYTES ?? 10 * 1024 * 1024),
    maxCrawlLimit: Number(env.ICECRAWL_MAX_CRAWL_LIMIT ?? 100_000),
    allowIgnoreRobots: env.ICECRAWL_ALLOW_IGNORE_ROBOTS === 'true',
    publicUrl: env.ICECRAWL_PUBLIC_URL || undefined,
  };
}
