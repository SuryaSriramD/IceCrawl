import postgres from 'postgres';
import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict } from '@icecrawl/core';
import type { ApiKeyRow, JobError, JobRecord, JobStatus, NewJob, ScrapeRecord, SnapshotMeta, Store } from './types';

export function createSql(url: string): postgres.Sql {
  return postgres(url, { onnotice: () => {}, max: 10 });
}

const jobFromRow = (r: postgres.Row): JobRecord => ({
  id: r.id,
  type: r.type,
  apiKeyId: r.api_key_id,
  status: r.status,
  request: r.request,
  webhook: r.webhook,
  limit: r.page_limit,
  total: r.total,
  completed: r.completed,
  failed: r.failed,
  createdAt: new Date(r.created_at).toISOString(),
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  expiresAt: new Date(r.expires_at).toISOString(),
});

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

  async saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    snapshot: SnapshotMeta | null,
    signature: ReceiptSignature | null = null,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into scrapes (id, api_key_id, job_id, url, final_url, verdict, confidence, engine, status_code, markdown, metadata, response, created_at)
        values (${rec.id}, ${rec.apiKeyId}, ${rec.jobId ?? null}, ${rec.url}, ${rec.finalUrl}, ${rec.verdict}, ${rec.confidence}, ${rec.engine},
                ${rec.statusCode}, ${rec.markdown}, ${tx.json(rec.metadata as never)}, ${tx.json(rec.response as never)}, ${rec.createdAt})`;
      if (snapshot) {
        await tx`insert into snapshots (scrape_id, html_sha256, storage_key, bytes)
                 values (${rec.id}, ${snapshot.sha256}, ${snapshot.key}, ${snapshot.bytes})`;
      }
      await tx`insert into receipts (id, body, signature, key_id)
               values (${rec.id}, ${tx.json(receipt as never)}, ${signature?.sig ?? null}, ${signature?.keyId ?? null})`;
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
    return (await this.getSignedReceipt(id))?.receipt ?? null;
  }

  async getSignedReceipt(id: string): Promise<SignedReceipt | null> {
    const [r] = await this.sql`select body, signature, key_id from receipts where id = ${id}`;
    if (!r) return null;
    return {
      receipt: r.body as Receipt,
      signature: r.signature && r.key_id ? { alg: 'Ed25519', keyId: r.key_id, sig: r.signature } : null,
    };
  }

  async registerPublicKey(e: PublicKeyEntry): Promise<void> {
    await this.sql`
      insert into signing_keys (key_id, public_key, created_at, retired_at)
      values (${e.keyId}, ${e.publicKey}, ${e.createdAt}, ${e.retiredAt})
      on conflict (key_id) do nothing`;
  }

  async listPublicKeys(): Promise<PublicKeyEntry[]> {
    const rows = await this.sql`select key_id, public_key, created_at, retired_at from signing_keys order by created_at, key_id`;
    return rows.map((r) => ({
      keyId: r.key_id,
      alg: 'Ed25519' as const,
      publicKey: r.public_key,
      createdAt: new Date(r.created_at).toISOString(),
      retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : null,
    }));
  }

  async retireKey(keyId: string): Promise<void> {
    await this.sql`update signing_keys set retired_at = now() where key_id = ${keyId} and retired_at is null`;
  }

  async createJob(j: NewJob): Promise<void> {
    await this.sql`
      insert into jobs (id, type, api_key_id, request, webhook, page_limit, expires_at)
      values (${j.id}, ${j.type}, ${j.apiKeyId}, ${this.sql.json(j.request as never)}, ${j.webhook ? this.sql.json(j.webhook as never) : null}, ${j.limit}, ${j.expiresAt.toISOString()})`;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const [r] = await this.sql`select * from jobs where id = ${id}`;
    return r ? jobFromRow(r) : null;
  }

  async reserveUrls(jobId: string, requested: number): Promise<number> {
    const [r] = await this.sql`
      with old as (select id, total, page_limit from jobs where id = ${jobId} and status = 'scraping' for update)
      update jobs set total = jobs.total + least(${requested}::int, greatest(old.page_limit - old.total, 0))
      from old where jobs.id = old.id
      returning least(${requested}::int, greatest(old.page_limit - old.total, 0)) as granted`;
    return r ? Number(r.granted) : 0;
  }

  async recordPageResult(jobId: string, outcome: 'completed' | 'failed') {
    const [r] = await this.sql`
      update jobs set
        completed = completed + (case when ${outcome} = 'completed' then 1 else 0 end),
        failed = failed + (case when ${outcome} = 'failed' then 1 else 0 end)
      where id = ${jobId}
      returning total, completed, failed, status`;
    if (!r) throw new Error(`unknown job ${jobId}`);
    return { total: r.total, completed: r.completed, failed: r.failed, status: r.status as JobStatus };
  }

  async finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null> {
    const [r] = await this.sql`
      update jobs set status = ${status}, completed_at = now() where id = ${jobId} and status = 'scraping' returning *`;
    return r ? jobFromRow(r) : null;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      update jobs set status = 'cancelled', completed_at = now() where id = ${jobId} and status = 'scraping' returning id`;
    return rows.length > 0;
  }

  async addJobError(jobId: string, e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' }): Promise<void> {
    await this.sql`insert into job_errors (job_id, url, error, code, kind) values (${jobId}, ${e.url}, ${e.error}, ${e.code}, ${e.kind})`;
  }

  async listJobErrors(jobId: string): Promise<JobError[]> {
    const rows = await this.sql`select id, url, error, code, kind, created_at from job_errors where job_id = ${jobId} order by created_at, id`;
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      error: r.error,
      code: r.code,
      kind: r.kind,
      timestamp: new Date(r.created_at).toISOString(),
    }));
  }

  async listJobPages(jobId: string, skip: number, maxBytes: number) {
    const batch = 500;
    const rows = await this.sql`
      select response->'data' as data, length(response::text) as size
      from scrapes where job_id = ${jobId} and (response->>'success') = 'true'
      order by seq offset ${skip} limit ${batch + 1}`;
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    let more = rows.length > batch;
    for (const row of rows.slice(0, batch)) {
      const size = Number(row.size);
      if (items.length > 0 && bytes + size > maxBytes) {
        more = true;
        break;
      }
      items.push(row.data as Record<string, unknown>);
      bytes += size;
    }
    return { items, nextSkip: more ? skip + items.length : null };
  }

  async listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]> {
    const rows = await this.sql`
      select * from jobs where status = 'scraping' and api_key_id is not distinct from ${apiKeyId} order by created_at`;
    return rows.map(jobFromRow);
  }

  async deleteExpiredJobs(now: Date): Promise<number> {
    const rows = await this.sql`delete from jobs where expires_at < ${now.toISOString()} returning id`;
    return rows.length;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
