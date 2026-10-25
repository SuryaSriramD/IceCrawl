import { IceCrawlError, normalizeScrapeRequest, VERDICTS, type Verdict } from '@icecrawl/core';
import { fetchEngine, type Engine } from '@icecrawl/engines';
import { runScrape } from '@icecrawl/scraper';
import type { CorpusEntry } from './corpus';

export interface Outcome {
  id: string;
  expected: Verdict;
  actual: Verdict;
  /** True when the pipeline would hand the page to the caller as content (measured in strict mode, where an uncertain page is refused). */
  accepted: boolean;
  /** The scanner flagged the page as a prompt-injection attempt (medium or high). */
  flagged: boolean;
  injection?: 'flagged' | 'clean';
  knownGap?: string;
  reasons: string[];
}

export async function runBenchmark(origin: string, entries: readonly CorpusEntry[], engines: Engine[] = [fetchEngine]): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const e of entries) {
    const base = { id: e.id, expected: e.expected, injection: e.injection, knownGap: e.knownGap };
    try {
      const n = normalizeScrapeRequest({ url: `${origin}${e.path}`, timeout: 10_000 });
      const run = await runScrape(
        { engines, config: { allowPrivateNetworks: true, maxResponseBytes: 5_000_000, strict: true, injection: 'flag' } },
        n,
      );
      out.push({ ...base, actual: run.verdict, accepted: run.accepted, flagged: run.injection?.flagged === true, reasons: run.reasons });
    } catch (err) {
      // an engine that cannot fetch the page at all is an honest "error"
      out.push({ ...base, actual: 'error', accepted: false, flagged: false, reasons: [err instanceof IceCrawlError ? err.code : 'THROWN'] });
    }
  }
  return out;
}

export interface VerdictStats {
  verdict: Verdict;
  support: number;
  truePositives: number;
  falsePositives: number;
  precision: number | null;
  recall: number | null;
}

export interface Summary {
  counted: number;
  /** Pages a human would reject that the pipeline accepted as content. The number that matters most. */
  falseAccepts: Outcome[];
  /** Good pages the pipeline refused. */
  falseRejects: Outcome[];
  /** Entries whose verdict differs from the label, whatever the direction. */
  mismatches: Outcome[];
  perVerdict: VerdictStats[];
  injection: { truePositives: number; falseNegatives: number; falsePositives: number; trueNegatives: number };
  knownGaps: Outcome[];
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function summarize(all: readonly Outcome[]): Summary {
  const gaps = all.filter((o) => o.knownGap);
  const counted = all.filter((o) => !o.knownGap);
  const perVerdict: VerdictStats[] = VERDICTS.map((verdict) => {
    const tp = counted.filter((o) => o.expected === verdict && o.actual === verdict).length;
    const fp = counted.filter((o) => o.expected !== verdict && o.actual === verdict).length;
    const fn = counted.filter((o) => o.expected === verdict && o.actual !== verdict).length;
    return { verdict, support: tp + fn, truePositives: tp, falsePositives: fp, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  }).filter((s) => s.support > 0 || s.falsePositives > 0);
  const inj = counted.filter((o) => o.injection);
  return {
    counted: counted.length,
    falseAccepts: counted.filter((o) => o.expected !== 'ok' && o.accepted),
    falseRejects: counted.filter((o) => o.expected === 'ok' && !o.accepted),
    mismatches: counted.filter((o) => o.expected !== o.actual),
    perVerdict,
    injection: {
      truePositives: inj.filter((o) => o.injection === 'flagged' && o.flagged).length,
      falseNegatives: inj.filter((o) => o.injection === 'flagged' && !o.flagged).length,
      falsePositives: inj.filter((o) => o.injection === 'clean' && o.flagged).length,
      trueNegatives: inj.filter((o) => o.injection === 'clean' && !o.flagged).length,
    },
    knownGaps: gaps,
  };
}

const pct = (v: number | null) => (v === null ? '  n/a' : `${(v * 100).toFixed(0).padStart(4)}%`);

export function formatReport(all: readonly Outcome[]): string {
  const s = summarize(all);
  const lines = [
    `Verdict benchmark: ${s.counted} pages counted, ${s.knownGaps.length} known gaps reported separately`,
    `false accepts: ${s.falseAccepts.length}   false rejects: ${s.falseRejects.length}   label mismatches: ${s.mismatches.length}`,
    '',
    'verdict      support  precision  recall',
    ...s.perVerdict.map((v) => `${v.verdict.padEnd(12)} ${String(v.support).padStart(7)}  ${pct(v.precision)}      ${pct(v.recall)}`),
    '',
    `injection scan: flagged ${s.injection.truePositives}/${s.injection.truePositives + s.injection.falseNegatives} attack pages, flagged ${s.injection.falsePositives}/${s.injection.falsePositives + s.injection.trueNegatives} clean pages`,
  ];
  for (const m of s.mismatches) lines.push(`  mismatch ${m.id}: expected ${m.expected}, got ${m.actual} (${m.reasons.join(', ')})`);
  for (const g of s.knownGaps) lines.push(`  known gap ${g.id}: expected ${g.expected}, got ${g.actual} - ${g.knownGap}`);
  return lines.join('\n');
}
