import type { TrustBlock } from './trust';

export interface ScrapeMetadata {
  title: string | null;
  description: string | null;
  language: string | null;
  sourceURL: string;
  url: string;
  statusCode: number;
  contentType: string;
  scrapeId: string;
  [key: string]: unknown;
}

export interface ScrapeDocument {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  actions?: {
    screenshots: string[];
    scrapes: Array<{ url: string; html: string }>;
    javascriptReturns: Array<{ type: string; value: unknown }>;
    pdfs: string[];
  };
  metadata: ScrapeMetadata;
  warning?: string;
  trust: TrustBlock;
}

export type JobState = 'scraping' | 'completed' | 'failed' | 'cancelled';

export interface JobStatusResponse {
  success: true;
  status: JobState;
  total: number;
  completed: number;
  creditsUsed: number;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  duration: number;
  next: string | null;
  data: ScrapeDocument[];
}

export interface JobStartResponse {
  success: true;
  id: string;
  url: string;
  warning?: string;
  invalidURLs?: string[];
}

export interface JobErrorsResponse {
  errors: Array<{ id: string; timestamp: string; url: string; error: string }>;
  robotsBlocked: string[];
}

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface ApiErrorBody {
  success: false;
  code: string;
  error: string;
  trust?: TrustBlock;
}
