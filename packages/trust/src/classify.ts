import type { Verdict } from '@icecrawl/core';

export interface ClassifyInput {
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  markdown: string;
  truncated?: boolean;
  unsupportedContentType?: string;
}

export interface Classification {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
}

const CAPTCHA_MARKERS = [
  'g-recaptcha',
  'h-captcha',
  'hcaptcha.com',
  'cf-turnstile',
  'challenges.cloudflare.com',
  'px-captcha',
  'geo.captcha-delivery.com',
];
const CHALLENGE_TITLE =
  /^(just a moment|attention required|access denied|are you a robot|verify you are human|pardon our interruption|one more step)/i;
const JS_REQUIRED = /(enable javascript|javascript is (required|disabled)|requires javascript|turn on javascript)/i;
const NOT_FOUND = /\b(404|page not found|not found|doesn'?t exist|does not exist|no longer available)\b/i;

const result = (verdict: Verdict, confidence: number, ...reasons: string[]): Classification => ({
  verdict,
  confidence,
  reasons,
});

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function firstHeading(markdown: string): string {
  const m = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : '';
}

export function classify(i: ClassifyInput): Classification {
  if (i.unsupportedContentType) {
    return result('error', 0.95, `unsupported_content_type:${i.unsupportedContentType}`);
  }
  if (i.truncated) return result('truncated', 0.9, 'body_shorter_than_content_length');

  const status = i.statusCode;
  if (i.headers['cf-mitigated'] === 'challenge') return result('blocked', 0.98, 'cf_mitigated_challenge');
  if (status === 401) return result('login_wall', 0.9, 'http_401');
  if (status === 429) return result('blocked', 0.95, 'http_429');
  if (status === 403) return result('blocked', 0.85, 'http_403');
  if (status >= 400) return result('error', 0.95, `http_${status}`);

  const lowerHtml = i.html.toLowerCase();
  const text = i.markdown.trim();
  const len = text.length;
  const title = titleOf(i.html);

  if (CHALLENGE_TITLE.test(title)) return result('blocked', 0.95, `challenge_title:${title.toLowerCase()}`);

  const marker = CAPTCHA_MARKERS.find((m) => lowerHtml.includes(m));
  if (marker && len < 800) return result('captcha', 0.95, `captcha_widget:${marker}`);
  if (/verify you are human|checking your browser/i.test(text) && len < 800) {
    return result('captcha', 0.9, 'human_verification_text');
  }

  if (JS_REQUIRED.test(i.html) && len < 300) return result('empty', 0.85, 'js_required');
  if (/<input[^>]+type=["']?password/i.test(i.html) && len < 600) {
    return result('login_wall', 0.85, 'password_form_without_content');
  }
  if (len < 20) return result('empty', 0.9, 'no_text_content');

  if ((NOT_FOUND.test(title) || NOT_FOUND.test(firstHeading(text))) && len < 1500) {
    return result('soft_404', 0.8, 'not_found_wording_on_short_page');
  }
  if (i.html.length > 50_000 && len < 200) return result('uncertain', 0.6, 'low_text_ratio');

  return result('ok', len >= 500 ? 0.95 : 0.8);
}
