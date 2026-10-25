import { heading, page, paragraph, tableHtml } from './html';
import { packageTitle } from './docx';
import { openZip } from './zip';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';
import { attrOf, childrenOf, findAll, findFirst, parseXml, tagOf, textOf, type XNode } from './xml';

const paragraphText = (p: XNode): string => {
  let out = '';
  const walk = (nodes: XNode[]) => {
    for (const n of nodes) {
      const t = tagOf(n);
      if (t === 'a:t') out += textOf([n]);
      else if (t === 'a:br') out += '\n';
      else if (t !== undefined && t !== '#text') walk(childrenOf(n));
    }
  };
  walk(childrenOf(p));
  return out;
};

const isTitleShape = (sp: XNode): boolean => {
  const ph = findFirst([sp], 'p:ph');
  const type = ph ? attrOf(ph, 'type') : undefined;
  return type === 'title' || type === 'ctrTitle';
};

function slideHtml(xml: string, n: number): string {
  const root = parseXml(xml);
  const tree = findFirst(root, 'p:spTree');
  if (!tree) return '';
  let title = '';
  const body: string[] = [];
  for (const node of childrenOf(tree)) {
    const t = tagOf(node);
    if (t === 'p:sp') {
      const paragraphs = findAll([node], 'a:p').map(paragraphText).filter((s) => s.trim() !== '');
      if (isTitleShape(node)) title = paragraphs.join(' ');
      else body.push(...paragraphs.map(paragraph));
    } else if (t === 'p:graphicFrame') {
      const rows = findAll([node], 'a:tr').map((tr) => findAll([tr], 'a:tc').map((tc) => findAll([tc], 'a:p').map(paragraphText).join('\n')));
      if (rows.length > 0) body.push(tableHtml(rows));
    }
  }
  return heading(2, title ? `Slide ${n}: ${title}` : `Slide ${n}`) + body.join('');
}

export function pptxToHtml(bytes: Uint8Array, limits: DocumentLimits): ConvertedDocument {
  const zip = openZip(bytes, limits, (n) => n.startsWith('ppt/slides/') || n === 'ppt/presentation.xml' || n === 'ppt/_rels/presentation.xml.rels' || n === 'docProps/core.xml');
  const presentation = zip.text('ppt/presentation.xml');
  if (!presentation) throw new DocumentError('UNREADABLE', 'The file is not a PowerPoint presentation (ppt/presentation.xml is missing)');

  // slide order is the order of the slide id list, resolved through the relationships part
  const rels = new Map<string, string>();
  const relsXml = zip.text('ppt/_rels/presentation.xml.rels');
  if (relsXml) for (const r of findAll(parseXml(relsXml), 'Relationship')) rels.set(attrOf(r, 'Id') ?? '', attrOf(r, 'Target') ?? '');
  const ordered = findAll(parseXml(presentation), 'p:sldId')
    .map((s) => rels.get(attrOf(s, 'r:id') ?? ''))
    .filter((t): t is string => Boolean(t))
    .map((t) => (t.startsWith('/') ? t.slice(1) : `ppt/${t}`));
  const paths = ordered.length > 0 ? ordered : zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

  const warnings: string[] = [];
  if (paths.length > limits.maxPages) warnings.push(`Only the first ${limits.maxPages} of ${paths.length} slides were converted.`);
  const slides = paths.slice(0, limits.maxPages).flatMap((path, i) => {
    const xml = zip.text(path);
    return xml ? [slideHtml(xml, i + 1)] : [];
  });
  if (slides.length === 0) throw new DocumentError('UNREADABLE', 'The presentation contains no slides');
  const title = packageTitle((n) => zip.text(n));
  return { html: page(title, slides.join('')), title, warnings };
}
