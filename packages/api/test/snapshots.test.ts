import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@icecrawl/trust';
import { FileSnapshotStore } from '../src/store/snapshots';

describe('FileSnapshotStore', () => {
  const dirs: string[] = [];
  const make = async () => {
    const d = await mkdtemp(join(tmpdir(), 'icecrawl-snap-'));
    dirs.push(d);
    return { dir: d, store: new FileSnapshotStore(d) };
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('stores bytes by SHA-256 and reads them back', async () => {
    const { store } = await make();
    const bytes = Buffer.from('<html>snapshot</html>');
    const meta = await store.put(bytes);
    expect(meta.sha256).toBe(sha256Hex(bytes));
    expect(meta.bytes).toBe(bytes.length);
    expect(Buffer.from((await store.get(meta.key))!).toString()).toBe('<html>snapshot</html>');
  });

  it('is idempotent for identical content', async () => {
    const { dir, store } = await make();
    const a = await store.put(Buffer.from('same'));
    const b = await store.put(Buffer.from('same'));
    expect(a.key).toBe(b.key);
    expect((await readdir(dir)).length).toBe(1);
  });

  it('returns null for a missing key and rejects path traversal', async () => {
    const { store } = await make();
    expect(await store.get('ab/' + 'c'.repeat(64))).toBeNull();
    expect(await store.get('../../etc/passwd')).toBeNull();
  });
});
