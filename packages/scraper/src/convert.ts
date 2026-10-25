import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const CONVERTER = { name: 'icecrawl-convert', version: '2' } as const;

export interface ConvertOptions {
  url: string;
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
}

export interface Converted {
  markdown: string;
  cleanHtml: string;
  links: string[];
  title: string | null;
  description: string | null;
  language: string | null;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.remove(['script', 'style']);

function toMarkdown(html: string, removeBase64: boolean): string {
  let md = turndown.turndown(html);
  if (removeBase64) md = md.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

function absolutize(doc: Document, base: string): void {
  for (const [selector, attr] of [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
    ['source[src]', 'src'],
  ] as const) {
    doc.querySelectorAll(selector).forEach((el) => {
      const value = el.getAttribute(attr);
      if (!value) return;
      try {
        el.setAttribute(attr, new URL(value, base).toString());
      } catch {
        // leave unparseable values alone
      }
    });
  }
}

function collectLinks(doc: Document): string[] {
  const seen = new Set<string>();
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    try {
      const u = new URL(href);
      if (u.protocol === 'http:' || u.protocol === 'https:') seen.add(u.toString());
    } catch {
      // ignore
    }
  });
  return [...seen];
}

const H1_MARK = 'data-icecrawl-h1';

const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Readability turns every h1 into an h2 and drops a heading that repeats the page title. Mark the page's own
 * h1 first (the first one outside nav, footer and aside that sits in the main content or starts the page title)
 * so it can be put back as an h1 afterwards.
 */
function markTopHeading(doc: Document, title: string | null): string | null {
  const h1 = Array.from(doc.querySelectorAll('h1')).find((h) => !h.closest('nav, footer, aside'));
  const text = h1?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!h1 || text.length === 0 || text.length > 300) return null;
  const inMain = h1.closest('article, main, [role="main"]') !== null;
  const t = normalizeText(title ?? '');
  const h = normalizeText(text);
  const echoesTitle = t.length > 0 && (t === h || t.startsWith(h) || h.startsWith(t));
  if (!inMain && !echoesTitle) return null;
  h1.setAttribute(H1_MARK, '1');
  return text;
}

function restoreTopHeading(contentHtml: string, text: string): string {
  const { document } = parseHTML(`<html><body>${contentHtml}</body></html>`) as unknown as { document: Document };
  const marked = document.querySelector(`[${H1_MARK}]`);
  if (!marked) return `<h1>${escapeHtml(text)}</h1>\n${contentHtml}`;
  if (marked.tagName === 'H1') {
    marked.removeAttribute(H1_MARK);
  } else {
    const h1 = document.createElement('h1');
    h1.innerHTML = marked.innerHTML;
    marked.replaceWith(h1);
  }
  return document.body.innerHTML;
}

function mainContent(doc: Document): string | null {
  try {
    const article = new Readability(doc, { charThreshold: 100 }).parse();
    if (article && (article.textContent ?? '').trim().length >= 200) return article.content ?? null;
  } catch {
    // fall through to the whole body
  }
  return null;
}

export function convertHtml(html: string, o: ConvertOptions): Converted {
  // linkedom throws on blank input
  const { document } = parseHTML(html.trim() ? html : '<html><body></body></html>') as unknown as { document: Document };

  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
  const title = document.title?.trim() || meta('meta[property="og:title"]');
  const description = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const language = document.documentElement?.getAttribute('lang') || null;

  document.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  for (const selector of o.excludeTags ?? []) {
    try {
      document.querySelectorAll(selector).forEach((n) => n.remove());
    } catch {
      // ignore invalid selectors
    }
  }
  absolutize(document, o.url);
  const links = collectLinks(document);

  let contentHtml = document.body?.innerHTML ?? '';
  if (o.includeTags && o.includeTags.length > 0) {
    const parts: string[] = [];
    for (const selector of o.includeTags) {
      try {
        document.querySelectorAll(selector).forEach((n) => parts.push(n.outerHTML));
      } catch {
        // ignore invalid selectors
      }
    }
    contentHtml = parts.join('\n');
  } else if (o.onlyMainContent) {
    const topHeading = markTopHeading(document, title);
    const main = mainContent(document);
    contentHtml = main === null ? contentHtml : topHeading ? restoreTopHeading(main, topHeading) : main;
  }

  return { markdown: toMarkdown(contentHtml, o.removeBase64Images), cleanHtml: contentHtml, links, title, description, language };
}
