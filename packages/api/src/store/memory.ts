import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '@icecrawl/trust';
import { snapshotKey, type ApiKeyRow, type JobError, type JobRecord, type JobStatus, type NewJob, type ScrapeRecord, type SnapshotMeta, type SnapshotStore, type Store } from './types';

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
