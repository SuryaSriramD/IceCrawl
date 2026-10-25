import type { Action, ScreenshotOptions } from '@icecrawl/core';
import type { FeatureFlag } from './flags';

export interface EngineContext {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  skipTlsVerification: boolean;
  allowPrivateNetworks: boolean;
  maxBytes: number;
  waitFor: number;
  mobile: boolean;
  actions: Action[];
  screenshot: ScreenshotOptions | null;
  /** Operator proxy to send this request through (http(s) URL, may hold credentials). Absent: connect directly. */
  proxy?: string;
  /** Present a regular browser fingerprint instead of the honest IceCrawl one. Set together with `proxy`. */
  stealth?: boolean;
}

export interface ActionOutputs {
  screenshots: Uint8Array[];
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
  pdfs: Uint8Array[];
}

export interface EngineResult {
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
  truncated: boolean;
  screenshot?: Uint8Array;
  actions?: ActionOutputs;
}

export interface Engine {
  name: string;
  quality: number;
  features: Record<FeatureFlag, boolean>;
  maxReasonableTimeMs: number;
  scrape(ctx: EngineContext): Promise<EngineResult>;
}
