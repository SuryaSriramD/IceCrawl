import { convertDocument, convertDocumentIsolated, detectDocumentKind, DocumentError } from '@icecrawl/documents';
import { convertHtml } from './convert';
import { contentKind, decodeBody, type ContentKind } from './decode';

export interface RenderOptions {
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
  /** Convert documents in a worker thread (the server does; receipt replay in the CLI and SDK stays in-process). */
  isolateDocuments?: boolean;
}

export interface Rendered {
  kind: ContentKind;
  text: string;
  markdown: string;
  cleanHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
  /** Things the document converter left out (documents only). */
  warnings: string[];
  /** Why a recognised document could not be read (kind is then 'unsupported'). */
  unreadable?: string;
}

const filenameOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
};

/** The one place response bytes become markdown; the pipeline and receipt replay both call it. */
export async function renderBody(bytes: Uint8Array, contentType: string, finalUrl: string, o: RenderOptions): Promise<Rendered> {
  const kind = contentKind(contentType, bytes);
  const documentKind = kind === 'html' || kind === 'json' ? null : detectDocumentKind({ contentType, filename: filenameOf(finalUrl), bytes });
  if (documentKind) {
    try {
      const doc = o.isolateDocuments ? await convertDocumentIsolated(bytes, documentKind) : await convertDocument(bytes, documentKind);
      // the converter's HTML is already the whole document: no readability pass, no tag filters
      const c = convertHtml(doc.html, { url: finalUrl, onlyMainContent: false, removeBase64Images: o.removeBase64Images });
      return { kind: 'document', text: doc.html, ...c, title: doc.title ?? c.title, warnings: doc.warnings };
    } catch (err) {
      if (!(err instanceof DocumentError)) throw err;
      return { kind: 'unsupported', text: '', markdown: '', cleanHtml: '', links: [], title: null, description: null, language: null, warnings: [], unreadable: err.message };
    }
  }
  const text = kind === 'unsupported' ? '' : decodeBody(bytes, contentType);
  if (kind === 'html') {
    const c = convertHtml(text, {
      url: finalUrl,
      onlyMainContent: o.onlyMainContent,
      includeTags: o.includeTags,
      excludeTags: o.excludeTags,
      removeBase64Images: o.removeBase64Images,
    });
    return { kind, text, ...c, warnings: [] };
  }
  const base = { kind, text, links: [], title: null, description: null, language: null, warnings: [] };
  if (kind === 'json') return { ...base, markdown: `\`\`\`json\n${text.trim()}\n\`\`\``, cleanHtml: text };
  if (kind === 'text') return { ...base, markdown: text.trim(), cleanHtml: text };
  return { ...base, markdown: '', cleanHtml: '' };
}
