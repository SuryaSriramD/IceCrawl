import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadOrCreateWebhookSecret(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const secret = randomBytes(32).toString('hex');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, secret, { mode: 0o600, flag: 'wx' });
  return secret;
}
