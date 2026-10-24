import { randomBytes, randomUUID } from 'node:crypto';
import { sha256Hex } from '@icecrawl/trust';
import { loadConfig } from '../config';
import { migrate } from '../store/migrate';
import { PgStore, createSql } from '../store/pg';

const [command, arg] = process.argv.slice(2);
const sql = createSql(loadConfig().databaseUrl);
await migrate(sql);
const store = new PgStore(sql);

try {
  if (command === 'create') {
    const name = arg ?? 'default';
    const key = `ic-${randomBytes(24).toString('hex')}`;
    await store.createApiKey({ id: randomUUID(), hash: sha256Hex(key), name });
    console.log(`Created API key "${name}". It is shown only once:\n${key}`);
  } else if (command === 'revoke' && arg) {
    await store.revokeApiKey(arg);
    console.log(`Revoked key ${arg}`);
  } else {
    console.error('Usage: keys create <name> | keys revoke <key-id>');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
