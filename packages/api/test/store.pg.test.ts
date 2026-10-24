import { afterAll, describe } from 'vitest';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { describeStoreContract } from './store.contract';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('postgres', () => {
  const sql = createSql(url ?? 'postgres://unused');
  afterAll(async () => {
    await sql.end();
  });
  describeStoreContract('postgres', async () => {
    await migrate(sql);
    await sql`truncate receipts, snapshots, scrapes, api_keys, signing_keys cascade`;
    return new PgStore(sql);
  });
});
