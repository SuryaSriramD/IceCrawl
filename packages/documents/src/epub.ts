import { page } from './html';
import { openZip } from './zip';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';
import { attrOf, findAll, findFirst, parseXml, textOf } from './xml';

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

const bodyOf = (xhtml: string): string => {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  return m ? m[1] : xhtml;
};

/** An EPUB as the HTML of its chapters in reading order. Images and styles are left out. */
export function epubToHtml(bytes: Uint8Array, limits: DocumentLimits): ConvertedDocument {
  const zip = openZip(bytes, limits, (n) => /\.(x?html?|opf|xml)$/i.test(n));
  const container = zip.text('META-INF/container.xml');
  if (!container) throw new DocumentError('UNREADABLE', 'The file is not an EPUB (META-INF/container.xml is missing)');
  const rootfile = findFirst(parseXml(container), 'rootfile');
  const opfPath = rootfile ? attrOf(rootfile, 'full-path') : undefined;
  const opfXml = opfPath ? zip.text(opfPath) : null;
  if (!opfPath || !opfXml) throw new DocumentError('UNREADABLE', 'The EPUB has no package document');

  const opf = parseXml(opfXml);
  const base = dirname(opfPath);
  const manifest = new Map(findAll(opf, 'item').map((i) => [attrOf(i, 'id') ?? '', attrOf(i, 'href') ?? '']));
  const spine = findAll(opf, 'itemref').map((r) => manifest.get(attrOf(r, 'idref') ?? '')).filter((h): h is string => Boolean(h));
  const titleNode = findFirst(opf, 'dc:title');
  const title = titleNode ? textOf([titleNode]).trim() || null : null;

  const warnings: string[] = [];
  if (spine.length > limits.maxPages) warnings.push(`Only the first ${limits.maxPages} of ${spine.length} chapters were converted.`);
  const chapters = spine.slice(0, limits.maxPages).flatMap((href) => {
    const xhtml = zip.text(decodeURIComponent(`${base}${href.split('#')[0]}`));
    return xhtml ? [`<section>${bodyOf(xhtml)}</section>`] : [];
  });
  if (chapters.length === 0) throw new DocumentError('UNREADABLE', 'The EPUB has no readable chapters');
  return { html: page(title, chapters.join('')), title, warnings };
}
