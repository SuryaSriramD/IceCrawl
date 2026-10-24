import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { IceCrawlError, type Action, type ScreenshotOptions } from '@icecrawl/core';
import { startEgressProxy, type EgressProxy } from './egress-proxy';
import { featureSet } from './flags';
import { assertUrlAllowed } from './ssrf';
import type { ActionOutputs, Engine, EngineContext, EngineResult } from './types';

export interface PlaywrightEngineOptions {
  quality?: number;
  maxConcurrency?: number;
  noSandbox?: boolean;
}

export type PlaywrightEngine = Engine & { close(): Promise<void> };

const INSTALL_HINT = 'Chromium is not installed. Run: pnpm --filter @icecrawl/engines exec playwright-core install chromium';

class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

function browserUnavailable(err: unknown): IceCrawlError {
  const msg = (err as Error).message ?? String(err);
  if (/Executable doesn't exist/i.test(msg)) return new IceCrawlError('TARGET_ERROR', INSTALL_HINT);
  return new IceCrawlError('TARGET_ERROR', `Could not start the browser: ${msg.split('\n')[0]}`);
}

function mapError(err: unknown, s: { timedOut: boolean; blockedHosts: string[] }): IceCrawlError {
  if (s.timedOut) return new IceCrawlError('TIMEOUT', 'Timed out rendering the page');
  if (err instanceof IceCrawlError) return err;
  const e = err as { name?: string; message?: string };
  const msg = e.message ?? String(err);
  if (e.name === 'TimeoutError') return new IceCrawlError('TIMEOUT', 'Timed out rendering the page');
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return new IceCrawlError('DNS', 'Could not resolve the host');
  if (/ERR_CERT|ERR_SSL|SSL_ERROR/.test(msg)) return new IceCrawlError('SSL', `TLS error: ${msg.split('\n')[0]}`);
  // shortcut: a block is attributed to this scrape if the proxy blocked anything while it ran; a concurrent scrape's block can be misattributed, which only changes the error code. Upgrade by tagging proxy requests per context.
  if (s.blockedHosts.length > 0 && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_ABORTED/.test(msg)) {
    return new IceCrawlError('SSRF_BLOCKED', `Blocked request to a private address: ${s.blockedHosts[0]}`);
  }
  if (/Executable doesn't exist/i.test(msg)) return new IceCrawlError('TARGET_ERROR', INSTALL_HINT);
  return new IceCrawlError('TARGET_ERROR', msg.split('\n')[0]);
}

async function takeScreenshot(page: Page, o: ScreenshotOptions): Promise<Uint8Array> {
  const previous = page.viewportSize();
  if (o.viewport) await page.setViewportSize(o.viewport);
  try {
    return await page.screenshot({ type: 'png', fullPage: o.fullPage });
  } finally {
    if (o.viewport && previous) await page.setViewportSize(previous);
  }
}

async function runActions(page: Page, actions: Action[]): Promise<ActionOutputs> {
  const out: ActionOutputs = { screenshots: [], scrapes: [], javascriptReturns: [], pdfs: [] };
  for (const [i, a] of actions.entries()) {
    try {
      switch (a.type) {
        case 'wait':
          if (a.milliseconds !== undefined) await page.waitForTimeout(a.milliseconds);
          else await page.waitForSelector(a.selector!, { state: 'visible' });
          break;
        case 'click':
          if (a.all) for (const el of await page.locator(a.selector).all()) await el.click();
          else await page.locator(a.selector).first().click();
          break;
        case 'write':
          await page.keyboard.type(a.text);
          break;
        case 'press':
          await page.keyboard.press(a.key);
          break;
        case 'scroll': {
          const dir = a.direction === 'up' ? -1 : 1;
          if (a.selector) {
            await page.locator(a.selector).first().evaluate((el, d) => el.scrollBy(0, d * (el as HTMLElement).clientHeight), dir);
          } else {
            await page.evaluate((d) => window.scrollBy(0, d * window.innerHeight), dir);
          }
          break;
        }
        case 'screenshot':
          out.screenshots.push(await takeScreenshot(page, { fullPage: a.fullPage, quality: a.quality, viewport: a.viewport }));
          break;
        case 'scrape':
          out.scrapes.push({ url: page.url(), html: await page.content() });
          break;
        case 'executeJavascript': {
          const value = await page.evaluate(a.script);
          out.javascriptReturns.push({ type: typeof value, value });
          break;
        }
        case 'pdf':
          out.pdfs.push(await page.pdf({ format: a.format, landscape: a.landscape, scale: a.scale }));
          break;
      }
    } catch (err) {
      if (err instanceof IceCrawlError) throw err;
      throw new IceCrawlError('ACTION_FAILED', `Action ${i} (${a.type}) failed: ${((err as Error).message ?? '').split('\n')[0]}`);
    }
  }
  return out;
}

export function createPlaywrightEngine(opts: PlaywrightEngineOptions = {}): PlaywrightEngine {
  const semaphore = new Semaphore(opts.maxConcurrency ?? 4);
  let browserPromise: Promise<Browser> | null = null;
  const proxies = new Map<boolean, Promise<EgressProxy>>();

  const getBrowser = (): Promise<Browser> => {
    browserPromise ??= chromium
      .launch({ headless: true, proxy: { server: 'http://per-context' }, args: opts.noSandbox ? ['--no-sandbox'] : [] })
      .catch((err) => {
        browserPromise = null;
        throw browserUnavailable(err);
      });
    return browserPromise;
  };

  const getProxy = (allowPrivate: boolean): Promise<EgressProxy> => {
    let p = proxies.get(allowPrivate);
    if (!p) {
      p = startEgressProxy({ allowPrivate });
      proxies.set(allowPrivate, p);
    }
    return p;
  };

  async function scrape(ctx: EngineContext): Promise<EngineResult> {
    assertUrlAllowed(ctx.url, ctx.allowPrivateNetworks);
    await semaphore.acquire();
    let context: BrowserContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const blockedHosts: string[] = [];
    let unsubscribe = () => {};
    try {
      const browser = await getBrowser();
      const proxy = await getProxy(ctx.allowPrivateNetworks);
      unsubscribe = proxy.onBlocked((host) => blockedHosts.push(host));

      const chrome = browser.version();
      const userAgent = ctx.mobile
        ? `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36 IceCrawl/0.1`
        : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 IceCrawl/0.1`;
      context = await browser.newContext({
        ignoreHTTPSErrors: ctx.skipTlsVerification,
        userAgent,
        viewport: ctx.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: ctx.mobile,
        hasTouch: ctx.mobile,
        extraHTTPHeaders: ctx.headers,
        serviceWorkers: 'block',
        acceptDownloads: false,
        proxy: { server: proxy.url, bypass: '<-loopback>' },
      });
      const live = context;
      timer = setTimeout(() => {
        timedOut = true;
        void live.close().catch(() => undefined);
      }, ctx.timeoutMs);

      const page = await context.newPage();
      // actions must fail before the scrape wall clock so they report ACTION_FAILED, not TIMEOUT
      page.setDefaultTimeout(Math.floor(ctx.timeoutMs / 2));
      page.setDefaultNavigationTimeout(ctx.timeoutMs);

      const response = await page.goto(ctx.url, { waitUntil: 'load' });
      if (!response) throw new IceCrawlError('TARGET_ERROR', 'Navigation produced no response');
      const headers = response.headers();
      if (headers['x-icecrawl-blocked']) {
        throw new IceCrawlError('SSRF_BLOCKED', 'Blocked request to a private address');
      }

      const contentType = headers['content-type'] ?? '';
      if (contentType !== '' && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        const raw = await response.body();
        if (raw.length > ctx.maxBytes) throw new IceCrawlError('RESPONSE_TOO_LARGE', `Response exceeds ${ctx.maxBytes} bytes`);
        return { finalUrl: page.url(), statusCode: response.status(), headers, body: raw, contentType, truncated: false };
      }

      await page.waitForLoadState('networkidle', { timeout: Math.min(5000, ctx.timeoutMs) }).catch(() => undefined);
      if (ctx.waitFor > 0) await page.waitForTimeout(ctx.waitFor);
      const actions = ctx.actions.length > 0 ? await runActions(page, ctx.actions) : undefined;
      const screenshot = ctx.screenshot ? await takeScreenshot(page, ctx.screenshot) : undefined;

      const body = Buffer.from(await page.content(), 'utf8');
      if (body.length > ctx.maxBytes) throw new IceCrawlError('RESPONSE_TOO_LARGE', `Rendered page exceeds ${ctx.maxBytes} bytes`);
      return {
        finalUrl: page.url(),
        statusCode: response.status(),
        headers,
        body,
        contentType: 'text/html; charset=utf-8',
        truncated: false,
        screenshot,
        actions,
      };
    } catch (err) {
      throw mapError(err, { timedOut, blockedHosts });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      await context?.close().catch(() => undefined);
      semaphore.release();
    }
  }

  return {
    name: 'playwright',
    quality: opts.quality ?? 20,
    features: featureSet(['actions', 'waitFor', 'screenshot', 'screenshot@fullScreen', 'mobile', 'skipTlsVerification']),
    maxReasonableTimeMs: 30_000,
    scrape,
    async close() {
      const browser = browserPromise ? await browserPromise.catch(() => null) : null;
      browserPromise = null;
      await browser?.close().catch(() => undefined);
      for (const p of proxies.values()) await (await p).close().catch(() => undefined);
      proxies.clear();
    },
  };
}
