import { describe, expect, it } from 'vitest';
import { featureSet, pickEngines, type Engine, type FeatureFlag } from '../src';

const fake = (name: string, quality: number, on: FeatureFlag[]): Engine => ({
  name,
  quality,
  features: featureSet(on),
  maxReasonableTimeMs: 1000,
  scrape: async () => {
    throw new Error('unused');
  },
});

const fetchE = fake('fetch', 5, ['skipTlsVerification']);
const browser = fake('browser', 20, ['skipTlsVerification', 'waitFor', 'actions']);
const pdf = fake('pdf', -20, ['pdf', 'skipTlsVerification']);
const names = (flags: FeatureFlag[], reg: Engine[]) => pickEngines(new Set(flags), reg).map((p) => p.engine.name);

describe('pickEngines', () => {
  it('orders equal-score engines by quality', () => {
    expect(names(['skipTlsVerification'], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });

  it('prefers the engine supporting more flag priority', () => {
    expect(names(['waitFor', 'skipTlsVerification'], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });

  it('keeps a lesser engine when the soft flag is unsupported and reports it', () => {
    const [p] = pickEngines(new Set<FeatureFlag>(['waitFor', 'skipTlsVerification']), [fetchE]);
    expect(p.engine.name).toBe('fetch');
    expect([...p.unsupported]).toEqual(['waitFor']);
  });

  it('returns nothing when a heavy flag (actions) is unsupported by every engine', () => {
    expect(names(['actions', 'skipTlsVerification'], [fetchE])).toEqual([]);
  });

  it('routes actions to the engine that supports them', () => {
    expect(names(['actions', 'skipTlsVerification'], [fetchE, browser])).toEqual(['browser']);
  });

  it('routes a pdf request to the pdf engine only', () => {
    expect(names(['pdf', 'skipTlsVerification'], [fetchE, browser, pdf])).toEqual(['pdf']);
  });

  it('drops negative-quality engines when a positive one qualifies', () => {
    const stealthish = fake('stealth', -2, ['skipTlsVerification']);
    expect(names(['skipTlsVerification'], [fetchE, stealthish])).toEqual(['fetch']);
  });

  it('keeps every engine when no flag is set', () => {
    expect(names([], [fetchE, browser])).toEqual(['browser', 'fetch']);
  });
});
