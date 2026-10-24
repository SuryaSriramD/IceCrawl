import { describe, expect, it } from 'vitest';
import { IceCrawlError } from '@icecrawl/core';
import { assertUrlAllowed, createSafeLookup, isPrivateAddress } from '../src';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:7f00:1', '::ffff:10.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it('fails closed on garbage', () => expect(isPrivateAddress('not-an-ip')).toBe(true));
});

describe('assertUrlAllowed', () => {
  it('rejects non-http schemes with VALIDATION', () => {
    expect(() => assertUrlAllowed('ftp://example.com/x', false)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => assertUrlAllowed('file:///etc/passwd', true)).toThrowError(IceCrawlError);
  });

  it('rejects private IP literals, localhost and decimal-encoded IPs unless allowed', () => {
    for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://2130706433/', 'http://169.254.169.254/latest']) {
      expect(() => assertUrlAllowed(u, false)).toThrowError(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
      expect(() => assertUrlAllowed(u, true)).not.toThrow();
    }
  });

  it('accepts public hosts', () => {
    expect(assertUrlAllowed('https://example.com/a?b=1', false).hostname).toBe('example.com');
  });

  it('rejects embedded credentials', () => {
    expect(() => assertUrlAllowed('https://user:pw@example.com/', false)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});

describe('createSafeLookup', () => {
  const resolver = (addrs: { address: string; family: number }[]) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: unknown) => void) => cb(null, addrs)) as never;

  it('blocks a hostname that resolves to a private address (DNS rebinding)', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '10.0.0.5', family: 4 }]));
    const err = await new Promise<unknown>((res) => lookup('evil.test', {}, (e: unknown) => res(e)));
    expect(err).toBeInstanceOf(IceCrawlError);
    expect((err as IceCrawlError).code).toBe('SSRF_BLOCKED');
  });

  it('returns an address array when options.all is set and the host is public', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '93.184.216.34', family: 4 }]));
    const out = await new Promise<unknown>((res) => lookup('ok.test', { all: true }, (_e: unknown, a: unknown) => res(a)));
    expect(out).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns a single address when options.all is not set', async () => {
    const lookup = createSafeLookup(false, resolver([{ address: '93.184.216.34', family: 4 }]));
    const out = await new Promise<unknown[]>((res) => lookup('ok.test', {}, (_e: unknown, a: unknown, f: unknown) => res([a, f])));
    expect(out).toEqual(['93.184.216.34', 4]);
  });

  it('allows private addresses when allowPrivate is true', async () => {
    const lookup = createSafeLookup(true, resolver([{ address: '127.0.0.1', family: 4 }]));
    const out = await new Promise<unknown>((res) => lookup('local.test', { all: true }, (_e: unknown, a: unknown) => res(a)));
    expect(out).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});
