import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../src';

let origin: Server;
let originPort: number;

beforeAll(async () => {
  origin = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-host-seen': String(req.headers.host) });
    res.end('hello from origin');
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as AddressInfo).port;
});

afterAll(() => {
  origin.closeAllConnections();
  origin.close();
});

function viaProxy(proxy: EgressProxy, target: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const p = new URL(proxy.url);
  const t = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: 'GET', path: target, headers: { host: t.host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectThroughProxy(proxy: EgressProxy, hostPort: string): Promise<{ status: number; reply: string }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode ?? 0, reply: '' });
      }
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve({ status: 200, reply: data }));
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy', () => {
  it('forwards plain HTTP when private addresses are allowed', async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const r = await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(200);
      expect(r.body).toBe('hello from origin');
      expect(r.headers['x-host-seen']).toBe(`127.0.0.1:${originPort}`);
    } finally {
      await proxy.close();
    }
  });

  it('blocks plain HTTP to private addresses and reports the host', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    proxy.onBlocked((h) => blocked.push(h));
    try {
      const r = await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(403);
      expect(r.headers['x-icecrawl-blocked']).toBe('ssrf');
      expect(r.body).not.toContain('hello from origin');
      expect(blocked).toEqual(['127.0.0.1']);
    } finally {
      await proxy.close();
    }
  });

  it('blocks a public-looking hostname that resolves to a private address (DNS rebinding)', async () => {
    const proxy = await startEgressProxy({
      allowPrivate: false,
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    try {
      const r = await viaProxy(proxy, 'http://rebind.test/ok');
      expect(r.status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('connects to the validated address, not a second DNS answer', async () => {
    let lookups = 0;
    const proxy = await startEgressProxy({
      allowPrivate: true,
      resolve: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    try {
      const r = await viaProxy(proxy, `http://anything.test:${originPort}/ok`);
      expect(r.status).toBe(200);
      expect(lookups).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('tunnels CONNECT when allowed', async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const r = await connectThroughProxy(proxy, `127.0.0.1:${originPort}`);
      expect(r.status).toBe(200);
      expect(r.reply).toContain('hello from origin');
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to private addresses', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    proxy.onBlocked((h) => blocked.push(h));
    try {
      const r = await connectThroughProxy(proxy, `127.0.0.1:${originPort}`);
      expect(r.status).toBe(403);
      expect(blocked).toEqual(['127.0.0.1']);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to bracketed IPv6 loopback and malformed targets', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    try {
      expect((await connectThroughProxy(proxy, '[::1]:443')).status).toBe(403);
      expect((await connectThroughProxy(proxy, 'no-port')).status).toBe(400);
    } finally {
      await proxy.close();
    }
  });

  it('stops notifying after unsubscribe', async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    const blocked: string[] = [];
    const off = proxy.onBlocked((h) => blocked.push(h));
    off();
    try {
      await viaProxy(proxy, `http://127.0.0.1:${originPort}/ok`);
      expect(blocked).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
