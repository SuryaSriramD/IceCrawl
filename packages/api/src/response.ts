import { ERROR_STATUS, VERDICT_ERROR_CODE, type SupportedFormat, type TrustBlock, type Verdict } from '@icecrawl/core';
import type { ScrapeRun } from '@icecrawl/scraper';

const dataUri = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

export function buildResponse(run: ScrapeRun, formats: SupportedFormat[]): { status: number; payload: Record<string, unknown> } {
  const trust: TrustBlock = {
    verdict: run.verdict,
    confidence: run.confidence,
    reasons: run.reasons,
    receiptId: run.id,
    engine: run.engine,
  };

  if (!run.accepted) {
    const code = VERDICT_ERROR_CODE[run.verdict as Exclude<Verdict, 'ok'>];
    return {
      status: ERROR_STATUS[code],
      payload: {
        success: false,
        code,
        error: `Scrape was not trustworthy: ${run.verdict} (${run.reasons.join(', ')})`,
        trust,
      },
    };
  }

  const warnings = [...run.warnings];
  const data: Record<string, unknown> = {};
  if (formats.includes('markdown')) data.markdown = run.markdown;
  if (formats.includes('html')) data.html = run.cleanHtml;
  if (formats.includes('rawHtml')) data.rawHtml = run.rawHtml;
  if (formats.includes('links')) data.links = run.links;
  if (formats.includes('screenshot')) {
    if (run.screenshot) data.screenshot = dataUri('image/png', run.screenshot);
    else warnings.push('A screenshot was requested but the engine did not produce one.');
  }
  if (run.actions) {
    data.actions = {
      screenshots: run.actions.screenshots.map((b) => dataUri('image/png', b)),
      scrapes: run.actions.scrapes,
      javascriptReturns: run.actions.javascriptReturns,
      pdfs: run.actions.pdfs.map((b) => Buffer.from(b).toString('base64')),
    };
  }
  data.metadata = {
    title: run.title,
    description: run.description,
    language: run.language,
    sourceURL: run.requestedUrl,
    url: run.finalUrl,
    statusCode: run.statusCode,
    contentType: run.contentType,
  };
  if (warnings.length > 0) data.warning = warnings.join(' ');
  data.trust = trust;
  return { status: 200, payload: { success: true, data } };
}
