import { readFile } from 'node:fs/promises';
import { runVerify } from './verify-cmd';

const [command, ...rest] = process.argv.slice(2);

if (command === 'verify') {
  process.exitCode = await runVerify(rest, {
    fetch,
    readFile,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    env: process.env,
  });
} else {
  console.error('Usage: icecrawl verify ... (run `icecrawl verify` for details)');
  process.exitCode = 2;
}
