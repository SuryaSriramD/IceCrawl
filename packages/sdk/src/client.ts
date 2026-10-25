import type {
  ApiErrorBody,
  BatchOptions,
  CrawlOptions,
  ExtractOptions,
  ExtractStartResponse,
  ExtractStatusResponse,
  JobErrorsResponse,
  JobStartResponse,
  JobStatusResponse,
  MapLink,
  MapOptions,
  PublicKeyEntry,
  ScrapeDocument,
  ScrapeOptions,
  SearchOptions,
  SearchResponse,
  SignedReceipt,
  TrustBlock,
} from '@icecrawl/core';

export interface InteractSession {
  id: string;
  expiresAt: string;
  warning?: string;
}

export interface InteractResult {
  success: boolean;
  stdout: string | null;
  result: string | null;
  stderr: string | null;
  exitCode: number | null;
  killed: boolean;
  error: string | null;
}

export interface MonitorRequest {
  name: string;
  schedule: { cron: string; timezone?: string };
  targets: Array<Record<string, unknown>>;
  webhook?: { url: string; headers?: Record<string, string>; metadata?: Record<string, unknown>; events?: Array<'monitor.page' | 'monitor.check.completed'> };
  retentionDays?: number;
}

export interface MonitorSummary {
  totalPages: number;
  same: number;
  changed: number;
  new: number;
  removed: number;
  error: number;
}

export interface Monitor {
  id: string;
  name: string;
  status: 'active' | 'paused';
  schedule: { cron: string; timezone: string };
  nextRunAt: string | null;
  lastRunAt: string | null;
  currentCheckId: string | null;
  targets: Array<Record<string, unknown>>;
  lastCheckSummary?: MonitorSummary;
}

export interface MonitorPage {
  id: string;
  url: string;
  status: 'same' | 'new' | 'changed' | 'removed' | 'error';
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  error: string | null;
  diff: { text: string } | null;
}

export interface MonitorCheck {
  id: string;
  monitorId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'skipped_overlap' | 'skipped_no_credits';
  trigger: 'scheduled' | 'manual';
  summary?: MonitorSummary;
  error: string | null;
  pages?: MonitorPage[];
}

export interface AgentOptions {
  urls?: string[];
  schema?: Record<string, unknown>;
  strictConstrainToURLs?: boolean;
  effort?: 'low' | 'medium' | 'high';
}

export interface AgentStatus {
  success: boolean;
  status: 'processing' | 'completed' | 'failed';
  expiresAt?: string;
  data?: Record<string, unknown>;
  sources?: Array<{ url: string; receiptId: string }>;
  tokensUsed?: number;
  error?: string;
  code?: string;
}

/** A file to parse with `IceCrawl.parse`. */
export interface ParseFile {
  name: string;
  data: Uint8Array;
  /** Defaults to application/octet-stream; the server also goes by the file name and the file's own signature. */
  type?: string;
}

export type ParseOptions = Pick<ScrapeOptions, 'formats' | 'onlyMainContent' | 'includeTags' | 'excludeTags' | 'removeBase64Images'>;

export interface ParseFormat {
  format: string;
  kind: string;
  extensions: string[];
  mimeTypes: string[];
  available: boolean;
  note?: string;
}

export interface IceCrawlOptions {
  apiUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class IceCrawlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly trust?: TrustBlock,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'IceCrawlApiError';
  }
}

