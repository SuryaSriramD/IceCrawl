import { createHash } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { detectDocumentKind, DOCUMENT_FORMATS } from '@icecrawl/documents';
import { IceCrawlError, normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, type Engine } from '@icecrawl/engines';
import { scrapeAndPersist, type ScrapeServiceDeps } from '../scrape-service';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface ParseRouteDeps extends ScrapeServiceDeps {
  maxUploadBytes?: number;
}

/** Plain web formats /parse accepts besides documents: the extension decides the content type. */
const WEB_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.txt': 'text/plain',
  '.md': 'text/plain',
};

const OPTION_KEYS = ['formats', 'onlyMainContent', 'includeTags', 'excludeTags', 'removeBase64Images'] as const;

const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');

/** An engine that "fetches" the uploaded bytes, so an upload goes through the same pipeline, receipt and storage as a scrape. */
function uploadEngine(bytes: Uint8Array, contentType: string): Engine {
  return {
    name: 'upload',
    quality: 100,
    features: featureSet(['skipTlsVerification', 'pdf', 'document']),
    maxReasonableTimeMs: 1000,
    scrape: async (req) => ({ finalUrl: req.url, statusCode: 200, headers: {}, body: bytes, contentType, truncated: false }),
  };
}

export function registerParseRoutes(v2: FastifyInstance, deps: ParseRouteDeps): void {
  const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  v2.get('/parse/formats', async () => ({
    success: true,
    data: {
      formats: [
        ...DOCUMENT_FORMATS,
        { format: 'html', kind: 'document', extensions: ['.html', '.htm', '.xhtml'], mimeTypes: ['text/html', 'application/xhtml+xml'], available: true },
        { format: 'txt', kind: 'document', extensions: ['.txt', '.md'], mimeTypes: ['text/plain'], available: true },
      ],
    },
  }));

  // multipart parsing is scoped to this plugin so the JSON routes keep their body limit and parsers
  v2.register(async (scope) => {
    await scope.register(multipart, { limits: { files: 1, fileSize: maxBytes, fields: 4, fieldSize: 100_000, parts: 6 } });

    scope.post('/parse', async (req, reply) => {
      let file: { name: string; mimetype: string; bytes: Buffer } | null = null;
      let options: Record<string, unknown> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file) throw new IceCrawlError('VALIDATION', 'Send exactly one file, in the multipart field "file".');
          file = { name: part.filename, mimetype: part.mimetype, bytes: await part.toBuffer() };
        } else if (part.fieldname === 'options') {
          try {
            const parsed: unknown = JSON.parse(String(part.value));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
            options = parsed as Record<string, unknown>;
          } catch {
            throw new IceCrawlError('VALIDATION', 'The "options" field must be a JSON object.');
          }
        }
      }
      if (!file) throw new IceCrawlError('VALIDATION', 'Send the file to parse in the multipart field "file".');
      if (file.bytes.length === 0) throw new IceCrawlError('VALIDATION', 'The uploaded file is empty.');

      const web = WEB_TYPES[extensionOf(file.name)];
      const kind = detectDocumentKind({ contentType: file.mimetype, filename: file.name, bytes: file.bytes });
      if (!web && !kind) {
        throw new IceCrawlError('VALIDATION', `Cannot parse "${file.name}": the file type is not supported. See GET /v2/parse/formats.`);
      }
      // a text file is only a document when it is csv or rtf; everything else keeps the type from its extension
      const contentType = web && !kind ? web : file.mimetype;

      const sha = createHash('sha256').update(file.bytes).digest('hex');
      const url = `upload://${sha}/${encodeURIComponent(file.name)}`;
      const picked = Object.fromEntries(OPTION_KEYS.filter((k) => options[k] !== undefined).map((k) => [k, options[k]]));
      const normalized = normalizeScrapeRequest({ ...picked, url });
      const ignored = Object.keys(options).filter((k) => !(OPTION_KEYS as readonly string[]).includes(k));
      if (ignored.length > 0) normalized.warnings.push(`Ignored parse options: ${ignored.join(', ')}.`);

      const { status, payload } = await scrapeAndPersist(
        { ...deps, engines: [uploadEngine(file.bytes, contentType)] },
        normalized,
        { apiKeyId: req.apiKeyId },
      );
      return reply.status(status).send(payload);
    });
  });
}
