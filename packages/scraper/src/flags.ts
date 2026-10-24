import type { ScrapeRequest } from '@icecrawl/core';
import type { FeatureFlag } from '@icecrawl/engines';

const DOCUMENT_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

export function buildFeatureFlags(request: ScrapeRequest): Set<FeatureFlag> {
  const flags = new Set<FeatureFlag>();
  if (request.actions && request.actions.length > 0) flags.add('actions');
  if (request.waitFor > 0) flags.add('waitFor');
  if (request.mobile) flags.add('mobile');
  if (request.skipTlsVerification) flags.add('skipTlsVerification');
  if (request.proxy === 'enhanced' || request.proxy === 'stealth') flags.add('stealthProxy');
  if (request.blockAds === false) flags.add('disableAdblock');

  for (const f of request.formats) {
    if (typeof f === 'string' ? f === 'screenshot' : f.type === 'screenshot') {
      const full = typeof f !== 'string' && (f as { fullPage?: unknown }).fullPage === true;
      flags.add(full ? 'screenshot@fullScreen' : 'screenshot');
    }
  }

  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // URL was validated upstream; ignore here
  }
  if (DOCUMENT_EXT.test(pathname)) flags.add('document');
  else if (/\.pdf$/i.test(pathname)) flags.add('pdf');

  return flags;
}
