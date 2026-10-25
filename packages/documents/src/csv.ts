import { page, tableHtml } from './html';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';

const DELIMITERS = [',', ';', '\t', '|'] as const;
const MAX_COLUMNS = 500;

function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter that splits the first lines into the same, largest number of columns. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l !== '').slice(0, 5);
  let best = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => {
      let n = 0;
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      return n;
    });
    const consistent = counts.length > 0 && counts.every((c) => c === counts[0]);
    const score = consistent ? counts[0] : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 with a configurable delimiter: quoted fields may hold delimiters, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row.slice(0, MAX_COLUMNS));
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) {
        truncated = i < text.length - 1;
        return { rows, truncated };
      }
    } else field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, truncated };
}

export function csvToHtml(bytes: Uint8Array, limits: DocumentLimits): ConvertedDocument {
  if (bytes.length > limits.maxBytes) throw new DocumentError('TOO_LARGE', `The file is larger than ${limits.maxBytes} bytes`);
  const text = decode(bytes);
  if (text.trim() === '') throw new DocumentError('UNREADABLE', 'The file is empty');
  const { rows, truncated } = parseCsv(text, sniffDelimiter(text), limits.maxRows);
  const warnings = truncated ? [`Only the first ${limits.maxRows} rows were converted.`] : [];
  return { html: page(null, tableHtml(rows)), title: null, warnings };
}
