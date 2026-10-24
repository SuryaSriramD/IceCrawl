import { loadConfig } from '../config';
import { migrate } from '../store/migrate';
import { createSql } from '../store/pg';

const sql = createSql(loadConfig().databaseUrl);
const ran = await migrate(sql);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await sql.end();
