import { loadConfig } from '@platform/config';
import { createDb } from '@platform/db';
import { createLogger } from '@platform/observability';

/**
 * Worker — esqueleto F1. O dispatcher real (LISTEN em conexão DEDICADA +
 * polling dinâmico 100ms–1s + fallback 60s, D16r/D22) entra na F2; aqui nasce
 * o processo com config validada, logger com redaction, conexão ao banco e
 * shutdown gracioso — o chassi que o dispatcher vai habitar.
 */
const config = loadConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const sql = createDb(config.DATABASE_URL, { max: 5 });

await sql`SELECT 1`;
logger.info('worker de pé — dispatcher chega na F2 (walking skeleton F1.8)');

let running = true;
const shutdown = async (signal: string) => {
  if (!running) return;
  running = false;
  logger.info({ signal }, 'encerrando worker');
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Heartbeat até o dispatcher da F2 assumir o loop.
const heartbeat = setInterval(() => {
  if (running) logger.debug('worker heartbeat');
}, 60_000);
heartbeat.unref();
