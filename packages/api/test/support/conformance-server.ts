// A self-contained IceCrawl for SDK conformance checks: in-memory store and queue, scripted pages, a fake search
// provider and a fake language model. Run with: pnpm tsx packages/api/test/support/conformance-server.ts
import { generateSigningKey } from '@icecrawl/trust';
import { drain, makeJobsApp, pageHtml } from '../jobs-helpers';
import { extractionDeps, fakeLlm } from '../llm-helpers';
import { fakeSearch, webHit } from '../search-helpers';

const E = 'https://example.com';
const site = {
  [`${E}/`]: { html: pageHtml('Home', ['/a', '/b']) },
  [`${E}/a`]: { html: pageHtml('A') },
  [`${E}/b`]: { html: pageHtml('B') },
  [`${E}/walled`]: { html: '<html><body><div class="g-recaptcha"></div><p>Please wait</p></body></html>' },
};
const files = { [`${E}/robots.txt`]: { status: 404, body: '' } };

const key = generateSigningKey();
const t = await makeJobsApp({
  signer: key.privateKey,
  site,
  files,
  search: fakeSearch({ web: [webHit(`${E}/a`, 'Page A', 'About A')] }),
  extraction: extractionDeps(fakeLlm(JSON.stringify({ fact: 'Real readable sentence about a real topic' }))),
});
await t.store.registerPublicKey(key.publicKey);
const port = Number(process.env.PORT ?? 3010);
await t.app.listen({ port, host: '127.0.0.1' });
// the in-memory queue has no worker: run whatever is queued every few milliseconds
setInterval(() => void drain(t.deps, t.queues).catch(() => {}), 25).unref();
console.log(`conformance server ready on http://127.0.0.1:${port} (API key ic-jobs)`);
process.on('SIGTERM', () => void t.app.close().then(() => process.exit(0)));
process.on('SIGINT', () => void t.app.close().then(() => process.exit(0)));
