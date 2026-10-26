import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { isPrivateAddress } from './ssrf';

export interface EgressProxy {
  url: string;
  onBlocked(cb: (host: string) => void): () => void;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  allowPrivate: boolean;
  resolve?: (host: string) => Promise<dns.LookupAddress[]>;
  /**
   * Ports that must never be reached on a loopback address, even when private addresses are allowed. Session browsers add
   * their own debugging port here so a page cannot talk to the browser that renders it. Mutable on purpose.
   */
  blockedLoopbackPorts?: Set<number>;
}

class BlockedError extends Error {}

const defaultResolve = (host: string) => dns.promises.lookup(host, { all: true });

function splitHostPort(target: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const resolve = opts.resolve ?? defaultResolve;
  const listeners = new Set<(host: string) => void>();

  // Resolve once and connect to this exact address, so a second DNS answer cannot change the target.
  async function checked(host: string, port: number): Promise<dns.LookupAddress> {
    const clean = host.replace(/^\[|\]$/g, '');
    const addresses = await resolve(clean);
    if (addresses.length === 0) throw new Error(`no address for ${clean}`);
    if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
      for (const cb of listeners) cb(clean);
      throw new BlockedError(clean);
    }
    if (opts.blockedLoopbackPorts?.has(port) && addresses.some((a) => a.address.startsWith('127.') || a.address === '::1')) {
      for (const cb of listeners) cb(clean);
      throw new BlockedError(clean);
    }
    return addresses[0];
  }

  const server = http.createServer(async (req, res) => {
    try {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('absolute-form request required');
        return;
      }
      if (target.protocol !== 'http:') {
        res.writeHead(400).end('only http: is proxied here; https uses CONNECT');
        return;
      }
      const address = await checked(target.hostname, Number(target.port || 80));
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = http.request(
        {
          host: address.address,
          family: address.family,
          port: Number(target.port || 80),
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (err) {
      if (err instanceof BlockedError) {
        res.writeHead(403, { 'x-icecrawl-blocked': 'ssrf', 'content-type': 'text/plain' }).end(`blocked: ${err.message}`);
      } else if (!res.headersSent) {
        res.writeHead(502).end('upstream error');
      }
    }
  });

  server.on('connect', async (req, clientSocket: net.Socket, head: Buffer) => {
    const hp = splitHostPort(req.url ?? '');
    if (!hp) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    try {
      const address = await checked(hp.host, hp.port);
      const upstream = net.connect(hp.port, address.address, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    } catch (err) {
      clientSocket.end(`HTTP/1.1 ${err instanceof BlockedError ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    onBlocked(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
