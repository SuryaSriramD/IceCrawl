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

export type InjectionSeverity = 'low' | 'medium' | 'high';
export type InjectionKind =
  | 'instruction'
  | 'role_override'
  | 'exfiltration'
  | 'tool_abuse'
  | 'hidden_text'
  | 'invisible_chars'
  | 'encoded_payload';

export interface InjectionFinding {
  kind: InjectionKind;
  severity: InjectionSeverity;
  rule: string;
  excerpt: string;
  hidden: boolean;
  location: 'markdown' | 'html';
}

export interface ScanSummary {
  scanner: { name: string; version: string };
  flagged: boolean;
  highest: InjectionSeverity | null;
  count: number;
}

export interface InjectionReport extends ScanSummary {
  findings: InjectionFinding[];
}

export interface TrustBlock {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  receiptId: string;
  engine: string;
  injection?: InjectionReport;
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

export interface ReceiptOptions {
  onlyMainContent: boolean;
  skipTlsVerification: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images?: boolean;
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
  contentType?: string | null;
  screenshotSha256?: string | null;
  scan?: ScanSummary | null;
  options: ReceiptOptions;
}

export interface ReceiptSignature {
  alg: 'Ed25519';
  keyId: string;
  /** base64 Ed25519 signature over the RFC 8785 canonical JSON of the receipt */
  sig: string;
}

export interface PublicKeyEntry {
  keyId: string;
  alg: 'Ed25519';
  /** base64 of the SPKI DER encoding */
  publicKey: string;
  createdAt: string;
  retiredAt: string | null;
}

export interface SignedReceipt {
  receipt: Receipt;
  signature: ReceiptSignature | null;
}
