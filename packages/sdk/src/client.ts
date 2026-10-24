import type {
  ApiErrorBody,
  BatchOptions,
  CrawlOptions,
  JobErrorsResponse,
  JobStartResponse,
  JobStatusResponse,
  MapLink,
  MapOptions,
  PublicKeyEntry,
  ScrapeDocument,
  ScrapeOptions,
  SignedReceipt,
  TrustBlock,
} from '@icecrawl/core';

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
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
