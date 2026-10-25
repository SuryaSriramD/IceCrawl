import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const CONVERTER = { name: 'icecrawl-convert', version: '3' } as const;

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
// turndown has no table support of its own; tables become GFM pipe tables (first row is the header)
turndown.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    const table = node as Element;
    // tables used for page layout (nested tables, block content in cells) cannot be pipe tables: keep their content as it flows
    if (table.querySelector('table table, td p, td ul, td ol, td div, td h1, td h2, td h3, td pre, td blockquote')) return `\n\n${content}\n\n`;
    // cell content goes through turndown so links and emphasis survive
    const cell = (c: Element) => turndown.turndown(c.innerHTML).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
    const rows = Array.from(table.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.children).filter((c) => /^T[DH]$/i.test(c.nodeName)).map(cell))
      .filter((r) => r.length > 0);
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array<string>(width - r.length).fill('')].join(' | ')} |`;
    return `\n\n${[line(rows[0]), line(Array<string>(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
  },
});

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
