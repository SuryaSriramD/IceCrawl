import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt } from '@icecrawl/core';
import { sha256Hex } from '@icecrawl/trust';
import { snapshotKey, type ApiKeyRow, type ScrapeRecord, type SnapshotMeta, type SnapshotStore, type Store } from './types';

export class MemoryStore implements Store {
  private keys = new Map<string, { id: string; name: string; revoked: boolean }>();
  private scrapes = new Map<string, ScrapeRecord>();
  private receipts = new Map<string, { receipt: Receipt; signature: ReceiptSignature | null }>();
  private publicKeys: PublicKeyEntry[] = [];

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
