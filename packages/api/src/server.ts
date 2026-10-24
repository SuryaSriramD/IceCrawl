import { createPlaywrightEngine, fetchEngine, type Engine } from '@icecrawl/engines';
import { buildApp } from './app';
import { loadConfig } from './config';
import { loadOrCreateSigningKey } from './signing';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';

const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);
const store = new PgStore(sql);
const signer = await loadOrCreateSigningKey(config.signingKeyFile, store);

const browser = config.browserEnabled
  ? createPlaywrightEngine({
      quality: config.preferBrowser ? 20 : 4,
      maxConcurrency: config.browserConcurrency,
      noSandbox: config.browserNoSandbox,
    })
  : null;
const engines: Engine[] = browser ? [browser, fetchEngine] : [fetchEngine];

const app = buildApp({
  store,
  snapshots: new FileSnapshotStore(config.snapshotDir),
  engines,
  scraper: {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
  },
  useAuth: config.useAuth,
  signer,
});

const shutdown = async () => {
  await app.close();
  await browser?.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'}, engines ${engines.map((e) => e.name).join(' > ')}, signing key ${signer.keyId})`,
);
