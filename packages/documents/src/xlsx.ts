import { heading, page, tableHtml } from './html';
import { packageTitle } from './docx';
import { openZip } from './zip';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';
import { attrOf, childrenOf, findAll, findFirst, parseXml, tagOf, textOf, type XNode } from './xml';

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** An Excel serial date as ISO text: a date, a time, or both. */
export function serialToText(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0);
  const ms = Math.round((days - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (serial >= 0 && serial < 1) return time;
  return Number.isInteger(serial) ? date : `${date} ${time}`;
}

const columnIndex = (ref: string): number => {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const MAX_COLUMNS = 500;

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const root = parseXml(xml);
  return findAll(root, 'si').map((si) => textOf(findAll([si], 't')));
}

function dateStyles(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const root = parseXml(xml);
  const custom = new Map<number, string>();
  for (const f of findAll(root, 'numFmt')) custom.set(Number(attrOf(f, 'numFmtId')), attrOf(f, 'formatCode') ?? '');
  const cellXfs = findFirst(root, 'cellXfs');
  const xfs = cellXfs ? childrenOf(cellXfs).filter((n) => tagOf(n) === 'xf') : [];
  xfs.forEach((xf, i) => {
    const id = Number(attrOf(xf, 'numFmtId') ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) out.add(i);
  });
  return out;
}

function cellText(c: XNode, strings: string[], dates: Set<number>, date1904: boolean): string {
  const type = attrOf(c, 't');
  const kids = childrenOf(c);
  const v = findFirst(kids, 'v');
  const raw = v ? textOf([v]) : '';
  if (type === 'inlineStr') return textOf(findAll(kids, 't'));
  if (type === 's') return strings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return raw;
  if (raw === '') return '';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return dates.has(Number(attrOf(c, 's') ?? -1)) ? serialToText(n, date1904) : String(n);
}

export function xlsxToHtml(bytes: Uint8Array, limits: DocumentLimits): ConvertedDocument {
  const zip = openZip(bytes, limits, (n) => n.startsWith('xl/') || n === 'docProps/core.xml');
  const workbookXml = zip.text('xl/workbook.xml');
  if (!workbookXml) throw new DocumentError('UNREADABLE', 'The file is not an Excel workbook (xl/workbook.xml is missing)');
  const workbook = parseXml(workbookXml);
  const date1904 = attrOf(findFirst(workbook, 'workbookPr') ?? {}, 'date1904') === '1';

  const rels = new Map<string, string>();
  const relsXml = zip.text('xl/_rels/workbook.xml.rels');
  if (relsXml) for (const r of findAll(parseXml(relsXml), 'Relationship')) rels.set(attrOf(r, 'Id') ?? '', attrOf(r, 'Target') ?? '');
  const strings = sharedStrings(zip.text('xl/sharedStrings.xml'));
  const dates = dateStyles(zip.text('xl/styles.xml'));

  const sheets = findAll(workbook, 'sheet');
  const warnings: string[] = [];
  if (sheets.length > limits.maxPages) warnings.push(`Only the first ${limits.maxPages} of ${sheets.length} sheets were converted.`);
  const parts: string[] = [];
  for (const [index, sheet] of sheets.slice(0, limits.maxPages).entries()) {
    const target = rels.get(attrOf(sheet, 'r:id') ?? '') ?? `worksheets/sheet${index + 1}.xml`;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = zip.text(path);
    if (!xml) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of findAll(parseXml(xml), 'row')) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const c of childrenOf(row).filter((n) => tagOf(n) === 'c')) {
        const col = Math.min(columnIndex(attrOf(c, 'r') ?? '') , MAX_COLUMNS);
        while (cells.length < col) cells.push('');
        cells[col] = cellText(c, strings, dates, date1904);
      }
      if (cells.some((x) => x !== '')) rows.push(cells);
    }
    if (truncated) warnings.push(`Sheet "${attrOf(sheet, 'name') ?? index + 1}" was cut at ${limits.maxRows} rows.`);
    const width = Math.max(0, ...rows.map((r) => r.length));
    const square = rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
    parts.push(heading(2, attrOf(sheet, 'name') ?? `Sheet ${index + 1}`) + (square.length > 0 ? tableHtml(square) : ''));
  }
  if (parts.length === 0) throw new DocumentError('UNREADABLE', 'The workbook contains no sheets');
  const title = packageTitle((n) => zip.text(n));
  return { html: page(title, parts.join('')), title, warnings };
}
