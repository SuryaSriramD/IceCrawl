import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightEngine, fetchEngine } from '@icecrawl/engines';
import { BROWSER_CORPUS, CORPUS, FETCH_CORPUS, formatReport, runBenchmark, startFixtureServer, summarize, type FixtureServer } from '../src';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe('corpus', () => {
  it('has unique ids and paths, and enough variety to mean something', () => {
    expect(new Set(CORPUS.map((e) => e.id)).size).toBe(CORPUS.length);
    expect(new Set(CORPUS.map((e) => e.path)).size).toBe(CORPUS.length);
    expect(CORPUS.length).toBeGreaterThanOrEqual(55);
    const verdicts = new Set(CORPUS.map((e) => e.expected));
    for (const v of ['ok', 'blocked', 'captcha', 'login_wall', 'empty', 'soft_404', 'truncated', 'uncertain', 'error'] as const) {
      expect(verdicts.has(v), v).toBe(true);
    }
    expect(CORPUS.filter((e) => e.injection === 'flagged').length).toBeGreaterThanOrEqual(6);
    expect(CORPUS.filter((e) => e.injection === 'clean').length).toBeGreaterThanOrEqual(10);
  });
});

describe('verdict benchmark (fetch engine)', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('never accepts a page a human would reject, and never rejects a good one', async () => {
    const outcomes = await runBenchmark(server.origin, FETCH_CORPUS);
    const s = summarize(outcomes);
    const report = formatReport(outcomes);
    expect(s.falseAccepts.map((o) => o.id), report).toEqual([]);
    expect(s.falseRejects.map((o) => o.id), report).toEqual([]);
    expect(s.mismatches.map((o) => `${o.id}: expected ${o.expected}, got ${o.actual}`), report).toEqual([]);
    for (const v of s.perVerdict) {
      expect(v.precision, `${v.verdict} precision\n${report}`).toBe(1);
      expect(v.recall, `${v.verdict} recall\n${report}`).toBe(1);
    }
  });

  it('flags every attack page and no clean page', async () => {
    const s = summarize(await runBenchmark(server.origin, FETCH_CORPUS));
    expect(s.injection).toMatchObject({ falseNegatives: 0, falsePositives: 0 });
    expect(s.injection.truePositives).toBeGreaterThanOrEqual(6);
  });

  it('reports the known gaps and notices when one is fixed', async () => {
    const s = summarize(await runBenchmark(server.origin, FETCH_CORPUS));
    expect(s.knownGaps.length).toBeGreaterThanOrEqual(1);
    for (const g of s.knownGaps) {
      expect(g.actual, `${g.id} is no longer a gap: remove its knownGap and let it count toward the targets`).not.toBe(g.expected);
    }
  });

  it('shows that JavaScript-only pages are empty to a plain fetch', async () => {
    const outcomes = await runBenchmark(server.origin, BROWSER_CORPUS);
    expect(outcomes.map((o) => o.actual)).toEqual(BROWSER_CORPUS.map(() => 'empty'));
  });
});

describe.skipIf(!hasBrowser)('verdict benchmark (browser engine)', () => {
  it('reads JavaScript-rendered pages as ok', async () => {
    const server = await startFixtureServer();
    const browser = createPlaywrightEngine({ noSandbox: process.env.CI === 'true' });
    try {
      const outcomes = await runBenchmark(server.origin, BROWSER_CORPUS, [browser, fetchEngine]);
      expect(outcomes.map((o) => o.actual)).toEqual(BROWSER_CORPUS.map((e) => e.expected));
    } finally {
      await browser.close();
      await server.close();
    }
  }, 60_000);
});
