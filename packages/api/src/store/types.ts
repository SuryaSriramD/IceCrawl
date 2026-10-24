import type { PublicKeyEntry, Receipt, ReceiptSignature, SignedReceipt, Verdict } from '@icecrawl/core';

export interface ApiKeyRow {
  id: string;
  name: string;
  revoked: boolean;
}

export interface ScrapeRecord {
  id: string;
  apiKeyId: string | null;
  url: string;
  finalUrl: string;
  verdict: Verdict;
  confidence: number;
  engine: string | null;
  statusCode: number | null;
  markdown: string | null;
  metadata: Record<string, unknown>;
  response: Record<string, unknown>;
  createdAt: string;
}

export interface SnapshotMeta {
  sha256: string;
  key: string;
  bytes: number;
}

export const snapshotKey = (sha256: string): string => `${sha256.slice(0, 2)}/${sha256}`;

export interface Store {
  findApiKeyByHash(hash: string): Promise<ApiKeyRow | null>;
  createApiKey(k: { id: string; hash: string; name: string }): Promise<void>;
  revokeApiKey(id: string): Promise<void>;
  saveScrape(
    rec: ScrapeRecord,
    receipt: Receipt,
    snapshot: SnapshotMeta | null,
    signature?: ReceiptSignature | null,
  ): Promise<void>;
  getScrape(id: string): Promise<ScrapeRecord | null>;
  getReceipt(id: string): Promise<Receipt | null>;
  getSignedReceipt(id: string): Promise<SignedReceipt | null>;
  registerPublicKey(entry: PublicKeyEntry): Promise<void>;
  listPublicKeys(): Promise<PublicKeyEntry[]>;
  retireKey(keyId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  put(bytes: Uint8Array): Promise<SnapshotMeta>;
  get(key: string): Promise<Uint8Array | null>;
}
