// Runs one document conversion inside a worker thread (see isolated.ts). The TypeScript sources are loaded through tsx,
// the same way the server itself runs.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { convertDocument } = await import('./convert.ts');
try {
  parentPort.postMessage({ ok: true, result: await convertDocument(workerData.bytes, workerData.kind, workerData.limits) });
} catch (err) {
  parentPort.postMessage({ ok: false, code: err?.code ?? 'UNREADABLE', message: err?.name === 'DocumentError' ? err.message : 'The file could not be converted' });
}
