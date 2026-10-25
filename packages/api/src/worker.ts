import { loadConfig } from './config';
import { startReaper } from './jobs/reaper';
import { startMonitorScheduler } from './monitor/scheduler';
import { startJobWorkers } from './jobs/runner';
import { createRuntime } from './runtime';

const config = loadConfig();
const rt = await createRuntime(config);
const workers = startJobWorkers(rt.queues, rt.jobDeps, rt.delivery, { concurrency: config.workerConcurrency });
const stopReaper = startReaper(rt.store, { maxRuntimeMs: config.jobMaxRuntimeHours * 3_600_000 });

const stopScheduler = startMonitorScheduler({ monitors: rt.monitors, queues: rt.queues });

const shutdown = async () => {
  stopScheduler();
  stopReaper();
  await workers.close();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`IceCrawl worker running (concurrency ${config.workerConcurrency}, signing key ${rt.signer.keyId})`);
