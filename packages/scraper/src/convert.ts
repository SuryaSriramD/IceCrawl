import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const CONVERTER = { name: 'icecrawl-convert', version: '1' } as const;

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
    contentHtml = mainContent(document) ?? contentHtml;
  }

  return { markdown: toMarkdown(contentHtml, o.removeBase64Images), cleanHtml: contentHtml, links, title, description, language };
}
