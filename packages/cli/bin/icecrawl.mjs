#!/usr/bin/env node
// In the repository the TypeScript sources run through tsx, so a stale dist/ from an earlier build is never used.
// The published package has no src/ (see "files" in package.json) and runs the built dist/bin.js.
import { existsSync } from 'node:fs';

const source = new URL('../src/bin.ts', import.meta.url);
if (existsSync(source)) {
  const { register } = await import('tsx/esm/api');
  register();
  await import(source.href);
} else {
  await import(new URL('../dist/bin.js', import.meta.url).href);
}
