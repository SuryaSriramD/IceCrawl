import { createServerFromConfig, loadMcpConfig } from './config';
import { startHttpServer } from './http';
import { startStdio } from './stdio';

export async function main(args: string[], env: Record<string, string | undefined>): Promise<void> {
  const cfg = loadMcpConfig(env);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (args.includes('--http')) {
    if (flag('--port') !== undefined) cfg.http.port = Number(flag('--port'));
    if (flag('--host') !== undefined) cfg.http.host = flag('--host')!;
    const srv = await startHttpServer(cfg, () => createServerFromConfig(cfg));
    console.error(`icecrawl-mcp listening on ${srv.url}/mcp (API ${cfg.apiUrl}, auth ${cfg.http.token ? 'on' : 'off'})`);
    const stop = () => void srv.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  await startStdio(cfg);
}
