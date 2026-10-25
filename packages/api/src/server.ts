import { buildApp } from './app';
import { loadConfig } from './config';
import { startReaper } from './jobs/reaper';
import { startJobWorkers } from './jobs/runner';
import { createRuntime } from './runtime';

const config = loadConfig();
const rt = await createRuntime(config);

const app = buildApp({
  store: rt.store,
  snapshots: rt.snapshots,
  engines: rt.engines,
  scraper: rt.jobDeps.scraper,
  useAuth: config.useAuth,
  signer: rt.signer,
  map: { fetcher: rt.jobDeps.fetcher },
  extraction: rt.extraction,
  search: rt.search,
  searchMaxScrape: config.searchMaxScrape,
  rateLimiter: rt.rateLimiter,
  jobs: {
    queues: rt.queues,
    publicUrl: config.publicUrl,
    ttlHours: config.jobTtlHours,
    pageBytes: config.jobPageBytes,
    maxCrawlLimit: config.maxCrawlLimit,
    allowPrivateNetworks: config.allowPrivateNetworks,
    allowIgnoreRobots: config.allowIgnoreRobots,
  },
});

const workers = config.runWorker ? startJobWorkers(rt.queues, rt.jobDeps, rt.delivery, { concurrency: config.workerConcurrency }) : null;
const stopReaper = startReaper(rt.store);

const shutdown = async () => {
  stopReaper();
  await app.close();
  await workers?.close();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `IceCrawl listening on :${config.port} (auth ${config.useAuth ? 'on' : 'off'}, engines ${rt.engines.map((e) => e.name).join(' > ')}, signing key ${rt.signer.keyId}, worker ${config.runWorker ? 'in-process' : 'external'}, model ${rt.extraction.llm ? `${rt.extraction.llm.provider}/${rt.extraction.llm.model}` : 'none'}, search ${rt.search ? rt.search.name : 'none'})`,
);
