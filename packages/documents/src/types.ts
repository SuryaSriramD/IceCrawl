export const DOCUMENT_KINDS = ['csv', 'rtf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'pdf'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DocumentLimits {
  /** Largest input accepted, in bytes. */
  maxBytes: number;
  /** Largest total size of the unpacked parts of a zip based document (zip bombs). */
  maxUnzippedBytes: number;
  /** Pages (pdf), slides (pptx, odp) or sheets (xlsx, ods) converted. */
  maxPages: number;
  /** Table rows converted (csv, spreadsheets, document tables). */
  maxRows: number;
}

export const DEFAULT_LIMITS: DocumentLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxUnzippedBytes: 200 * 1024 * 1024,
  maxPages: 500,
  maxRows: 20_000,
};

export interface ConvertedDocument {
  /** The document as simple HTML (headings, paragraphs, lists, tables), ready for the HTML to markdown converter. */
  html: string;
  title: string | null;
  /** Things that were left out or approximated; surfaced to the caller as a warning. */
  warnings: string[];
}

export type DocumentErrorCode = 'UNREADABLE' | 'TOO_LARGE' | 'UNSUPPORTED';

/** A file that cannot be converted. The message never contains text from the file. */
export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}
