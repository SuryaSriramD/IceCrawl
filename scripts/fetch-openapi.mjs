// Downloads Firecrawl's published v2 OpenAPI document for the conformance tests.
// The document is Firecrawl's, not part of this repository: it is cached in .cache/ (git-ignored).
//
//   node scripts/fetch-openapi.mjs [destination]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://docs.firecrawl.dev/api-reference/v2-openapi.json';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? `${root}/.cache/v2-openapi.json`);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Could not download ${SOURCE}: HTTP ${res.status}`);
const text = await res.text();
const doc = JSON.parse(text);
if (typeof doc.openapi !== 'string' || typeof doc.paths !== 'object' || !doc.paths['/scrape']) {
  throw new Error('The downloaded file does not look like the Firecrawl v2 OpenAPI document');
}
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, text);
console.log(`saved ${destination} (${Math.round(text.length / 1024)} KB, ${Object.keys(doc.paths).length} paths)`);
