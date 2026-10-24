export interface AppConfig {
  port: number;
  databaseUrl: string;
  snapshotDir: string;
  useAuth: boolean;
  allowPrivateNetworks: boolean;
  strict: boolean;
  maxResponseBytes: number;
  browserEnabled: boolean;
  preferBrowser: boolean;
  browserConcurrency: number;
  browserNoSandbox: boolean;
  signingKeyFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3002),
    databaseUrl: env.DATABASE_URL ?? 'postgres://icecrawl:icecrawl@localhost:5432/icecrawl',
    snapshotDir: env.ICECRAWL_SNAPSHOT_DIR ?? './data/snapshots',
    useAuth: env.ICECRAWL_USE_AUTH !== 'false',
    allowPrivateNetworks: env.ICECRAWL_ALLOW_PRIVATE_NETWORKS === 'true',
    strict: env.ICECRAWL_STRICT === 'true',
    maxResponseBytes: Number(env.ICECRAWL_MAX_RESPONSE_BYTES ?? 10 * 1024 * 1024),
    browserEnabled: env.ICECRAWL_BROWSER !== 'false',
    preferBrowser: env.ICECRAWL_PREFER_BROWSER !== 'false',
    browserConcurrency: Number(env.ICECRAWL_BROWSER_CONCURRENCY ?? 4),
    browserNoSandbox: env.ICECRAWL_BROWSER_NO_SANDBOX === 'true',
    signingKeyFile: env.ICECRAWL_SIGNING_KEY_FILE ?? './data/signing-key.pem',
  };
}
