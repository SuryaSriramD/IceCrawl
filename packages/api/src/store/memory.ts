import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '@icecrawl/trust';
import { snapshotKey, type ActivityRow, type IndexHit, type ApiKeyRow, type JobError, type JobRecord, type JobStatus, type JobType, type NewJob, type ScrapeRecord, type SnapshotMeta, type SnapshotStore, type Store, type Usage } from './types';

export class MemoryStore implements Store {
  private keys = new Map<string, { id: string; name: string; revoked: boolean }>();
  private scrapes = new Map<string, ScrapeRecord>();
  private receipts = new Map<string, { receipt: Receipt; signature: ReceiptSignature | null }>();
  private publicKeys: PublicKeyEntry[] = [];
  private jobs = new Map<string, JobRecord>();
  private jobErrors = new Map<string, JobError[]>();

  async findApiKeyByHash(hash: string): Promise<ApiKeyRow | null> {
    const k = this.keys.get(hash);
    return k ? { ...k } : null;
  }
  async createApiKey(k: { id: string; hash: string; name: string }): Promise<void> {
    this.keys.set(k.hash, { id: k.id, name: k.name, revoked: false });
  }
  async revokeApiKey(id: string): Promise<void> {
    for (const k of this.keys.values()) if (k.id === id) k.revoked = true;
  }
  async saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    _snapshot: SnapshotMeta | null,
    signature: ReceiptSignature | null = null,
  ): Promise<void> {
    this.scrapes.set(rec.id, structuredClone(rec));
    this.receipts.set(rec.id, structuredClone({ receipt, signature }));
  }
  async getScrape(id: string): Promise<ScrapeRecord | null> {
    const r = this.scrapes.get(id);
    return r ? structuredClone(r) : null;
  }
  async getReceipt(id: string): Promise<Receipt | null> {
    return (await this.getSignedReceipt(id))?.receipt ?? null;
  }
  async getSignedReceipt(id: string): Promise<SignedReceipt | null> {
    const r = this.receipts.get(id);
    return r ? structuredClone(r) : null;
  }
  async registerPublicKey(entry: PublicKeyEntry): Promise<void> {
    if (!this.publicKeys.some((k) => k.keyId === entry.keyId)) this.publicKeys.push({ ...entry });
  }
  async listPublicKeys(): Promise<PublicKeyEntry[]> {
    return this.publicKeys.map((k) => ({ ...k })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async retireKey(keyId: string): Promise<void> {
    const k = this.publicKeys.find((x) => x.keyId === keyId);
    if (k && k.retiredAt === null) k.retiredAt = new Date().toISOString();
  }
  async createJob(j: NewJob): Promise<void> {
    this.jobs.set(j.id, {
      id: j.id,
      type: j.type,
      apiKeyId: j.apiKeyId,
      status: 'scraping',
      request: structuredClone(j.request),
      webhook: j.webhook ? structuredClone(j.webhook) : null,
      limit: j.limit,
      result: null,
      tokensUsed: null,
      total: 0,
      completed: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      expiresAt: j.expiresAt.toISOString(),
    });
  }
  async getJob(id: string): Promise<JobRecord | null> {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async reserveUrls(jobId: string, requested: number): Promise<number> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return 0;
    const granted = Math.max(0, Math.min(requested, j.limit - j.total));
    j.total += granted;
    return granted;
  }
  async recordPageResult(jobId: string, outcome: 'completed' | 'failed') {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`unknown job ${jobId}`);
    if (outcome === 'completed') j.completed++;
    else j.failed++;
    return { total: j.total, completed: j.completed, failed: j.failed, status: j.status as JobStatus };
  }
  async finalizeJob(jobId: string, status: 'completed' | 'failed'): Promise<JobRecord | null> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return null;
    j.status = status;
    j.completedAt = new Date().toISOString();
    return structuredClone(j);
  }
  async cancelJob(jobId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'scraping') return false;
    j.status = 'cancelled';
    j.completedAt = new Date().toISOString();
    return true;
  }
  async saveJobResult(jobId: string, result: Record<string, unknown>, tokensUsed: number | null): Promise<void> {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.result = structuredClone(result);
    j.tokensUsed = tokensUsed;
  }
  async addJobError(jobId: string, e: { url: string; error: string; code: string | null; kind: 'error' | 'robots' }): Promise<void> {
    const list = this.jobErrors.get(jobId) ?? [];
    list.push({ id: randomUUID(), url: e.url, error: e.error, code: e.code, kind: e.kind, timestamp: new Date().toISOString() });
    this.jobErrors.set(jobId, list);
  }
  async listJobErrors(jobId: string): Promise<JobError[]> {
    return structuredClone(this.jobErrors.get(jobId) ?? []);
  }
  async listJobPages(jobId: string, skip: number, maxBytes: number) {
    const accepted = [...this.scrapes.values()]
      .filter((s) => s.jobId === jobId && (s.response as { success?: boolean }).success === true)
      .map((s) => (s.response as { data: Record<string, unknown> }).data);
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    for (let i = skip; i < accepted.length; i++) {
      const size = JSON.stringify(accepted[i]).length;
      if (items.length > 0 && bytes + size > maxBytes) break;
      items.push(structuredClone(accepted[i]));
      bytes += size;
    }
    const next = skip + items.length;
    return { items, nextSkip: next < accepted.length ? next : null };
  }
  async listActiveJobs(apiKeyId: string | null): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'scraping' && j.apiKeyId === apiKeyId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => structuredClone(j));
  }
  async listJobs(apiKeyId: string | null, type: JobType, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.type === type && j.apiKeyId === apiKeyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
  async deleteExpiredJobs(now: Date): Promise<number> {
    let n = 0;
    for (const [id, j] of this.jobs) {
      if (Date.parse(j.expiresAt) >= now.getTime()) continue;
      for (const [sid, s] of this.scrapes) {
        if (s.jobId === id) {
          this.scrapes.delete(sid);
          this.receipts.delete(sid);
        }
      }
      this.jobs.delete(id);
      this.jobErrors.delete(id);
      n++;
    }
    return n;
  }
  async failStaleJobs(olderThan: Date): Promise<number> {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status !== 'scraping' || Date.parse(j.createdAt) >= olderThan.getTime()) continue;
      j.status = 'failed';
      j.completedAt = new Date().toISOString();
      j.result ??= { error: 'The job did not finish in time and was stopped.', code: 'TIMEOUT' };
      n++;
    }
    return n;
  }
  async usageBetween(apiKeyId: string | null, from: Date, to: Date): Promise<Usage> {
    const inRange = (iso: string) => Date.parse(iso) >= from.getTime() && Date.parse(iso) < to.getTime();
    const scrapes = [...this.scrapes.values()].filter((s) => s.apiKeyId === apiKeyId && inRange(s.createdAt)).length;
    const tokens = [...this.jobs.values()].filter((j) => j.apiKeyId === apiKeyId && inRange(j.createdAt)).reduce((n, j) => n + (j.tokensUsed ?? 0), 0);
    return { scrapes, tokens };
  }
  async recentScrapes(apiKeyId: string | null, o: { limit: number; before?: string; endpoint?: string }): Promise<ActivityRow[]> {
    const endpointOf = (s: ScrapeRecord) => {
      const type = s.jobId ? this.jobs.get(s.jobId)?.type : undefined;
      return type === 'batch' ? 'batch_scrape' : (type ?? 'scrape');
    };
    return [...this.scrapes.values()]
      .filter((s) => s.apiKeyId === apiKeyId)
      .filter((s) => o.before === undefined || Date.parse(s.createdAt) < Date.parse(o.before))
      .filter((s) => o.endpoint === undefined || endpointOf(s) === o.endpoint)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, o.limit)
      .map((s) => ({ id: s.id, endpoint: endpointOf(s), createdAt: s.createdAt, url: s.url }));
  }
  async latestScrapeAt(apiKeyId: string | null): Promise<string | null> {
    const times = [...this.scrapes.values()]
      .filter((s) => s.apiKeyId === apiKeyId && (s.response as { success?: boolean }).success === true)
      .map((s) => s.createdAt)
      .sort();
    return times.length > 0 ? times[times.length - 1] : null;
  }
  async searchScrapes(apiKeyId: string | null, query: string, limit: number, urlPrefix?: string): Promise<IndexHit[]> {
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (tokens.length === 0) return [];
    const latest = new Map<string, ScrapeRecord>();
    for (const s of this.scrapes.values()) {
      if (s.apiKeyId !== apiKeyId || (s.response as { success?: boolean }).success !== true || !s.markdown) continue;
      if (urlPrefix && !s.finalUrl.startsWith(urlPrefix)) continue;
      const cur = latest.get(s.finalUrl);
      if (!cur || cur.createdAt < s.createdAt) latest.set(s.finalUrl, s);
    }
    const hits: IndexHit[] = [];
    for (const s of latest.values()) {
      const text = s.markdown!.toLowerCase();
      const counts = tokens.map((t) => text.split(t).length - 1);
      if (counts.some((c) => c === 0)) continue;
      const at = text.indexOf(tokens[0]);
      const from = Math.max(0, at - 80);
      hits.push({
        scrapeId: s.id,
        url: s.finalUrl,
        title: (s.metadata as { title?: string | null }).title ?? null,
        snippet: s.markdown!.slice(from, from + 240).replace(/\s+/g, ' ').trim(),
        score: counts.reduce((a, b) => a + b, 0) / Math.max(1, text.length / 1000),
        createdAt: s.createdAt,
      });
    }
    return hits.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

export class MemorySnapshotStore implements SnapshotStore {
  private blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<SnapshotMeta> {
    const sha256 = sha256Hex(bytes);
    const key = snapshotKey(sha256);
    this.blobs.set(key, bytes);
    return { sha256, key, bytes: bytes.length };
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key) ?? null;
  }
}
