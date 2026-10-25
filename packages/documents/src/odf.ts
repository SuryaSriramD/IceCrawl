import { heading, page, paragraph, tableHtml, esc } from './html';
import { packageTitle } from './docx';
import { openZip } from './zip';
import { DocumentError, type ConvertedDocument, type DocumentKind, type DocumentLimits } from './types';
import { attrOf, childrenOf, findAll, findFirst, parseXml, tagOf, textOf, type XNode } from './xml';

/** Text of an ODF paragraph or heading: spans and links are flattened, spaces, tabs and line breaks are honoured. */
function odfText(node: XNode): string {
  let out = '';
  const walk = (nodes: XNode[]) => {
    for (const n of nodes) {
      if ('#text' in n) {
        out += String(n['#text']);
        continue;
      }
      const t = tagOf(n);
      if (t === 'text:s') out += ' '.repeat(Math.min(100, Number(attrOf(n, 'text:c') ?? 1)));
      else if (t === 'text:tab') out += '\t';
      else if (t === 'text:line-break') out += '\n';
      else if (t !== undefined) walk(childrenOf(n));
    }
  };
  walk(childrenOf(node));
  return out;
}

function listHtml(list: XNode): string {
  const items = childrenOf(list)
    .filter((n) => tagOf(n) === 'text:list-item')
    .map((item) => {
      const inner = childrenOf(item)
        .map((n) => (tagOf(n) === 'text:list' ? listHtml(n) : tagOf(n) === 'text:p' || tagOf(n) === 'text:h' ? esc(odfText(n)).replace(/\n/g, '<br>') : ''))
        .join('');
      return `<li>${inner}</li>`;
    });
  return `<ul>${items.join('')}</ul>`;
}

function tableOf(table: XNode, maxRows: number): { html: string; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  for (const row of findAll(childrenOf(table), 'table:table-row')) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    for (const cell of childrenOf(row).filter((n) => ['table:table-cell', 'table:covered-table-cell'].includes(tagOf(n) ?? ''))) {
      const text = childrenOf(cell).filter((n) => tagOf(n) === 'text:p').map(odfText).join('\n');
      const value = attrOf(cell, 'office:date-value') ?? attrOf(cell, 'office:value') ?? (attrOf(cell, 'office:boolean-value') ? attrOf(cell, 'office:boolean-value')!.toUpperCase() : undefined);
      const shown = text !== '' ? text : (value ?? '');
      // padding columns are stored as one cell repeated thousands of times
      const repeat = Math.min(attrOf(cell, 'table:number-columns-repeated') ? Number(attrOf(cell, 'table:number-columns-repeated')) : 1, shown === '' ? 0 : 50);
      for (let i = 0; i < Math.max(repeat, shown === '' ? 1 : 0); i++) cells.push(shown);
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) rows.push(cells);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return { html: tableHtml(rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')])), truncated };
}

function blocks(nodes: XNode[], maxRows: number, warnings: string[]): string {
  const out: string[] = [];
  for (const n of nodes) {
    switch (tagOf(n)) {
      case 'text:h':
        out.push(heading(Number(attrOf(n, 'text:outline-level') ?? 1), odfText(n)));
        break;
      case 'text:p':
        out.push(paragraph(odfText(n)));
        break;
      case 'text:list':
        out.push(listHtml(n));
        break;
      case 'table:table': {
        const t = tableOf(n, maxRows);
        if (t.truncated) warnings.push(`A table was cut at ${maxRows} rows.`);
        out.push(attrOf(n, 'table:name') && findFirst(childrenOf(n), 'table:table-row') ? heading(2, attrOf(n, 'table:name')!) + t.html : t.html);
        break;
      }
      case 'text:section':
      case 'office:text':
      case 'office:spreadsheet':
        out.push(blocks(childrenOf(n), maxRows, warnings));
        break;
      default:
        break;
    }
  }
  return out.join('');
}

function presentation(root: XNode[], limits: DocumentLimits, warnings: string[]): string {
  const pages = findAll(root, 'draw:page');
  if (pages.length > limits.maxPages) warnings.push(`Only the first ${limits.maxPages} of ${pages.length} slides were converted.`);
  return pages
    .slice(0, limits.maxPages)
    .map((p, i) => {
      const texts = findAll(childrenOf(p), 'draw:text-box').map((box) => childrenOf(box).filter((n) => ['text:p', 'text:h', 'text:list'].includes(tagOf(n) ?? '')));
      const body = texts.map((nodes) => blocks(nodes, limits.maxRows, warnings)).join('');
      return heading(2, attrOf(p, 'draw:name') ? `Slide ${i + 1}: ${attrOf(p, 'draw:name')}` : `Slide ${i + 1}`) + body;
    })
    .join('');
}

export function odfToHtml(bytes: Uint8Array, kind: Extract<DocumentKind, 'odt' | 'ods' | 'odp'>, limits: DocumentLimits): ConvertedDocument {
  const zip = openZip(bytes, limits, (n) => n === 'content.xml' || n === 'meta.xml' || n === 'mimetype');
  const content = zip.text('content.xml');
  if (!content) throw new DocumentError('UNREADABLE', 'The file is not an OpenDocument file (content.xml is missing)');
  const root = parseXml(content);
  const warnings: string[] = [];
  const body = findFirst(root, 'office:body');
  if (!body) throw new DocumentError('UNREADABLE', 'The OpenDocument file has no body');
  const html = kind === 'odp' ? presentation(root, limits, warnings) : blocks(childrenOf(body), limits.maxRows, warnings);
  if (textOf(root).trim() === '' || html.replace(/<[^>]*>/g, '').trim() === '') throw new DocumentError('UNREADABLE', 'The document contains no text');
  const title = packageTitle((n) => zip.text(n));
  return { html: page(title, html), title, warnings };
}
