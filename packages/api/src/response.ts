import { ERROR_STATUS, VERDICT_ERROR_CODE, type SupportedFormat, type TrustBlock, type Verdict } from '@icecrawl/core';
import type { ScrapeRun } from '@icecrawl/scraper';

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

  const data: Record<string, unknown> = {};
  if (formats.includes('markdown')) data.markdown = run.markdown;
  if (formats.includes('html')) data.html = run.cleanHtml;
  if (formats.includes('rawHtml')) data.rawHtml = run.rawHtml;
  if (formats.includes('links')) data.links = run.links;
  data.metadata = {
    title: run.title,
    description: run.description,
    language: run.language,
    sourceURL: run.requestedUrl,
    url: run.finalUrl,
    statusCode: run.statusCode,
    contentType: run.contentType,
  };
  if (run.warnings.length > 0) data.warning = run.warnings.join(' ');
  data.trust = trust;
  return { status: 200, payload: { success: true, data } };
}
