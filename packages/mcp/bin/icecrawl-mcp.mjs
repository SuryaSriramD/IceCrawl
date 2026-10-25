#!/usr/bin/env node
// Published package: runs the built dist/cli.js. In the repository there is no build yet, so the TypeScript sources run through tsx.
import { existsSync } from 'node:fs';

const built = new URL('../dist/cli.js', import.meta.url);
if (existsSync(built)) {
  await import(built.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/cli.ts');
}
