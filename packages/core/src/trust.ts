import type { ErrorCode } from './errors';

export const VERDICTS = [
  'ok',
  'blocked',
  'login_wall',
  'captcha',
  'empty',
  'soft_404',
  'truncated',
  'uncertain',
  'error',
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_ERROR_CODE: Record<Exclude<Verdict, 'ok'>, ErrorCode> = {
  blocked: 'BLOCKED',
  login_wall: 'LOGIN_WALL',
  captcha: 'CAPTCHA',
  empty: 'EMPTY_CONTENT',
  soft_404: 'SOFT_404',
  truncated: 'TRUNCATED',
  uncertain: 'UNCERTAIN',
  error: 'TARGET_ERROR',
};

export interface TrustBlock {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  receiptId: string;
  engine: string;
}

export interface EngineAttempt {
  engine: string;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  statusCode?: number;
  durationMs: number;
  error?: string;
}

export interface Receipt {
  version: 1;
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  fetchedAt: string;
  engineChain: EngineAttempt[];
  htmlSha256: string | null;
  outputSha256: string | null;
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}
