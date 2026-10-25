import { csvToHtml } from './csv';
import { rtfToHtml } from './rtf';
import { DEFAULT_LIMITS, DocumentError, type ConvertedDocument, type DocumentKind, type DocumentLimits } from './types';

/** Converts a document to simple HTML. Rejects with a `DocumentError` for files that cannot be read. */
export async function convertDocument(bytes: Uint8Array, kind: DocumentKind, limits: Partial<DocumentLimits> = {}): Promise<ConvertedDocument> {
  const l: DocumentLimits = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length > l.maxBytes) throw new DocumentError('TOO_LARGE', `The file is larger than ${l.maxBytes} bytes`);
  switch (kind) {
    case 'csv':
      return csvToHtml(bytes, l);
    case 'rtf':
      return rtfToHtml(bytes, l);
    default:
      throw new DocumentError('UNSUPPORTED', `${kind} documents are not supported yet`);
  }
}
