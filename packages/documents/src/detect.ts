import type { DocumentKind } from './types';

const EXTENSIONS: Record<string, DocumentKind> = {
  '.csv': 'csv',
  '.rtf': 'rtf',
  '.docx': 'docx',
  '.docm': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.odt': 'odt',
  '.ods': 'ods',
  '.odp': 'odp',
  '.epub': 'epub',
  '.pdf': 'pdf',
};

const MIME_TYPES: Record<string, DocumentKind> = {
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
};

export interface DocumentFormat {
  /** The canonical extension without the dot. */
  format: string;
  kind: 'document';
  extensions: string[];
  mimeTypes: string[];
  /** False for formats that are recognised but cannot be converted by this build. */
  available: boolean;
  /** Why a format is not available. */
  note?: string;
}

const group = (kind: DocumentKind) => ({
  extensions: Object.entries(EXTENSIONS).filter(([, k]) => k === kind).map(([e]) => e),
  mimeTypes: Object.entries(MIME_TYPES).filter(([, k]) => k === kind).map(([m]) => m),
});

const LEGACY = (format: string, mime: string): DocumentFormat => ({
  format,
  kind: 'document',
  extensions: [`.${format}`],
  mimeTypes: [mime],
  available: false,
  note: 'Legacy binary Office format: convert it to the OOXML or OpenDocument equivalent first.',
});

/** What /parse accepts, for GET /v2/parse/formats. */
export const DOCUMENT_FORMATS: DocumentFormat[] = [
  { format: 'pdf', kind: 'document', ...group('pdf'), available: true },
  { format: 'docx', kind: 'document', ...group('docx'), available: true },
  { format: 'xlsx', kind: 'document', ...group('xlsx'), available: true },
  { format: 'pptx', kind: 'document', ...group('pptx'), available: true },
  { format: 'odt', kind: 'document', ...group('odt'), available: true },
  { format: 'ods', kind: 'document', ...group('ods'), available: true },
  { format: 'odp', kind: 'document', ...group('odp'), available: true },
  { format: 'epub', kind: 'document', ...group('epub'), available: true },
  { format: 'rtf', kind: 'document', ...group('rtf'), available: true },
  { format: 'csv', kind: 'document', ...group('csv'), available: true },
  LEGACY('doc', 'application/msword'),
  LEGACY('xls', 'application/vnd.ms-excel'),
  LEGACY('ppt', 'application/vnd.ms-powerpoint'),
  LEGACY('xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'),
];

/**
 * What kind of document these bytes are, from (in order) their own signature, the content type and the file name.
 * A wrong guess only makes the converter report the file as unreadable.
 */
export function detectDocumentKind(o: { contentType?: string; filename?: string; bytes?: Uint8Array }): DocumentKind | null {
  const head = o.bytes ? Buffer.from(o.bytes.subarray(0, 8)).toString('latin1') : '';
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('{\\rtf')) return 'rtf';
  const mime = (o.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (MIME_TYPES[mime]) return MIME_TYPES[mime];
  const dot = (o.filename ?? '').toLowerCase().lastIndexOf('.');
  const ext = dot === -1 ? '' : (o.filename ?? '').toLowerCase().slice(dot);
  // the file name is the only hint for generic types such as application/zip or application/octet-stream
  return EXTENSIONS[ext] ?? null;
}
