// Runs one piece of user code against a live browser session. Started by sessions.ts as a child process with an
// empty environment; reads {"code": "..."} from stdin and prints one JSON line {"result", "stdout"} on success.
// Errors go to stderr with exit code 1. This is not a sandbox: the code runs with the server's operating system rights.
import { chromium } from 'playwright-core';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { code, cdp } = JSON.parse(input);

const lines = [];
const fmt = (a) => (typeof a === 'string' ? a : JSON.stringify(a));
const sandboxConsole = { log: (...a) => lines.push(a.map(fmt).join(' ')), error: (...a) => lines.push(a.map(fmt).join(' ')) };

let browser;
try {
  browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  const value = await new AsyncFunction('page', 'context', 'browser', 'console', code)(page, context, browser, sandboxConsole);
  const result = value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  process.stdout.write(`${JSON.stringify({ result, stdout: lines.join('\n') })}\n`);
  await browser.close().catch(() => undefined); // disconnects only: the browser belongs to the session
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : String(err)}\n`);
  process.exit(1);
}
