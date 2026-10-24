import type { FeatureFlag } from './flags';

export interface EngineContext {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  skipTlsVerification: boolean;
  allowPrivateNetworks: boolean;
  maxBytes: number;
}

export interface EngineResult {
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
  truncated: boolean;
}

export interface Engine {
  name: string;
  quality: number;
  features: Record<FeatureFlag, boolean>;
  maxReasonableTimeMs: number;
  scrape(ctx: EngineContext): Promise<EngineResult>;
}
