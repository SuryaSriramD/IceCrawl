import { describe, expect, it } from 'vitest';
import { convertDocument } from '../src';

/** A one page PDF with the given lines of text, built by hand (offsets computed). */
function makePdf(lines: Array<{ text: string; size: number; y: number }>): Uint8Array {
  const stream = lines.map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${l.text}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe('pdf', () => {
  it('extracts headings and paragraphs from the text layer', async () => {
    const r = await convertDocument(
      makePdf([
        { text: 'Big Title', size: 24, y: 720 },
        { text: 'first line', size: 12, y: 680 },
        { text: 'second line', size: 12, y: 665 },
        { text: 'later paragraph', size: 12, y: 600 },
      ]),
      'pdf',
    );
    expect(r.html).toContain('Big Title</h2>');
    expect(r.html).toContain('first line second line');
    expect(r.html).toContain('later paragraph');
  });

  it('refuses a file that is not a pdf', async () => {
    await expect(convertDocument(new TextEncoder().encode('%PDF-1.4 fake'), 'pdf')).rejects.toMatchObject({ code: 'UNREADABLE' });
  });

  it('says so for pages without a text layer', async () => {
    await expect(convertDocument(makePdf([]), 'pdf')).rejects.toMatchObject({ code: 'UNREADABLE' });
  });
});
