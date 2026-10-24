import postgres from 'postgres';
import type { Receipt, Verdict } from '@icecrawl/core';
import type { ApiKeyRow, ScrapeRecord, SnapshotMeta, Store } from './types';

export function createSql(url: string): postgres.Sql {
  return postgres(url, { onnotice: () => {}, max: 10 });
}

export class PgStore implements Store {
  constructor(private readonly sql: postgres.Sql) {}

  async findApiKeyByHash(hash: string): Promise<ApiKeyRow | null> {
    const [r] = await this.sql`select id, name, revoked_at from api_keys where hash = ${hash}`;
    return r ? { id: r.id, name: r.name, revoked: r.revoked_at !== null } : null;
  }

  async createApiKey(k: { id: string; hash: string; name: string }): Promise<void> {
    await this.sql`insert into api_keys (id, hash, name) values (${k.id}, ${k.hash}, ${k.name})`;
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.sql`update api_keys set revoked_at = now() where id = ${id}`;
  }

  async saveScrape(rec: ScrapeRecord, receipt: Receipt, snapshot: SnapshotMeta | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into scrapes (id, api_key_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata, response, created_at)
        values (${rec.id}, ${rec.apiKeyId}, ${rec.url}, ${rec.finalUrl}, ${rec.verdict}, ${rec.confidence}, ${rec.engine},
                ${rec.statusCode}, ${rec.markdown}, ${tx.json(rec.metadata as never)}, ${tx.json(rec.response as never)}, ${rec.createdAt})`;
      if (snapshot) {
        await tx`insert into snapshots (scrape_id, html_sha256, storage_key, bytes)
                 values (${rec.id}, ${snapshot.sha256}, ${snapshot.key}, ${snapshot.bytes})`;
      }
      await tx`insert into receipts (id, body) values (${rec.id}, ${tx.json(receipt as never)})`;
    });
  }

  async getScrape(id: string): Promise<ScrapeRecord | null> {
    const [r] = await this.sql`select * from scrapes where id = ${id}`;
    if (!r) return null;
    return {
      id: r.id,
      apiKeyId: r.api_key_id,
      url: r.url,
      finalUrl: r.final_url,
      verdict: r.verdict as Verdict,
      confidence: r.confidence,
      engine: r.engine,
      statusCode: r.status_code,
      markdown: r.markdown,
      metadata: r.metadata,
      response: r.response,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async getReceipt(id: string): Promise<Receipt | null> {
    const [r] = await this.sql`select body from receipts where id = ${id}`;
    return r ? (r.body as Receipt) : null;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
