import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig injection mode', () => {
  it('defaults to flag', () => expect(loadConfig({}).injection).toBe('flag'));
  it.each(['off', 'flag', 'quarantine'] as const)('accepts %s', (mode) => expect(loadConfig({ ICECRAWL_INJECTION: mode }).injection).toBe(mode));
  it('rejects unknown values so a typo cannot silently disable protection', () => {
    expect(() => loadConfig({ ICECRAWL_INJECTION: 'quarantene' })).toThrow(/ICECRAWL_INJECTION/);
  });
});
