import { convertHtml } from './convert';
import { contentKind, decodeBody, type ContentKind } from './decode';

export interface RenderOptions {
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
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
}

/** The one place response bytes become markdown; the pipeline and receipt replay both call it. */
export function renderBody(bytes: Uint8Array, contentType: string, finalUrl: string, o: RenderOptions): Rendered {
  const kind = contentKind(contentType, bytes);
  const text = kind === 'unsupported' ? '' : decodeBody(bytes, contentType);
  if (kind === 'html') {
    const c = convertHtml(text, {
      url: finalUrl,
      onlyMainContent: o.onlyMainContent,
      includeTags: o.includeTags,
      excludeTags: o.excludeTags,
      removeBase64Images: o.removeBase64Images,
    });
    return { kind, text, ...c };
  }
  const base = { kind, text, links: [], title: null, description: null, language: null };
  if (kind === 'json') return { ...base, markdown: `\`\`\`json\n${text.trim()}\n\`\`\``, cleanHtml: text };
  if (kind === 'text') return { ...base, markdown: text.trim(), cleanHtml: text };
  return { ...base, markdown: '', cleanHtml: '' };
}
