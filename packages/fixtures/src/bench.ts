import { FETCH_CORPUS, formatReport, runBenchmark, startFixtureServer } from './index';

const server = await startFixtureServer();
try {
  const outcomes = await runBenchmark(server.origin, FETCH_CORPUS);
  console.log(formatReport(outcomes));
} finally {
  await server.close();
}
