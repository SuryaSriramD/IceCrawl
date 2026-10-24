import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '@icecrawl/trust';
import type { SnapshotMeta, SnapshotStore } from './types';

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly dir: string) {}

  async put(bytes: Uint8Array): Promise<SnapshotMeta> {
    const sha256 = sha256Hex(bytes);
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const path = join(this.dir, key);
    try {
      await access(path);
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return { sha256, key, bytes: bytes.length };
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!KEY_PATTERN.test(key)) return null;
    try {
      return await readFile(join(this.dir, key));
    } catch {
      return null;
    }
  }
}
