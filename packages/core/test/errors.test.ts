import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, IceCrawlError, VERDICT_ERROR_CODE, VERDICTS } from '../src';

describe('IceCrawlError', () => {
  it('derives its HTTP status from the code', () => {
    const e = new IceCrawlError('NO_ENGINE', 'nope');
    expect(e.status).toBe(422);
    expect(e.code).toBe('NO_ENGINE');
    expect(e.message).toBe('nope');
  });

  it('answers rate limiting with 429', () => {
    expect(new IceCrawlError('RATE_LIMITED', 'slow down').status).toBe(429);
  });

  it('has statuses for the phase 5 codes', () => {
    expect(new IceCrawlError('LLM_NOT_CONFIGURED', 'x').status).toBe(501);
    expect(new IceCrawlError('SEARCH_NOT_CONFIGURED', 'x').status).toBe(501);
    expect(new IceCrawlError('LLM_ERROR', 'x').status).toBe(502);
    expect(new IceCrawlError('EXTRACTION_FAILED', 'x').status).toBe(422);
  });

  it('maps every non-ok verdict to a known error code', () => {
    for (const v of VERDICTS.filter((x) => x !== 'ok')) {
      const code = VERDICT_ERROR_CODE[v as Exclude<(typeof VERDICTS)[number], 'ok'>];
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
