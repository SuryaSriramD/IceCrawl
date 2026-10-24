import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchEngine } from '@icecrawl/engines';
import { checkStoredHashes, sha256Hex } from '@icecrawl/trust';
import { buildApp } from '../src/app';
import { migrate } from '../src/store/migrate';
import { PgStore, createSql } from '../src/store/pg';
import { FileSnapshotStore } from '../src/store/snapshots';

const url = process.env.DATABASE_URL;
const article = `<article><h1>E2E Page</h1>${'<p>Genuine paragraph about genuine things. </p>'.repeat(30)}</article>`;
const pageHtml = `<html><head><title>E2E</title></head><body>${article}</body></html>`;

describe.skipIf(!url)('end to end: real fetch engine + Postgres + file snapshots', () => {
  const sql = createSql(url ?? 'postgres://unused');
  let origin: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    await migrate(sql);
    dir = await mkdtemp(join(tmpdir(), 'icecrawl-e2e-'));
    origin = createServer((req, res) => {
      if (req.url === '/blocked') {
        res.writeHead(403, { 'content-type': 'text/html' }).end('<html>Access denied</html>');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml);
      }
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    port = (origin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    origin.closeAllConnections();
    origin.close();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('scrapes a page, persists it, and the stored snapshot matches the receipt hash', async () => {
    const store = new PgStore(sql);
    const snapshots = new FileSnapshotStore(dir);
    const keyId = randomUUID();
    const rawKey = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: keyId, hash: sha256Hex(rawKey), name: 'e2e' });
    const app = buildApp({
      store,
      snapshots,
      engines: [fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 1_000_000, strict: false },
      useAuth: true,
    });
    const auth = { authorization: `Bearer ${rawKey}` };

    const res = await app.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/page`, formats: ['markdown', 'links'] } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.markdown).toContain('# E2E Page');
    expect(body.data.trust.verdict).toBe('ok');

    const receipt = (await app.inject({ method: 'GET', url: `/v2/receipts/${body.data.trust.receiptId}`, headers: auth })).json().data;
    const stored = await snapshots.get(`${receipt.htmlSha256.slice(0, 2)}/${receipt.htmlSha256}`);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).toString()).toBe(pageHtml);
    expect(checkStoredHashes(receipt, stored, body.data.markdown)).toEqual({ html: true, output: true });

    // tamper with one byte: the check must fail
    const tampered = Buffer.from(stored!);
    tampered[10] = tampered[10] ^ 1;
    expect(checkStoredHashes(receipt, tampered, body.data.markdown).html).toBe(false);
  });

  it('reports a blocked origin honestly and refuses private targets by default', async () => {
    const store = new PgStore(sql);
    const keyId = randomUUID();
    const rawKey = `ic-e2e-${randomUUID()}`;
    await store.createApiKey({ id: keyId, hash: sha256Hex(rawKey), name: 'e2e2' });
    const auth = { authorization: `Bearer ${rawKey}` };
    const permissive = buildApp({
      store, snapshots: new FileSnapshotStore(dir), engines: [fetchEngine],
      scraper: { allowPrivateNetworks: true, maxResponseBytes: 1_000_000, strict: false }, useAuth: true,
    });
    const blocked = await permissive.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/blocked` } });
    expect(blocked.statusCode).toBe(502);
    expect(blocked.json()).toMatchObject({ success: false, code: 'BLOCKED' });

    const strictNet = buildApp({
      store, snapshots: new FileSnapshotStore(dir), engines: [fetchEngine],
      scraper: { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false }, useAuth: true,
    });
    const ssrf = await strictNet.inject({ method: 'POST', url: '/v2/scrape', headers: auth, payload: { url: `http://127.0.0.1:${port}/page` } });
    expect(ssrf.statusCode).toBe(400);
    expect(ssrf.json().code).toBe('SSRF_BLOCKED');
  });
});
