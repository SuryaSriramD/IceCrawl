import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DocumentError, type ConvertedDocument, type DocumentErrorCode, type DocumentKind, type DocumentLimits } from './types';

export interface IsolationOptions {
  /** The worker is stopped after this long. */
  timeoutMs?: number;
  /** The worker's heap limit; a conversion that needs more fails alone. */
  memoryMb?: number;
}

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

/**
 * `convertDocument` in a worker thread. A hostile file can then burn CPU or memory only inside the worker: the caller's
 * event loop keeps running, and a conversion that takes too long or needs too much memory is stopped and reported as unreadable.
 */
export function convertDocumentIsolated(bytes: Uint8Array, kind: DocumentKind, limits: Partial<DocumentLimits> = {}, o: IsolationOptions = {}): Promise<ConvertedDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { bytes, kind, limits },
      resourceLimits: { maxOldGenerationSizeMb: o.memoryMb ?? 1024 },
      stdout: false,
      stderr: false,
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new DocumentError('UNREADABLE', 'Converting the file took too long'))), o.timeoutMs ?? 60_000);
    worker.once('message', (m: { ok: true; result: ConvertedDocument } | { ok: false; code: DocumentErrorCode; message: string }) =>
      done(() => (m.ok ? resolve(m.result) : reject(new DocumentError(m.code, m.message)))),
    );
    worker.once('error', (err: Error & { code?: string }) =>
      done(() => reject(new DocumentError('UNREADABLE', err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Converting the file needed too much memory' : 'The file could not be converted'))),
    );
    worker.once('exit', (code) => done(() => reject(new DocumentError('UNREADABLE', `The conversion stopped unexpectedly (${code})`))));
  });
}
