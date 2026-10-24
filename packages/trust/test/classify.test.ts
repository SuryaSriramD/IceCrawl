import { describe, expect, it } from 'vitest';
import { classify, type ClassifyInput } from '../src';

const longText = 'This is real article content about a real topic. '.repeat(30);

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    statusCode: 200,
    headers: {},
    html: `<html><head><title>A Real Page</title></head><body><p>${longText}</p></body></html>`,
    markdown: longText,
    ...over,
  };
}

describe('classify', () => {
  it('accepts a normal page with high confidence', () => {
    const c = classify(input({}));
    expect(c.verdict).toBe('ok');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    ['429 is blocked', { statusCode: 429 }, 'blocked', 'http_429'],
    ['403 is blocked', { statusCode: 403 }, 'blocked', 'http_403'],
    ['401 is login_wall', { statusCode: 401 }, 'login_wall', 'http_401'],
    ['404 is error', { statusCode: 404 }, 'error', 'http_404'],
    ['503 is error', { statusCode: 503 }, 'error', 'http_503'],
    ['cloudflare challenge header', { headers: { 'cf-mitigated': 'challenge' } }, 'blocked', 'cf_mitigated_challenge'],
    ['truncated body', { truncated: true }, 'truncated', 'body_shorter_than_content_length'],
    ['binary content type', { unsupportedContentType: 'application/zip' }, 'error', 'unsupported_content_type:application/zip'],
  ] as const)('%s', (_name, over, verdict, reason) => {
    const c = classify(input(over as Partial<ClassifyInput>));
    expect(c.verdict).toBe(verdict);
    expect(c.reasons).toContain(reason);
  });

  it('flags a "Just a moment..." challenge page as blocked', () => {
    const c = classify(
      input({ html: '<html><head><title>Just a moment...</title></head><body>x</body></html>', markdown: 'Checking' }),
    );
    expect(c.verdict).toBe('blocked');
  });

  it('flags a short page with a reCAPTCHA widget as captcha', () => {
    const c = classify(
      input({
        html: '<html><body><div class="g-recaptcha" data-sitekey="k"></div></body></html>',
        markdown: 'Please confirm',
      }),
    );
    expect(c.verdict).toBe('captcha');
    expect(c.reasons[0]).toContain('g-recaptcha');
  });

  it('does not flag a long page that merely embeds a captcha widget', () => {
    const c = classify(input({ html: `<html><body><div class="h-captcha"></div><p>${longText}</p></body></html>` }));
    expect(c.verdict).toBe('ok');
  });

  it('flags "verify you are human" text on a short page as captcha', () => {
    const c = classify(input({ html: '<html><body>x</body></html>', markdown: 'Please verify you are human to continue.' }));
    expect(c.verdict).toBe('captcha');
  });

  it('flags a JavaScript-required shell as empty', () => {
    const c = classify(
      input({ html: '<html><body><noscript>Please enable JavaScript to continue.</noscript></body></html>', markdown: 'Please enable JavaScript to continue.' }),
    );
    expect(c.verdict).toBe('empty');
    expect(c.reasons).toContain('js_required');
  });

  it('flags a password form without content as login_wall', () => {
    const c = classify(
      input({
        html: '<html><body><form><input type="password" name="p"></form></body></html>',
        markdown: 'Sign in to your account to continue reading.',
      }),
    );
    expect(c.verdict).toBe('login_wall');
  });

  it('flags a near-empty page as empty', () => {
    expect(classify(input({ markdown: '   hi  ' })).verdict).toBe('empty');
  });

  it('flags a 200 page that says "Page not found" as soft_404', () => {
    const c = classify(
      input({
        html: '<html><head><title>Page not found</title></head><body><h1>Page not found</h1></body></html>',
        markdown: '# Page not found\n\nSorry, we could not find that page. Try the home page instead.',
      }),
    );
    expect(c.verdict).toBe('soft_404');
  });

  it('does not call a long article that mentions "not found" a soft 404', () => {
    const c = classify(input({ markdown: `${longText} The file was not found. ${longText}${longText}` }));
    expect(c.verdict).toBe('ok');
  });

  it('flags a huge document with almost no text as uncertain', () => {
    const c = classify(
      input({
        html: `<html><body><p>This page has some text.</p><!--${'x'.repeat(60000)}--></body></html>`,
        markdown: 'This page has some text.',
      }),
    );
    expect(c.verdict).toBe('uncertain');
  });

  it('lowers confidence for short but valid pages', () => {
    const c = classify(input({ markdown: 'A short but legitimate page with some words in it.' }));
    expect(c.verdict).toBe('ok');
    expect(c.confidence).toBeLessThan(0.9);
  });
});
