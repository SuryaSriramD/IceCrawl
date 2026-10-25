import { strFromU8, unzipSync } from 'fflate';
import { DocumentError, type DocumentLimits } from './types';

const MAX_ENTRIES = 20_000;

export interface Zip {
  names: string[];
  has(name: string): boolean;
  /** The text of a part, or null when the part is missing. */
  text(name: string): string | null;
  bytes(name: string): Uint8Array | null;
}

/**
 * Opens a zip based document. The declared sizes of all parts are checked before anything is inflated (zip bombs),
 * and only the parts `want` accepts are inflated.
 */
export function openZip(bytes: Uint8Array, limits: DocumentLimits, want: (name: string) => boolean = () => true): Zip {
  const names: string[] = [];
  let declared = 0;
  let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (++entries > MAX_ENTRIES) throw new DocumentError('TOO_LARGE', 'The archive has too many parts');
        declared += file.originalSize;
        if (declared > limits.maxUnzippedBytes) throw new DocumentError('TOO_LARGE', `The unpacked document is larger than ${limits.maxUnzippedBytes} bytes`);
        names.push(file.name);
        return want(file.name);
      },
    });
  } catch (err) {
    if (err instanceof DocumentError) throw err;
    throw new DocumentError('UNREADABLE', 'The file is not a readable zip archive');
  }
  return {
    names,
    has: (name) => names.includes(name),
    text: (name) => (files[name] ? strFromU8(files[name]) : null),
    bytes: (name) => files[name] ?? null,
  };
}

/** Rejects a zip based document whose declared contents are too large, without inflating any part. */
export function checkZip(bytes: Uint8Array, limits: DocumentLimits): string[] {
  return openZip(bytes, limits, () => false).names;
}