const query = (o: Record<string, unknown>): string => {
  const q = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  return q.size > 0 ? `?${q}` : '';
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class IceCrawl {
  readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: IceCrawlOptions = {}) {
    this.apiUrl = (o.apiUrl ?? 'http://localhost:3002').replace(/\/+$/, '');
    this.apiKey = o.apiKey;
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 330_000;
  }

  private send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // a FormData body sets its own multipart content type (with the boundary)
    const form = body instanceof FormData;
    if (body !== undefined && !form) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async fail(res: Response, text: string): Promise<never> {
    let parsed: Partial<ApiErrorBody> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : undefined;
    } catch {
      parsed = undefined;
    }
    throw new IceCrawlApiError(
      res.status,
      parsed?.code ?? `HTTP_${res.status}`,
      parsed?.error ?? (text.slice(0, 200) || res.statusText),
      parsed?.trust,
      parsed,
    );
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    const text = await res.text();
    if (!res.ok) return this.fail(res, text);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new IceCrawlApiError(res.status, 'BAD_RESPONSE', 'The server did not return JSON');
    }
  }

  private async bytes(path: string): Promise<Uint8Array | null> {
    const res = await this.send('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, await res.text());
    return new Uint8Array(await res.arrayBuffer());
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeDocument> {
    return (await this.json<{ data: ScrapeDocument }>('POST', '/v2/scrape', { ...options, url })).data;
  }

  /** Uploads a file (pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, csv, html, txt) and returns it as a scrape document with a receipt. */
  async parse(file: ParseFile, options: ParseOptions = {}): Promise<ScrapeDocument> {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(file.data)], { type: file.type ?? 'application/octet-stream' }), file.name);
    if (Object.keys(options).length > 0) form.append('options', JSON.stringify(options));
    return (await this.json<{ data: ScrapeDocument }>('POST', '/v2/parse', form)).data;
  }
  async getParseFormats(): Promise<ParseFormat[]> {
    return (await this.json<{ data: { formats: ParseFormat[] } }>('GET', '/v2/parse/formats')).data.formats;
  }

  async createMonitor(request: MonitorRequest): Promise<Monitor> {
    return (await this.json<{ data: Monitor }>('POST', '/v2/monitor', request)).data;
  }
  async listMonitors(o: { limit?: number; offset?: number } = {}): Promise<Monitor[]> {
    return (await this.json<{ data: Monitor[] }>('GET', `/v2/monitor${query(o)}`)).data;
  }
  async getMonitor(id: string): Promise<Monitor> {
    return (await this.json<{ data: Monitor }>('GET', `/v2/monitor/${id}`)).data;
  }
  async updateMonitor(id: string, patch: Partial<MonitorRequest> & { status?: 'active' | 'paused' }): Promise<Monitor> {
    return (await this.json<{ data: Monitor }>('PATCH', `/v2/monitor/${id}`, patch)).data;
  }
  async deleteMonitor(id: string): Promise<void> {
    await this.json('DELETE', `/v2/monitor/${id}`);
  }
  /** Starts a check now; poll `getMonitorCheck` for the result. */
  async runMonitor(id: string): Promise<MonitorCheck> {
    return (await this.json<{ data: MonitorCheck }>('POST', `/v2/monitor/${id}/run`)).data;
  }
  async listMonitorChecks(id: string, o: { limit?: number; offset?: number; status?: string } = {}): Promise<MonitorCheck[]> {
    return (await this.json<{ data: MonitorCheck[] }>('GET', `/v2/monitor/${id}/checks${query(o)}`)).data;
  }
  async getMonitorCheck(id: string, checkId: string, o: { limit?: number; skip?: number; status?: string } = {}): Promise<MonitorCheck> {
    return (await this.json<{ data: MonitorCheck }>('GET', `/v2/monitor/${id}/checks/${checkId}${query(o)}`)).data;
  }

  startAgent(prompt: string, options: AgentOptions = {}): Promise<{ id: string; warning?: string }> {
    return this.json('POST', '/v2/agent', { ...options, prompt });
  }
  /** Failed and cancelled runs are returned as data (`status: 'failed'`, `error`, `code`), not thrown. */
  getAgentStatus(id: string): Promise<AgentStatus> {
    return this.json('GET', `/v2/agent/${id}`);
  }
  /** The recorded steps of a run (searches, page reads, reasoning summaries), available while it runs. */
  async getAgentTrace(id: string): Promise<Array<Record<string, unknown>>> {
    return (await this.json<{ events: Array<Record<string, unknown>> }>('GET', `/v2/agent/${id}/trace`)).events;
  }
  async cancelAgent(id: string): Promise<void> {
    await this.json('DELETE', `/v2/agent/${id}`);
  }
  /** Starts a run and waits for it. Throws `IceCrawlApiError` with the run's code if it fails. */
  async agent(prompt: string, options: AgentOptions = {}, wait: WaitOptions = {}): Promise<AgentStatus> {
    const { id } = await this.startAgent(prompt, options);
    const interval = wait.pollIntervalMs ?? 2000;
    const limit = wait.timeoutMs ?? 600_000;
    const deadline = Date.now() + limit;
    for (;;) {
      const s = await this.getAgentStatus(id);
      if (s.status === 'completed') return s;
      if (s.status === 'failed') throw new IceCrawlApiError(422, s.code ?? 'EXTRACTION_FAILED', s.error ?? 'The agent run failed.');
      if (Date.now() > deadline) throw new IceCrawlApiError(408, 'WAIT_TIMEOUT', `The agent run was still going after ${limit} ms (id ${id})`);
      await sleep(interval);
    }
  }

  /** Opens a browser session. Running code in it needs ICECRAWL_INTERACT_CODE=true on the server (docs/interact.md). */
  async createInteractSession(o: { ttl?: number; activityTtl?: number } = {}): Promise<InteractSession> {
    const r = await this.json<{ id: string; expiresAt: string; warning?: string }>('POST', '/v2/interact', o);
    return { id: r.id, expiresAt: r.expiresAt, ...(r.warning ? { warning: r.warning } : {}) };
  }
  /** Runs node code with `page`, `context` and `browser` in scope. `timeout` is in seconds. */
  executeInteract(sessionId: string, code: string, o: { timeout?: number } = {}): Promise<InteractResult> {
    return this.json('POST', `/v2/interact/${sessionId}/execute`, { code, language: 'node', ...o });
  }
  async listInteractSessions(): Promise<Array<{ id: string; status: string; createdAt: string; lastActivity: string }>> {
    return (await this.json<{ sessions: Array<{ id: string; status: string; createdAt: string; lastActivity: string }> }>('GET', '/v2/interact')).sessions;
  }
  async deleteInteractSession(sessionId: string): Promise<void> {
    await this.json('DELETE', `/v2/interact/${sessionId}`);
  }

  async map(url: string, options: MapOptions = {}): Promise<MapLink[]> {
    return (await this.json<{ links: MapLink[] }>('POST', '/v2/map', { ...options, url })).links;
  }

  startCrawl(url: string, options: CrawlOptions = {}): Promise<JobStartResponse> {
    return this.json('POST', '/v2/crawl', { ...options, url });
  }
  getCrawlStatus(id: string, o: { skip?: number } = {}): Promise<JobStatusResponse> {
    return this.json('GET', `/v2/crawl/${id}${o.skip ? `?skip=${o.skip}` : ''}`);
  }
  async cancelCrawl(id: string): Promise<void> {
    await this.json('DELETE', `/v2/crawl/${id}`);
  }
  getCrawlErrors(id: string): Promise<JobErrorsResponse> {
    return this.json('GET', `/v2/crawl/${id}/errors`);
  }
  async crawl(url: string, options: CrawlOptions = {}, wait: WaitOptions = {}): Promise<JobStatusResponse> {
    const { id } = await this.startCrawl(url, options);
    return this.waitAndCollect((skip) => this.getCrawlStatusAt(id, skip), wait);
  }

  startBatchScrape(urls: string[], options: BatchOptions = {}): Promise<JobStartResponse> {
    return this.json('POST', '/v2/batch/scrape', { ...options, urls });
  }
  getBatchScrapeStatus(id: string, o: { skip?: number } = {}): Promise<JobStatusResponse> {
    return this.json('GET', `/v2/batch/scrape/${id}${o.skip ? `?skip=${o.skip}` : ''}`);
  }
  async cancelBatchScrape(id: string): Promise<void> {
    await this.json('DELETE', `/v2/batch/scrape/${id}`);
  }
  getBatchScrapeErrors(id: string): Promise<JobErrorsResponse> {
    return this.json('GET', `/v2/batch/scrape/${id}/errors`);
  }
  async batchScrape(urls: string[], options: BatchOptions = {}, wait: WaitOptions = {}): Promise<JobStatusResponse> {
    const { id } = await this.startBatchScrape(urls, options);
    return this.waitAndCollect((skip) => this.getBatchStatusAt(id, skip), wait);
  }

  search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    return this.json('POST', '/v2/search', { ...options, query });
  }

  startExtract(urls: string[], options: ExtractOptions = {}): Promise<ExtractStartResponse> {
    return this.json('POST', '/v2/extract', { ...options, urls });
  }
  /** Failed and cancelled jobs are returned as data (`status`, `error`, `code`), not thrown. */
  getExtractStatus(id: string): Promise<ExtractStatusResponse> {
    return this.json('GET', `/v2/extract/${id}`);
  }
  /** Starts an extraction and waits for it. Throws `IceCrawlApiError` with the job's code if it fails. */
  async extract(urls: string[], options: ExtractOptions = {}, wait: WaitOptions = {}): Promise<ExtractStatusResponse> {
    const { id } = await this.startExtract(urls, options);
    const interval = wait.pollIntervalMs ?? 1000;
    const limit = wait.timeoutMs ?? 600_000;
    const deadline = Date.now() + limit;
    for (;;) {
      const s = await this.getExtractStatus(id);
      if (s.status === 'completed') return s;
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new IceCrawlApiError(422, s.code ?? 'EXTRACTION_FAILED', s.error ?? `The extraction ${s.status}.`);
      }
      if (Date.now() > deadline) throw new IceCrawlApiError(408, 'WAIT_TIMEOUT', `The extraction was still running after ${limit} ms (id ${id})`);
      await sleep(interval);
    }
  }

  async getReceipt(id: string): Promise<SignedReceipt> {
    const r = await this.json<{ data: SignedReceipt['receipt']; signature: SignedReceipt['signature'] }>('GET', `/v2/receipts/${id}`);
    return { receipt: r.data, signature: r.signature };
  }
  getSnapshot(id: string): Promise<Uint8Array | null> {
    return this.bytes(`/v2/receipts/${id}/snapshot`);
  }
  getScreenshot(id: string): Promise<Uint8Array | null> {
    return this.bytes(`/v2/receipts/${id}/screenshot`);
  }
  async getPublicKeys(): Promise<PublicKeyEntry[]> {
    return (await this.json<{ keys: PublicKeyEntry[] }>('GET', '/.well-known/icecrawl-keys.json')).keys;
  }

  // The wait helpers always send ?skip=, so the request URL is the same shape for the first and later pages.
  private getCrawlStatusAt(id: string, skip: number): Promise<JobStatusResponse> {
    return this.json('GET', `/v2/crawl/${id}?skip=${skip}`);
  }
  private getBatchStatusAt(id: string, skip: number): Promise<JobStatusResponse> {
    return this.json('GET', `/v2/batch/scrape/${id}?skip=${skip}`);
  }

  private async waitAndCollect(status: (skip: number) => Promise<JobStatusResponse>, w: WaitOptions): Promise<JobStatusResponse> {
    const interval = w.pollIntervalMs ?? 1000;
    const limit = w.timeoutMs ?? 600_000;
    const deadline = Date.now() + limit;
    let first = await status(0);
    while (first.status === 'scraping') {
      if (Date.now() > deadline) throw new IceCrawlApiError(408, 'WAIT_TIMEOUT', `The job was still running after ${limit} ms`);
      await sleep(interval);
      first = await status(0);
    }
    const data = [...first.data];
    let next = first.next;
    while (next) {
      const page = await status(data.length);
      if (page.data.length === 0) break;
      data.push(...page.data);
      next = page.next;
    }
    return { ...first, data, next: null };
  }
}
