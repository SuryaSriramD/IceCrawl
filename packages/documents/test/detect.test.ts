import { describe, expect, it } from 'vitest';
import { DOCUMENT_FORMATS, detectDocumentKind } from '../src';

const b = (s: string) => new TextEncoder().encode(s);

describe('detectDocumentKind', () => {
  it('trusts the signature over the label', () => {
    expect(detectDocumentKind({ bytes: b('%PDF-1.7 ...'), contentType: 'text/html', filename: 'x.docx' })).toBe('pdf');
    expect(detectDocumentKind({ bytes: b('{\\rtf1\\ansi'), filename: 'x.txt' })).toBe('rtf');
  });

  it('uses the content type, then the file name for generic types', () => {
    expect(detectDocumentKind({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary' })).toBe('docx');
    expect(detectDocumentKind({ contentType: 'text/csv' })).toBe('csv');
    expect(detectDocumentKind({ contentType: 'application/octet-stream', filename: 'Report.XLSX' })).toBe('xlsx');
    expect(detectDocumentKind({ contentType: 'application/zip', filename: 'book.epub' })).toBe('epub');
    expect(detectDocumentKind({ filename: 'macro.docm' })).toBe('docx');
  });

  it('answers null for things that are not documents', () => {
    expect(detectDocumentKind({ contentType: 'text/html', filename: 'index.html' })).toBeNull();
    expect(detectDocumentKind({ bytes: b('hello') })).toBeNull();
    expect(detectDocumentKind({ filename: 'noextension' })).toBeNull();
  });
});

describe('DOCUMENT_FORMATS', () => {
  it('lists what can be parsed and what is recognised but unavailable', () => {
    const by = Object.fromEntries(DOCUMENT_FORMATS.map((f) => [f.format, f]));
    expect(by.docx).toMatchObject({ available: true, extensions: ['.docx', '.docm'] });
    expect(by.pdf.mimeTypes).toContain('application/pdf');
    expect(by.doc).toMatchObject({ available: false });
    expect(by.doc.note).toContain('Legacy');
    expect(DOCUMENT_FORMATS.filter((f) => f.available).map((f) => f.format).sort()).toEqual(
      ['csv', 'docx', 'epub', 'odp', 'ods', 'odt', 'pdf', 'pptx', 'rtf', 'xlsx'],
    );
  });
});
