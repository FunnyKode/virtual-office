// Entry point: node src/server/main.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../domain/store.ts';
import { createTranscriptCollector } from '../sources/transcript-collector.ts';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { ensureToken } from './token.ts';

const PRUNE_INTERVAL_MS = 10 * 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();
  const token = await ensureToken(config.tokenFile);
  const store = createStore({
    silenceMs: config.silenceMs,
    windowMs: config.windowMs,
    onListenerError: (error) => logger.error('abonné en échec', { error }),
  });
  const collector = createTranscriptCollector({
    root: config.projectsRoot,
    dispatch: (events) => store.dispatch(events),
    windowMs: config.windowMs,
    maxInitialBytes: config.maxInitialBytes,
    onError: (error, file) => logger.error('lecture de transcript en échec', { file, error }),
  });
  await collector.scan();
  collector.start(config.scanIntervalMs);

  const app = createApp({ store, token, silenceMs: config.silenceMs, publicDir: path.join(ROOT, 'public'), logger });
  const address = await app.listen(config.port, config.host);
  const pruner = setInterval(() => store.prune(), PRUNE_INTERVAL_MS);
  pruner.unref();
  logger.info('bureau virtuel prêt', {
    url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
    transcripts: collector.trackedFiles().length,
    agents: store.snapshot().length,
  });

  const shutdown = async (signal: string) => {
    logger.info('arrêt', { signal });
    await collector.stop();
    clearInterval(pruner);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`virtual-office : ${message}\n`);
  process.exit(1);
});
