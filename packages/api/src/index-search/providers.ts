import { readFile } from 'node:fs/promises';
import { Agent, request } from 'undici';
import { z } from 'zod';
import { IceCrawlError } from '@icecrawl/core';
import { assertUrlAllowed, createSafeLookup } from '@icecrawl/engines';

export interface ProviderHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ProviderQuery {
  query: string;
  limit: number;
  timeoutMs: number;
}

/** An external source of results for the index. Implement this to plug in a data set; everything it returns is untrusted. */
export interface DataProvider {
  name: string;
  description: string;
  search(q: ProviderQuery): Promise<ProviderHit[]>;
}

const configSchema = z.array(
  z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'use lower-case letters, digits, - and _'),
    description: z.string().max(300).default(''),
    /** Request URL; {query} and {limit} are replaced (the query is URL-encoded). */
    url: z.string().url(),
    /** Header values may contain ${ENV_NAME}, replaced from the environment when the file is loaded. */
    headers: z.record(z.string()).default({}),
    /** Dot path to the array of results in the JSON answer; empty when the answer is the array. */
    resultsPath: z.string().default(''),
    fields: z.object({ title: z.string().default('title'), url: z.string().default('url'), snippet: z.string().default('description') }).default({}),
  }),
);

export type HttpProviderConfig = z.infer<typeof configSchema>[number];

const MAX_BODY = 1_000_000;

const at = (value: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

export function createHttpProvider(cfg: HttpProviderConfig, o: { allowPrivateNetworks: boolean }): DataProvider {
  return {
    name: cfg.name,
    description: cfg.description,
    async search(q) {
      const url = cfg.url.replace('{query}', encodeURIComponent(q.query)).replace('{limit}', String(q.limit));
      assertUrlAllowed(url, o.allowPrivateNetworks);
      const agent = new Agent({ connect: { lookup: createSafeLookup(o.allowPrivateNetworks) as never } });
      try {
        const res = await request(url, { method: 'GET', headers: { accept: 'application/json', ...cfg.headers }, dispatcher: agent, signal: AbortSignal.timeout(q.timeoutMs) });
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of res.body as AsyncIterable<Buffer>) {
          total += c.length;
          if (total > MAX_BODY) {
            res.body.destroy();
            throw new IceCrawlError('RESPONSE_TOO_LARGE', `Provider "${cfg.name}" answered with more than ${MAX_BODY} bytes.`);
          }
          chunks.push(c);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) throw new IceCrawlError('TARGET_ERROR', `Provider "${cfg.name}" answered HTTP ${res.statusCode}.`);
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new IceCrawlError('TARGET_ERROR', `Provider "${cfg.name}" did not answer with JSON.`);
        }
        const list = cfg.resultsPath ? at(body, cfg.resultsPath) : body;
        if (!Array.isArray(list)) throw new IceCrawlError('TARGET_ERROR', `Provider "${cfg.name}": no result list at "${cfg.resultsPath}".`);
        return list
          .map((item) => ({ title: str(at(item, cfg.fields.title), 300), url: str(at(item, cfg.fields.url), 2000), snippet: str(at(item, cfg.fields.snippet), 1000) }))
          .filter((h) => /^https?:\/\//i.test(h.url))
          .slice(0, q.limit);
      } catch (err) {
        if (err instanceof IceCrawlError) throw err;
        const e = err as { name?: string };
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new IceCrawlError('TIMEOUT', `Provider "${cfg.name}" timed out.`);
        throw new IceCrawlError('TARGET_ERROR', `Provider "${cfg.name}" could not be reached.`);
      } finally {
        await agent.close().catch(() => undefined);
      }
    },
  };
}

/** Reads the providers file: a JSON array of HTTP providers. Errors name the provider, never a header value. */
export function parseProviders(json: unknown, o: { allowPrivateNetworks: boolean; env?: NodeJS.ProcessEnv }): DataProvider[] {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) throw new Error(`ICECRAWL_PROVIDERS_FILE: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const env = o.env ?? process.env;
  const names = new Set<string>();
  return parsed.data.map((cfg) => {
    if (names.has(cfg.name) || cfg.name === 'scrapes') throw new Error(`ICECRAWL_PROVIDERS_FILE: provider name "${cfg.name}" is reserved or used twice`);
    names.add(cfg.name);
    const headers = Object.fromEntries(
      Object.entries(cfg.headers).map(([k, v]) => [
        k,
        v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
          const value = env[name];
          if (value === undefined) throw new Error(`ICECRAWL_PROVIDERS_FILE: provider "${cfg.name}" needs the environment variable ${name}`);
          return value;
        }),
      ]),
    );
    return createHttpProvider({ ...cfg, headers }, o);
  });
}

export async function loadProvidersFile(path: string, o: { allowPrivateNetworks: boolean; env?: NodeJS.ProcessEnv }): Promise<DataProvider[]> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`ICECRAWL_PROVIDERS_FILE ${path} could not be read as JSON: ${(err as Error).message}`);
  }
  return parseProviders(json, o);
}
