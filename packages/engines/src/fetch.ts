import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { IceCrawlError } from '@icecrawl/core';
import { featureSet } from './flags';
import { assertHostPublic, assertUrlAllowed, createSafeLookup } from './ssrf';
import type { Engine, EngineContext, EngineResult } from './types';

const MAX_REDIRECTS = 10;
export const USER_AGENT = 'Mozilla/5.0 (compatible; IceCrawl/0.1; +https://github.com/icecrawl/icecrawl)';
/** Sent instead of USER_AGENT when a request goes through an enhanced or stealth proxy. */
export const STEALTH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function decode(body: Buffer, encoding: string | undefined, max: number): Buffer {
  const opts = { maxOutputLength: max };
  try {
    switch ((encoding ?? '').trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body, opts);
      case 'deflate':
        return inflateSync(body, opts);
      case 'br':
        return brotliDecompressSync(body, opts);
      default:
        return body;
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new IceCrawlError('RESPONSE_TOO_LARGE', `Decoded response exceeds ${max} bytes`);
    }
    throw err;
  }
}

async function readBody(
  res: { body: AsyncIterable<Buffer> & { destroy(): void } },
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        res.body.destroy();
        throw new IceCrawlError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof IceCrawlError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' || code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
      truncated = true;
    } else {
      throw err;
    }
  }
  return { body: Buffer.concat(chunks), truncated };
}

function mapError(err: unknown): never {
  if (err instanceof IceCrawlError) throw err;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.cause instanceof IceCrawlError) throw e.cause;
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    throw new IceCrawlError('TIMEOUT', 'Timed out fetching the page');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new IceCrawlError('DNS', 'Could not resolve the host');
  if (code && /CERT|TLS|SSL|SELF_SIGNED/i.test(code)) throw new IceCrawlError('SSL', `TLS error: ${code}`);
  throw new IceCrawlError('TARGET_ERROR', e.message ?? 'Fetch failed');
}

async function scrape(ctx: EngineContext): Promise<EngineResult> {
  // with a proxy the proxy makes the connection, so the address check happens in assertHostPublic below
  const agent: Dispatcher = ctx.proxy
    ? new ProxyAgent({ uri: ctx.proxy, requestTls: { rejectUnauthorized: !ctx.skipTlsVerification } })
    : new Agent({
        connect: {
          lookup: createSafeLookup(ctx.allowPrivateNetworks) as never,
          rejectUnauthorized: !ctx.skipTlsVerification,
        },
      });
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  try {
    let url = ctx.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = assertUrlAllowed(url, ctx.allowPrivateNetworks);
      if (ctx.proxy) await assertHostPublic(target, ctx.allowPrivateNetworks);
      const res = await request(url, {
        method: 'GET',
        dispatcher: agent,
        signal,
        headers: {
          'user-agent': ctx.stealth ? STEALTH_USER_AGENT : USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          ...(ctx.stealth ? { 'accept-language': 'en-US,en;q=0.9' } : {}),
          'accept-encoding': 'gzip, deflate, br',
          ...lowerKeys(ctx.headers),
        },
      });
      const headers = flattenHeaders(res.headers);
      if (res.statusCode >= 300 && res.statusCode < 400 && headers.location) {
        await res.body.dump();
        url = new URL(headers.location, url).toString();
        continue;
      }
      const { body, truncated } = await readBody(res as never, ctx.maxBytes);
      let decoded: Buffer;
      try {
        decoded = decode(body, headers['content-encoding'], ctx.maxBytes);
      } catch (err) {
        if (err instanceof IceCrawlError) throw err;
        if (!truncated) throw new IceCrawlError('TARGET_ERROR', 'Could not decode the response body');
        decoded = Buffer.alloc(0);
      }
      return {
        finalUrl: url,
        statusCode: res.statusCode,
        headers,
        body: decoded,
        contentType: headers['content-type'] ?? '',
        truncated,
      };
    }
    throw new IceCrawlError('TARGET_ERROR', `Too many redirects (more than ${MAX_REDIRECTS})`);
  } catch (err) {
    return mapError(err);
  } finally {
    await agent.close().catch(() => undefined);
  }
}

export const fetchEngine: Engine = {
  name: 'fetch',
  quality: 5,
  features: featureSet(['skipTlsVerification', 'pdf', 'document', 'stealthProxy']),
  maxReasonableTimeMs: 15_000,
  scrape,
};
