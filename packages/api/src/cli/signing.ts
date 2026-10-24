import { loadConfig } from '../config';
import { rotateSigningKey } from '../signing';
import { migrate } from '../store/migrate';
import { PgStore, createSql } from '../store/pg';

const [command] = process.argv.slice(2);
const config = loadConfig();
const sql = createSql(config.databaseUrl);
await migrate(sql);

try {
  if (command === 'rotate') {
    const { oldKeyId, newKeyId } = await rotateSigningKey(config.signingKeyFile, new PgStore(sql));
    console.log(`New signing key ${newKeyId}${oldKeyId ? ` (retired ${oldKeyId}; its private key was kept as a .bak file)` : ''}`);
  } else {
    console.error('Usage: signing rotate');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
