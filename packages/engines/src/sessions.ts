import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { IceCrawlError } from '@icecrawl/core';
import { startEgressProxy, type EgressProxy } from './egress-proxy';
import { assertUrlAllowed } from './ssrf';

export interface SessionManagerOptions {
  /** Sessions alive at once; creating more fails with RATE_LIMITED. */
  maxSessions?: number;
  allowPrivateNetworks: boolean;
  noSandbox?: boolean;
  /** Whether `execute` may run code. Off unless the operator turned it on. */
  allowCode: boolean;
  now?: () => number;
}

export interface SessionInfo {
  id: string;
  ownerKey: string;
  createdAt: string;
  lastActivity: string;
  expiresAt: string;
  status: 'active' | 'destroyed';
}

export interface ExecResult {
  stdout: string | null;
  result: string | null;
  stderr: string | null;
  exitCode: number | null;
  killed: boolean;
}

interface Session {
  id: string;
  ownerKey: string;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  activityTtlMs: number | null;
  context: BrowserContext;
  page: Page;
  cdp: string;
  dir: string;
  busy: boolean;
}

const RUNNER = fileURLToPath(new URL('./run-code.mjs', import.meta.url));
const MAX_OUTPUT = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function readDevToolsPort(dir: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (port > 0) return port;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new IceCrawlError('TARGET_ERROR', 'The browser did not open its debugging port');
}

/**
 * Long-lived browser sessions for /interact: one Chromium per session with a remote-debugging port on 127.0.0.1,
 * all traffic through the SSRF egress proxy. `execute` runs code in a child process that attaches to the session.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private proxy: Promise<EgressProxy> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: SessionManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.timer = setInterval(() => void this.sweep(), 10_000);
    this.timer.unref();
  }

  get codeEnabled(): boolean {
    return this.opts.allowCode;
  }

  private info(s: Session): SessionInfo {
    return { id: s.id, ownerKey: s.ownerKey, createdAt: iso(s.createdAt), lastActivity: iso(s.lastActivity), expiresAt: iso(s.expiresAt), status: 'active' };
  }

  async create(o: { ownerKey: string; ttlMs: number; activityTtlMs?: number; url?: string }): Promise<SessionInfo> {
    if (this.sessions.size >= (this.opts.maxSessions ?? 5)) {
      throw new IceCrawlError('RATE_LIMITED', `The server allows ${this.opts.maxSessions ?? 5} interact sessions at once; delete one first.`);
    }
    if (o.url) assertUrlAllowed(o.url, this.opts.allowPrivateNetworks);
    this.proxy ??= startEgressProxy({ allowPrivate: this.opts.allowPrivateNetworks });
    const proxy = await this.proxy;
    const dir = await mkdtemp(join(tmpdir(), 'icecrawl-session-'));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(dir, {
        headless: true,
        args: ['--remote-debugging-port=0', ...(this.opts.noSandbox ? ['--no-sandbox'] : [])],
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
      });
      const port = await readDevToolsPort(dir);
      const page = context.pages()[0] ?? (await context.newPage());
      const now = this.now();
      const s: Session = {
        id: randomUUID(),
        ownerKey: o.ownerKey,
        createdAt: now,
        lastActivity: now,
        expiresAt: now + o.ttlMs,
        activityTtlMs: o.activityTtlMs ?? null,
        context,
        page,
        cdp: `http://127.0.0.1:${port}`,
        dir,
        busy: false,
      };
      this.sessions.set(s.id, s);
      if (o.url) await page.goto(o.url, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
      return this.info(s);
    } catch (err) {
      await context?.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof IceCrawlError) throw err;
      throw new IceCrawlError('TARGET_ERROR', `Could not start the browser: ${((err as Error).message ?? '').split('\n')[0]}`);
    }
  }

  private owned(id: string, ownerKey: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.ownerKey !== ownerKey) throw new IceCrawlError('NOT_FOUND', 'Session not found');
    return s;
  }

  list(ownerKey: string): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.ownerKey === ownerKey).map((s) => this.info(s));
  }

  has(id: string, ownerKey: string): boolean {
    return this.sessions.get(id)?.ownerKey === ownerKey;
  }

  async destroy(id: string, ownerKey: string): Promise<{ durationMs: number }> {
    const s = this.owned(id, ownerKey);
    this.sessions.delete(id);
    await s.context.close().catch(() => undefined);
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    return { durationMs: this.now() - s.createdAt };
  }

  async execute(id: string, ownerKey: string, o: { code: string; language: string; timeoutMs: number }): Promise<ExecResult> {
    if (!this.opts.allowCode) {
      throw new IceCrawlError('UNSUPPORTED_OPTION', 'Code execution is turned off on this server. The operator can enable it with ICECRAWL_INTERACT_CODE=true (see docs/interact.md).');
    }
    if (o.language !== 'node') throw new IceCrawlError('UNSUPPORTED_OPTION', `language "${o.language}" is not supported; only node is.`);
    const s = this.owned(id, ownerKey);
    if (s.busy) throw new IceCrawlError('CONFLICT', 'The session is already running code; wait for it to finish.');
    s.busy = true;
    s.lastActivity = this.now();
    try {
      return await this.run(s, o.code, o.timeoutMs);
    } finally {
      s.busy = false;
      s.lastActivity = this.now();
    }
  }

  private run(s: Session, code: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve) => {
      // empty environment: no API keys, database URLs or signing keys reach the code
      const child = spawn(process.execPath, ['--max-old-space-size=256', RUNNER], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => void (out.length < MAX_OUTPUT && (out += d.toString())));
      child.stderr.on('data', (d: Buffer) => void (err.length < MAX_OUTPUT && (err += d.toString())));
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        let stdout: string | null = null;
        let result: string | null = null;
        try {
          const parsed = JSON.parse(out.trim().split('\n').pop() ?? '') as { stdout: string; result: string | null };
          stdout = parsed.stdout;
          result = parsed.result;
        } catch {
          stdout = out || null;
        }
        resolve({ stdout, result, stderr: err || null, exitCode: killed ? null : exitCode, killed });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify({ code, cdp: s.cdp }));
    });
  }

  /** Destroys sessions past their lifetime or idle for longer than their activity limit. */
  async sweep(): Promise<number> {
    const now = this.now();
    const dead = [...this.sessions.values()].filter((s) => !s.busy && (now >= s.expiresAt || (s.activityTtlMs !== null && now - s.lastActivity >= s.activityTtlMs)));
    for (const s of dead) await this.destroy(s.id, s.ownerKey).catch(() => undefined);
    return dead.length;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of [...this.sessions.values()]) await this.destroy(s.id, s.ownerKey).catch(() => undefined);
    if (this.proxy) await (await this.proxy).close().catch(() => undefined);
    this.proxy = null;
  }
}
