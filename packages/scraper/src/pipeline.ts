import { randomUUID } from 'node:crypto';
import {
  IceCrawlError,
  type EngineAttempt,
  type ErrorCode,
  type NormalizedScrape,
  type Receipt,
  type Verdict,
} from '@icecrawl/core';
import { pickEngines, type Engine, type EngineResult } from '@icecrawl/engines';
import { buildReceipt, classify, sha256Hex } from '@icecrawl/trust';
import { contentKind, decodeBody } from './decode';
import { CONVERTER, convertHtml } from './convert';
import { buildFeatureFlags } from './flags';

export interface ScraperConfig {
  allowPrivateNetworks: boolean;
  maxResponseBytes: number;
  strict: boolean;
}

export interface ScrapeDeps {
  engines: readonly Engine[];
  config: ScraperConfig;
  now?: () => Date;
}

export interface ScrapeRun {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  engine: string;
  accepted: boolean;
  markdown: string;
  cleanHtml: string;
  rawHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
  receipt: Receipt;
  snapshot: { bytes: Uint8Array; sha256: string };
  warnings: string[];
}

const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'SSRF_BLOCKED',
  'VALIDATION',
  'UNSUPPORTED_OPTION',
  'RESPONSE_TOO_LARGE',
]);

interface Analyzed {
  engine: string;
  result: EngineResult;
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  markdown: string;
  cleanHtml: string;
  rawHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
}

function analyze(engine: string, result: EngineResult, n: NormalizedScrape): Analyzed {
  const kind = contentKind(result.contentType, result.body);
  const text = kind === 'unsupported' ? '' : decodeBody(result.body, result.contentType);
  let markdown = '';
  let cleanHtml = '';
  let links: string[] = [];
  let title: string | null = null;
  let description: string | null = null;
  let language: string | null = null;

  if (kind === 'html') {
    const c = convertHtml(text, {
      url: result.finalUrl,
      onlyMainContent: n.request.onlyMainContent,
      includeTags: n.request.includeTags,
      excludeTags: n.request.excludeTags,
      removeBase64Images: n.request.removeBase64Images,
    });
    ({ markdown, cleanHtml, links, title, description, language } = c);
  } else if (kind === 'json') {
    markdown = `\`\`\`json\n${text.trim()}\n\`\`\``;
    cleanHtml = text;
  } else if (kind === 'text') {
    markdown = text.trim();
    cleanHtml = text;
  }

  const c = classify({
    statusCode: result.statusCode,
    headers: result.headers,
    html: kind === 'html' ? text : '',
    markdown,
    truncated: result.truncated,
    unsupportedContentType: kind === 'unsupported' ? result.contentType || 'unknown' : undefined,
  });

  return { engine, result, ...c, markdown, cleanHtml, rawHtml: text, links, title, description, language };
}

export async function runScrape(deps: ScrapeDeps, n: NormalizedScrape): Promise<ScrapeRun> {
  const { request } = n;
  const warnings = [...n.warnings];
  const flags = buildFeatureFlags(request);
  const picks = pickEngines(flags, deps.engines);
  if (picks.length === 0) {
    throw new IceCrawlError('NO_ENGINE', `No available engine supports: ${[...flags].join(', ')}`);
  }

  const ignored = [...picks[0].unsupported].filter((f) => !f.startsWith('screenshot'));
  if (ignored.length > 0) {
    warnings.push(`Engine "${picks[0].engine.name}" does not support: ${ignored.join(', ')}; those options were ignored.`);
  }

  const attempts: EngineAttempt[] = [];
  let last: Analyzed | null = null;
  let lastError: IceCrawlError | null = null;

  for (const pick of picks) {
    const started = Date.now();
    let result: EngineResult;
    try {
      result = await pick.engine.scrape({
        url: request.url,
        headers: request.headers ?? {},
        timeoutMs: request.timeout,
        skipTlsVerification: request.skipTlsVerification,
        allowPrivateNetworks: deps.config.allowPrivateNetworks,
        maxBytes: deps.config.maxResponseBytes,
      });
    } catch (err) {
      const e = err instanceof IceCrawlError ? err : new IceCrawlError('TARGET_ERROR', String(err));
      if (FATAL.has(e.code)) throw e;
      attempts.push({
        engine: pick.engine.name,
        verdict: 'error',
        confidence: 1,
        reasons: [e.code],
        durationMs: Date.now() - started,
        error: e.message,
      });
      lastError = e;
      continue;
    }

    const analyzed = analyze(pick.engine.name, result, n);
    attempts.push({
      engine: analyzed.engine,
      verdict: analyzed.verdict,
      confidence: analyzed.confidence,
      reasons: analyzed.reasons,
      statusCode: result.statusCode,
      durationMs: Date.now() - started,
    });
    last = analyzed;
    if (analyzed.verdict === 'ok' || (analyzed.verdict === 'uncertain' && !deps.config.strict)) break;
  }

  if (!last) throw lastError ?? new IceCrawlError('NO_ENGINE', 'No engine produced a result');

  const id = randomUUID();
  const receipt = buildReceipt({
    id,
    requestedUrl: request.url,
    finalUrl: last.result.finalUrl,
    statusCode: last.result.statusCode,
    fetchedAt: (deps.now ?? (() => new Date()))(),
    engineChain: attempts,
    htmlBytes: last.result.body,
    markdown: last.markdown,
    converter: CONVERTER,
    options: { onlyMainContent: request.onlyMainContent, skipTlsVerification: request.skipTlsVerification },
  });

  return {
    id,
    requestedUrl: request.url,
    finalUrl: last.result.finalUrl,
    statusCode: last.result.statusCode,
    contentType: last.result.contentType,
    verdict: last.verdict,
    confidence: last.confidence,
    reasons: last.reasons,
    engine: last.engine,
    accepted: last.verdict === 'ok' || (last.verdict === 'uncertain' && !deps.config.strict),
    markdown: last.markdown,
    cleanHtml: last.cleanHtml,
    rawHtml: last.rawHtml,
    links: last.links,
    title: last.title,
    description: last.description,
    language: last.language,
    receipt,
    snapshot: { bytes: last.result.body, sha256: sha256Hex(last.result.body) },
    warnings,
  };
}
