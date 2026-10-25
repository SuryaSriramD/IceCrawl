import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertHostPublic, describeProxy, fetchEngine, parseProxyList, ProxyPool, STEALTH_USER_AGENT, USER_AGENT, type EngineContext } from '../src';

describe('parseProxyList', () => {
  it('accepts comma and whitespace separated http(s) urls', () => {
    expect(parseProxyList('http://u:p@proxy.example:8080, https://p2.example:443\nhttp://p3.example', 'X', false)).toEqual([
      'http://u:p@proxy.example:8080',
      'https://p2.example:443',
      'http://p3.example',
    ]);
    expect(parseProxyList(undefined, 'X', false)).toEqual([]);
    expect(parseProxyList('', 'X', false)).toEqual([]);
  });

  it('rejects other schemes and private hosts without echoing the entry', () => {
    expect(() => parseProxyList('socks5://secret:pw@h:1080', 'ICECRAWL_PROXIES_STEALTH', false)).toThrow(/entry 1: only http/);
    expect(() => parseProxyList('http://user:hunter2@10.0.0.5:3128', 'ICECRAWL_PROXIES_STEALTH', false)).toThrow(/private address/);
    try {
      parseProxyList('not a url at all://hunter2', 'X', false);
    } catch (e) {
      expect(String(e)).not.toContain('hunter2');
    }
    expect(parseProxyList('http://127.0.0.1:3128', 'X', true)).toEqual(['http://127.0.0.1:3128']);
  });
});

describe('ProxyPool', () => {
  it('rotates round robin per tier and skips a proxy that just failed', () => {
    let now = 0;
    const pool = new ProxyPool({ enhanced: ['http://a:1', 'http://b:1'], stealth: ['http://c:1'] }, 1000, () => now);
    expect([pool.next('enhanced'), pool.next('enhanced'), pool.next('enhanced')]).toEqual(['http://a:1', 'http://b:1', 'http://a:1']);
    pool.report('http://b:1', false);
    expect([pool.next('enhanced'), pool.next('enhanced')]).toEqual(['http://a:1', 'http://a:1']);
    now = 1500;
    expect(pool.next('enhanced')).toBe('http://b:1');
    expect(pool.has('stealth')).toBe(true);
    expect(new ProxyPool({}).has('stealth')).toBe(false);
    expect(new ProxyPool({}).next('stealth')).toBeNull();
  });

  it('keeps rotating when every proxy failed recently', () => {
    const pool = new ProxyPool({ enhanced: ['http://a:1', 'http://b:1'] }, 60_000, () => 0);
    pool.report('http://a:1', false);
    pool.report('http://b:1', false);
    expect(pool.next('enhanced')).toBe('http://a:1');
    expect(pool.next('enhanced')).toBe('http://b:1');
  });

  it('describes a proxy without its credentials', () => {
    expect(describeProxy('http://user:pw@proxy.example:8080/')).toBe('http://proxy.example:8080');
  });
});

describe('assertHostPublic', () => {
  const resolver = (async (host: string) => (host === 'internal.example' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }])) as never;
  it('refuses hostnames that resolve to private addresses', async () => {
    await expect(assertHostPublic(new URL('http://internal.example/'), false, resolver)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(assertHostPublic(new URL('http://public.example/'), false, resolver)).resolves.toBeUndefined();
    await expect(assertHostPublic(new URL('http://internal.example/'), true, resolver)).resolves.toBeUndefined();
  });
  it('reports a host that does not resolve as a DNS error', async () => {
    const failing = (async () => {
      throw new Error('ENOTFOUND');
    }) as never;
    await expect(assertHostPublic(new URL('http://nowhere.example/'), false, failing)).rejects.toMatchObject({ code: 'DNS' });
  });
});

describe('fetch engine through a proxy', () => {
  let proxy: Server;
  let port: number;
  const connects: Array<{ target?: string; headers: IncomingHttpHeaders }> = [];
  const requests: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    // undici tunnels through the proxy with CONNECT; the tunnel ends in a tiny origin server
    const origin = createServer((req, res) => {
      requests.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>via proxy</html>');
    });
    proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connects.push({ target: req.url, headers: req.headers });
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      origin.emit('connection', socket);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => proxy.close(() => r())));

  const ctx = (over: Partial<EngineContext>): EngineContext => ({
    url: 'http://target.example/page',
    headers: {},
    timeoutMs: 5000,
    skipTlsVerification: false,
    allowPrivateNetworks: true,
    maxBytes: 100_000,
    waitFor: 0,
    mobile: false,
    actions: [],
    screenshot: null,
    ...over,
  });

  it('sends the request to the proxy with its credentials and a stealth fingerprint', async () => {
    const r = await fetchEngine.scrape(ctx({ proxy: `http://user:pw@127.0.0.1:${port}`, stealth: true }));
    expect(Buffer.from(r.body).toString()).toContain('via proxy');
    const connect = connects[connects.length - 1];
    expect(connect.target).toBe('target.example:80');
    expect(connect.headers['proxy-authorization']).toBe(`Basic ${Buffer.from('user:pw').toString('base64')}`);
    const ua = requests[requests.length - 1]['user-agent'];
    expect(ua).toBe(STEALTH_USER_AGENT);
    expect(ua).not.toContain('IceCrawl');
  });

  it('keeps the honest user agent when the proxy is used without stealth', async () => {
    await fetchEngine.scrape(ctx({ proxy: `http://127.0.0.1:${port}` }));
    expect(requests[requests.length - 1]['user-agent']).toBe(USER_AGENT);
  });

  it('declares the stealthProxy feature', () => {
    expect(fetchEngine.features.stealthProxy).toBe(true);
  });
});
