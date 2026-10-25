import type { GroundedField, GroundingReport, GroundingStatus } from '@icecrawl/core';

const MAX_LEAVES = 2000;
const MAX_FIELDS = 500;
const MAX_DEPTH = 20;
const PARTIAL_MIN_WORDS = 4;
const PARTIAL_SHARE = 0.8;

const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const squash = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
const numeric = (s: string): string => s.replace(/\u2212/g, '-').replace(/(?<=\d)[,\u00a0\u202f](?=\d{3}(?!\d))/g, '');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Prepared {
  norm: string;
  squash: string;
  words: Set<string>;
  numeric: string;
}

const prepare = (text: string): Prepared => {
  const n = norm(text);
  return { norm: n, squash: squash(n), words: new Set(words(n)), numeric: numeric(n) };
};

interface Verdict {
  status: GroundingStatus;
  source: number | null;
}
const found = (source: number): Verdict => ({ status: 'grounded', source });
const missing: Verdict = { status: 'ungrounded', source: null };

function numberRegex(n: number): RegExp | null {
  if (!Number.isFinite(n)) return null;
  const s = String(n);
  if (/e/i.test(s)) return null;
  return Number.isInteger(n)
    ? new RegExp(`(?<![\\d.])${escapeRe(s)}(?:\\.0+)?(?!\\d|\\.\\d)`)
    : new RegExp(`(?<![\\d.])${escapeRe(s)}0*(?!\\d)`);
}

function checkNumber(n: number, sources: Prepared[]): Verdict | null {
  const re = numberRegex(n);
  if (!re) return null;
  const i = sources.findIndex((s) => re.test(s.numeric));
  return i === -1 ? missing : found(i);
}

const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(,\d{3})*(\.\d+)?$/;

function checkString(raw: string, sources: Prepared[]): Verdict | null {
  const n = norm(raw);
  if (n.length < 2) return null;
  if (PLAIN_NUMBER.test(n)) {
    const asNumber = Number(n.replace(/,/g, ''));
    if (Number.isFinite(asNumber) && (n === '0' || !/^-?0\d/.test(n))) return checkNumber(asNumber, sources);
  }
  let i = sources.findIndex((s) => s.norm.includes(n));
  if (i !== -1) return found(i);
  const sq = squash(n);
  if (sq.length >= 3) {
    i = sources.findIndex((s) => s.squash.includes(sq));
    if (i !== -1) return found(i);
  }
  const parts = words(n);
  if (parts.length >= PARTIAL_MIN_WORDS) {
    let best = -1;
    let bestShare = 0;
    sources.forEach((s, idx) => {
      const share = parts.filter((w) => s.words.has(w)).length / parts.length;
      if (share > bestShare) {
        best = idx;
        bestShare = share;
      }
    });
    if (bestShare >= PARTIAL_SHARE) return { status: 'partial', source: best };
  }
  return missing;
}

const RANK: Record<GroundingStatus, number> = { ungrounded: 0, partial: 1, grounded: 2 };

export function checkGrounding(data: unknown, sourceTexts: readonly string[]): GroundingReport {
  const sources = sourceTexts.map(prepare);
  const all: GroundedField[] = [];
  let truncated = false;

  const visit = (value: unknown, path: string, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        visit(v, /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`, depth + 1);
      }
      return;
    }
    const verdict = typeof value === 'string' ? checkString(value, sources) : typeof value === 'number' ? checkNumber(value, sources) : null;
    if (!verdict) return;
    if (all.length >= MAX_LEAVES) {
      truncated = true;
      return;
    }
    all.push({ path, status: verdict.status, source: verdict.source });
  };
  visit(data, '$', 0);

  const count = (status: GroundingStatus) => all.filter((f) => f.status === status).length;
  const ordered = [...all].sort((a, b) => RANK[a.status] - RANK[b.status]);
  if (ordered.length > MAX_FIELDS) truncated = true;
  return {
    checked: all.length,
    grounded: count('grounded'),
    partial: count('partial'),
    ungrounded: count('ungrounded'),
    fields: ordered.slice(0, MAX_FIELDS),
    truncated,
  };
}

export function attributeSources(fields: readonly GroundedField[], urls: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    const url = f.source === null ? undefined : urls[f.source];
    if (url) out[f.path] = [url];
  }
  return out;
}
