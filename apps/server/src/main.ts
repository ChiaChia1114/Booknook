import { loadConfig } from './config';
import { buildApp } from './app';

// Everything the server writes (database, secret key, uploaded logs and firmware, caches) is for
// its own user only – also inside a data directory or volume created with looser permissions.
process.umask(0o077);

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});

const args = new Set(process.argv.slice(2));
const config = loadConfig(process.env, args.has('--demo') ? { demo: true } : {});
const { app, ctx } = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
app.log.info(`Athena-sky listening on ${config.publicUrl} (data: ${config.dataDir})`);

let stopDemo: (() => Promise<void>) | null = null;
if (config.demo) {
  const { startDemo } = await import('./demo/demo');
  stopDemo = await startDemo(ctx, `ws://127.0.0.1:${config.port}/api/v2/link`);
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`${signal} received, shutting down`);
  await stopDemo?.();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
