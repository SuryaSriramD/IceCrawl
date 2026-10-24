import { fetchEngine } from '@icecrawl/engines';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './store/migrate';
import { PgStore, createSql } from './store/pg';
import { FileSnapshotStore } from './store/snapshots';

const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);

const app = buildApp({
  store: new PgStore(sql),
  snapshots: new FileSnapshotStore(config.snapshotDir),
  engines: [fetchEngine],
  scraper: {
    allowPrivateNetworks: config.allowPrivateNetworks,
    maxResponseBytes: config.maxResponseBytes,
    strict: config.strict,
  },
  useAuth: config.useAuth,
});

const shutdown = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'})`);
