import type { ExtractionReport, ScanSummary, TrustBlock, Verdict } from './trust';

export interface ScrapeMetadata {
  title?: string | null;
  description?: string | null;
  language?: string | null;
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
  json?: unknown;
  summary?: string;
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

/** Trust data of one search result: the page's trust block when it was scraped, plus the scan of its title and description. */
export interface SearchResultTrust extends Partial<TrustBlock> {
  snippetInjection?: ScanSummary;
}

export interface SearchWebResult {
  title: string;
  description: string;
  url: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  json?: unknown;
  summary?: string;
  metadata?: Partial<ScrapeMetadata> & { error?: string };
  trust?: SearchResultTrust;
  warning?: string;
}

export interface SearchImageResult {
  title: string;
  imageUrl: string;
  url: string;
  imageWidth?: number;
  imageHeight?: number;
}

export interface SearchNewsResult {
  title: string;
  snippet: string;
  url: string;
  date?: string;
  trust?: SearchResultTrust;
}

export interface SearchResponse {
  success: true;
  id: string;
  creditsUsed: number;
  warning?: string;
  data: { web?: SearchWebResult[]; images?: SearchImageResult[]; news?: SearchNewsResult[] };
}

export interface ExtractStartResponse {
  success: true;
  id: string;
  invalidURLs?: string[];
  warning?: string;
}

export interface ExtractSourceInfo {
  url: string;
  receiptId: string;
  verdict: Verdict;
  injectionFlagged: boolean;
}

export interface ExtractStatusResponse {
  success: true;
  status: 'processing' | 'completed' | 'failed' | 'cancelled';
  expiresAt: string;
  data?: unknown;
  tokensUsed?: number;
  error?: string;
  code?: string;
  warning?: string;
  /** Present when `showSources` was true: JSON path of an extracted value → URLs that contain it. */
  sources?: Record<string, string[]>;
  /** Pages that could not be used, with the reason. */
  skipped?: Array<{ url: string; error: string }>;
  trust?: { extraction: ExtractionReport; sources: ExtractSourceInfo[] };
}
