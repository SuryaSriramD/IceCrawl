import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CORPUS, contentTypeOf, type CorpusEntry } from './corpus';

export interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** Serves the corpus on a free loopback port. */
export async function startFixtureServer(entries: readonly CorpusEntry[] = CORPUS): Promise<FixtureServer> {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    const e = byPath.get(path);
    if (!e) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no such fixture');
    if (e.behavior === 'redirect-loop') return void res.writeHead(302, { location: e.path }).end();
    if (e.behavior === 'truncated') {
      // promises more bytes than it sends, then drops the connection
      res.writeHead(200, { 'content-type': contentTypeOf(e), 'content-length': String(Buffer.byteLength(e.body) + 5000) });
      res.write(e.body.slice(0, 400));
      return void setTimeout(() => res.destroy(), 20);
    }
    res.writeHead(e.status ?? 200, { 'content-type': contentTypeOf(e), ...(e.headers ?? {}) }).end(e.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
