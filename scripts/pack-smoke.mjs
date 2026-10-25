// Builds the publishable packages, packs them, installs the tarballs into an empty project the way a user would,
// and uses them against the conformance server: the SDK (scrape + receipt verification), the MCP server over
// stdio (through the real MCP client) and the verify CLI. Nothing is published.
//
//   node scripts/pack-smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3011;
const PACKAGES = ['sdk', 'mcp', 'cli'];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, shell: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const work = mkdtempSync(join(tmpdir(), 'icecrawl-pack-'));
let server;
try {
  console.log('building');
  run('pnpm', ['build'], root);

  const tarballs = join(work, 'tarballs');
  for (const name of PACKAGES) run('pnpm', ['pack', '--pack-destination', JSON.stringify(tarballs)], join(root, 'packages', name));
  const files = readdirSync(tarballs).filter((f) => f.endsWith('.tgz'));
  if (files.length !== PACKAGES.length) throw new Error(`expected ${PACKAGES.length} tarballs, got ${files.join(', ')}`);
  console.log(`packed ${files.join(', ')}`);

  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', ...files.map((f) => JSON.stringify(join(tarballs, f)))], app);
  console.log('installed into an empty project');

  server = spawn('pnpm', ['tsx', 'packages/api/test/support/conformance-server.ts'], { cwd: root, shell: true, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('conformance server did not start')), 60_000);
    server.stdout.on('data', (b) => {
      if (String(b).includes('ready')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    server.on('exit', (code) => reject(new Error(`conformance server exited with ${code}`)));
  });

  const check = `
    import { IceCrawl } from '@icecrawl/sdk';
    import { verifyReceiptRemote } from '@icecrawl/sdk/verify';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    import { fileURLToPath } from 'node:url';

    const url = 'http://127.0.0.1:${PORT}';
    const ic = new IceCrawl({ apiUrl: url, apiKey: 'ic-jobs' });
    const doc = await ic.scrape('https://example.com/a');
    if (!doc.markdown.includes('Real readable sentence')) throw new Error('sdk scrape returned no markdown');
    const report = await verifyReceiptRemote(ic, doc.trust.receiptId);
    if (!report.ok || report.signature.status !== 'pass' || report.replay.status !== 'pass') throw new Error('receipt did not verify: ' + JSON.stringify(report));
    console.log('sdk: scrape and receipt verification ok');

    const bin = fileURLToPath(new URL('./node_modules/@icecrawl/mcp/bin/icecrawl-mcp.mjs', import.meta.url));
    const mcp = new Client({ name: 'pack-smoke', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: { ...process.env, ICECRAWL_API_URL: url, ICECRAWL_API_KEY: 'ic-jobs' } }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    for (const t of ['icecrawl_scrape', 'icecrawl_search', 'icecrawl_extract', 'icecrawl_verify_receipt']) if (!tools.includes(t)) throw new Error('missing tool ' + t);
    const result = await mcp.callTool({ name: 'icecrawl_scrape', arguments: { url: 'https://example.com/a' } });
    const text = result.content.map((c) => c.text ?? '').join('\\n');
    if (result.isError || !text.includes('ICECRAWL_UNTRUSTED_CONTENT')) throw new Error('mcp scrape failed: ' + text.slice(0, 300));
    await mcp.close();
    console.log('mcp: ' + tools.length + ' tools, scrape ok');
  `;
  writeFileSync(join(app, 'check.mjs'), check);
  console.log(run('node', ['check.mjs'], app).trim());

  const cli = spawnSync('node', [JSON.stringify(join(app, 'node_modules', '@icecrawl', 'cli', 'bin', 'icecrawl.mjs'))], { shell: true, encoding: 'utf8' });
  if (cli.status !== 2 || !`${cli.stdout}${cli.stderr}`.includes('Usage')) throw new Error(`cli did not print usage: ${cli.status} ${cli.stdout} ${cli.stderr}`);
  console.log('cli: starts and prints usage');
  console.log('pack smoke passed');
} finally {
  if (server) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { shell: true });
    else server.kill();
  }
  if (!process.env.KEEP_PACK_SMOKE) rmSync(work, { recursive: true, force: true });
  else console.log('kept', work);
}
