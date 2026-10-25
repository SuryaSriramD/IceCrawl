#!/usr/bin/env node
// Published package: runs the built dist/bin.js. In the repository the TypeScript sources run through tsx.
import { existsSync } from 'node:fs';

const built = new URL('../dist/bin.js', import.meta.url);
if (existsSync(built)) {
  await import(built.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/bin.ts');
}
