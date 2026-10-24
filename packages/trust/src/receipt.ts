import { createHash } from 'node:crypto';
import type { EngineAttempt, Receipt } from '@icecrawl/core';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ReceiptInput {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  fetchedAt: Date;
  engineChain: EngineAttempt[];
  htmlBytes: Uint8Array | null;
  markdown: string | null;
  converter: { name: string; version: string };
  options: { onlyMainContent: boolean; skipTlsVerification: boolean };
}

export function buildReceipt(i: ReceiptInput): Receipt {
  return {
    version: 1,
    id: i.id,
    requestedUrl: i.requestedUrl,
    finalUrl: i.finalUrl,
    statusCode: i.statusCode,
    fetchedAt: i.fetchedAt.toISOString(),
    engineChain: i.engineChain,
    htmlSha256: i.htmlBytes ? sha256Hex(i.htmlBytes) : null,
    outputSha256: i.markdown !== null ? sha256Hex(i.markdown) : null,
    converter: i.converter,
    options: i.options,
  };
}

export function checkStoredHashes(
  receipt: Receipt,
  htmlBytes: Uint8Array | null,
  markdown: string | null,
): { html: boolean; output: boolean } {
  return {
    html: htmlBytes !== null && receipt.htmlSha256 === sha256Hex(htmlBytes),
    output: markdown !== null && receipt.outputSha256 === sha256Hex(markdown),
  };
}
