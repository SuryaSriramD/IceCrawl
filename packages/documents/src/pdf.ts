import { heading, page, paragraph } from './html';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';

/** Reading stops between pages once this much time has passed. */
const PDF_TIME_BUDGET_MS = 60_000;

interface Line {
  y: number;
  size: number;
  text: string;
}

/** Text items of a page grouped into lines (same baseline), top to bottom. */
function linesOf(items: Array<{ str: string; transform: number[]; height: number }>): Line[] {
  const lines: Line[] = [];
  for (const it of items) {
    if (it.str === '') continue;
    const y = it.transform[5];
    const line = lines.find((l) => Math.abs(l.y - y) < 2);
    if (line) {
      line.text += it.str;
      line.size = Math.max(line.size, it.height);
    } else lines.push({ y, size: it.height, text: it.str });
  }
  return lines.sort((a, b) => b.y - a.y);
}

const median = (xs: number[]) => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

/** Lines become paragraphs at vertical gaps; clearly larger lines become headings. */
function pageHtml(lines: Line[], body: number): string {
  const out: string[] = [];
  let buf: string[] = [];
  let prev: Line | undefined;
  const flush = () => {
    if (buf.length > 0) out.push(paragraph(buf.join(' ')));
    buf = [];
  };
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') continue;
    if (body > 0 && line.size >= body * 1.3 && text.length < 200) {
      flush();
      out.push(heading(line.size >= body * 1.8 ? 2 : 3, text));
    } else {
      if (prev && prev.y - line.y > Math.max(prev.size, line.size) * 1.8) flush();
      buf.push(text);
    }
    prev = line;
  }
  flush();
  return out.join('');
}

/** Extracts the text layer of a PDF. Scanned pages have none; a warning says so (no OCR). */
export async function pdfToHtml(bytes: Uint8Array, limits: DocumentLimits): Promise<ConvertedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') throw new DocumentError('UNREADABLE', 'The PDF is password protected');
    throw new DocumentError('UNREADABLE', 'The file is not a readable PDF');
  }
  try {
    const warnings: string[] = [];
    const total = doc.numPages;
    const last = Math.min(total, limits.maxPages);
    if (total > last) warnings.push(`Only the first ${last} of ${total} pages were converted.`);
    const pages: Line[][] = [];
    const deadline = Date.now() + PDF_TIME_BUDGET_MS;
    for (let n = 1; n <= last; n++) {
      if (Date.now() > deadline) {
        warnings.push(`Stopped after ${n - 1} pages: reading the PDF took too long.`);
        break;
      }
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(linesOf(content.items as Array<{ str: string; transform: number[]; height: number }>));
    }
    const body = median(pages.flat().map((l) => l.size));
    const html = pages.map((lines) => pageHtml(lines, body)).filter((h) => h !== '');
    if (html.length === 0) throw new DocumentError('UNREADABLE', 'The PDF has no text layer (scanned documents need OCR, which is not supported)');
    if (html.length < pages.length) warnings.push(`${pages.length - html.length} pages have no text layer (scanned pages need OCR, which is not supported).`);
    let title: string | null = null;
    try {
      const meta = (await doc.getMetadata()).info as { Title?: unknown };
      title = typeof meta.Title === 'string' && meta.Title.trim() !== '' ? meta.Title.trim() : null;
    } catch {
      // metadata is optional
    }
    return { html: page(title, html.join('')), title, warnings };
  } finally {
    await doc.destroy();
  }
}
