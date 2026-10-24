#!/usr/bin/env node
// Runs the TypeScript sources through tsx until the package is built and published (phase 6).
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
main(process.argv.slice(2), process.env).catch((err) => {
  console.error(`icecrawl-mcp failed to start: ${err.message}`);
  process.exit(1);
});
