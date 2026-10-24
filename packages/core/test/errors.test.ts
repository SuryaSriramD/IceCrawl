import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, IceCrawlError, VERDICT_ERROR_CODE, VERDICTS } from '../src';

describe('IceCrawlError', () => {
  it('derives its HTTP status from the code', () => {
    const e = new IceCrawlError('NO_ENGINE', 'nope');
    expect(e.status).toBe(422);
    expect(e.code).toBe('NO_ENGINE');
    expect(e.message).toBe('nope');
  });

  it('maps every non-ok verdict to a known error code', () => {
    for (const v of VERDICTS.filter((x) => x !== 'ok')) {
      const code = VERDICT_ERROR_CODE[v as Exclude<(typeof VERDICTS)[number], 'ok'>];
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
