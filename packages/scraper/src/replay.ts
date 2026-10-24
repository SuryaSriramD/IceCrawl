import type { Receipt } from '@icecrawl/core';
import { scanForInjection, summarizeScan, type ReplayResult } from '@icecrawl/trust';
import { CONVERTER } from './convert';
import { renderBody } from './render';

export function replayMarkdown(receipt: Receipt, htmlBytes: Uint8Array): ReplayResult {
  if (receipt.converter.name !== CONVERTER.name || receipt.converter.version !== CONVERTER.version) {
    return {
      unavailable: `receipt used ${receipt.converter.name}@${receipt.converter.version}, this build has ${CONVERTER.name}@${CONVERTER.version}`,
    };
  }
  if (!receipt.contentType) return { unavailable: 'receipt does not record the content type (made before replay support)' };
  const r = renderBody(htmlBytes, receipt.contentType, receipt.finalUrl, {
    onlyMainContent: receipt.options.onlyMainContent,
    includeTags: receipt.options.includeTags,
    excludeTags: receipt.options.excludeTags,
    removeBase64Images: receipt.options.removeBase64Images ?? true,
  });
  return {
    markdown: r.markdown,
    scan: summarizeScan(scanForInjection({ html: r.text, markdown: r.markdown })),
  };
}
