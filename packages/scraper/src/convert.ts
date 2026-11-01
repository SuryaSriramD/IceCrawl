import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const CONVERTER = { name: 'icecrawl-convert', version: '4' } as const;

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
  replacement: (_content, node) => {
    const table = node as Element;
    // cell content goes through turndown so links and emphasis survive
    const inner = (c: Element) => turndown.turndown(c.innerHTML).trim();
    const ownRows = Array.from(table.querySelectorAll('tr'))
      .filter((tr) => tr.closest('table') === table)
      .map((tr) => Array.from(tr.children).filter((c) => /^T[DH]$/i.test(c.nodeName)));
    // A table used for page layout (nested tables, block content or a whole article in a cell) cannot be a pipe table:
    // every cell becomes its own block, so neighbouring cells never run together.
    const layout =
      table.querySelector('table table, td p, td ul, td ol, td div, td h1, td h2, td h3, td blockquote') != null || // domino answers undefined, not null, when nothing matches
      ownRows.some((cells) => cells.some((c) => (c.textContent ?? '').length > 400));
    if (layout) {
      const blocks = ownRows.flatMap((cells) => cells.map(inner)).filter((b) => b !== '');
      return blocks.length === 0 ? '' : `\n\n${blocks.join('\n\n')}\n\n`;
    }
    const cell = (c: Element) => inner(c).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
    const rows = ownRows.map((cells) => cells.map(cell)).filter((r) => r.length > 0);
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

const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textLength = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;

/**
 * The page's own h1: the first one outside navigation that sits in the main content or starts the page title.
 * A site-name heading in a banner is not the page heading.
 */
function pageHeading(doc: Document, title: string | null): { element: Element; text: string } | null {
  const h1 = Array.from(doc.querySelectorAll('h1')).find((h) => !h.closest('nav, footer, aside'));
  const text = h1?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!h1 || text.length === 0 || text.length > 300) return null;
  const inMain = h1.closest('article, main, [role="main"]') != null;
  const t = normalizeText(title ?? '');
  const h = normalizeText(text);
  const echoesTitle = t.length > 0 && (t === h || t.startsWith(h) || h.startsWith(t));
  return inMain || echoesTitle ? { element: h1, text } : null;
}

/** Where the content is: a <main>, else the only substantial <article>, else the whole body. */
function contentScope(doc: Document): Element {
  const main = doc.querySelector('main, [role="main"]');
  if (main && textLength(main) >= 200) return main;
  const articles = Array.from(doc.querySelectorAll('article')).filter((a) => textLength(a) >= 200);
  if (articles.length === 1) return articles[0];
  return doc.body;
}

// Page furniture that is never the content, wherever it sits.
const ALWAYS_REMOVED = 'nav, [role="navigation"], [role="search"], [hidden], dialog, [role="dialog"], [role="alertdialog"]';
// Furniture around the content: kept when it sits inside the article or main (a byline header, a pull-quote aside).
const OUTER_REMOVED = 'aside, [role="complementary"], footer, [role="contentinfo"], header, [role="banner"]';
// Words in a class or id that mark furniture. Only whole words count, so `has-sidebar` is a wrapper but `sidebar` is not.
const FURNITURE_WORDS = new Set(['sidebar', 'breadcrumb', 'breadcrumbs', 'cookie', 'cookies', 'consent', 'gdpr', 'popup', 'modal', 'advert', 'advertisement', 'adsbygoogle', 'social', 'share', 'sharing', 'navbar', 'toolbar', 'topbar', 'catlinks', 'navbox', 'editsection', 'interlanguage']);

const isFurnitureByName = (el: Element): boolean => {
  const words = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`.toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => FURNITURE_WORDS.has(w)) && !words.some((w) => w === 'has' || w === 'with' || w === 'no' || w === 'without' || w === 'collapsed' || w === 'open');
};

/** Removes navigation, banners, footers, sidebars, consent notices and the like from `scope`, and nothing else. */
function pruneFurniture(scope: Element): void {
  const scopeText = Math.max(1, textLength(scope));
  const inContent = (el: Element) => el !== scope && el.closest('article, main, [role="main"]') != null && scope.contains(el.closest('article, main, [role="main"]'));
  for (const el of Array.from(scope.querySelectorAll(ALWAYS_REMOVED))) el.remove();
  for (const el of Array.from(scope.querySelectorAll(OUTER_REMOVED))) {
    if (!el.isConnected || inContent(el) || el === scope) continue;
    // a header that carries a heading is part of the page (its navigation was removed above)
    if (/^(header)$/i.test(el.nodeName) || el.getAttribute('role') === 'banner') {
      if (el.querySelector('h1, h2, h3') != null) continue;
    }
    el.remove();
  }
  for (const el of Array.from(scope.querySelectorAll('[class], [id]'))) {
    if (!el.isConnected || el === scope || /^(body|html|main|article)$/i.test(el.nodeName)) continue;
    if (!isFurnitureByName(el)) continue;
    // a wrapper that holds the page (or most of its text) is layout, not furniture
    if (el.querySelector('main, article, h1') != null || textLength(el) > scopeText * 0.5) continue;
    el.remove();
  }
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
    const heading = pageHeading(document, title);
    const scope = contentScope(document);
    const headingOutside = heading !== null && !scope.contains(heading.element);
    pruneFurniture(scope);
    contentHtml = (headingOutside ? `<h1>${escapeHtml(heading!.text)}</h1>\n` : '') + scope.innerHTML;
  }

  return { markdown: toMarkdown(contentHtml, o.removeBase64Images), cleanHtml: contentHtml, links, title, description, language };
}
