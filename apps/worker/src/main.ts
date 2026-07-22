import { loadConfig } from '@platform/config';
import { signAccessToken } from '@platform/auth';
import {
  createDb,
  dispatchOutboxOnce,
  lockJobs,
  OUTBOX_CHANNEL,
  sweepDueTimersOnce,
} from '@platform/db';
import { createLogger } from '@platform/observability';
import { createHandlerRegistry, type JobContext } from './handlers.js';
import { createWaker, IDLE_BASE_MS, nextDelayMs } from './loop.js';

/**
 * Worker F2 (plano §F2 itens 2–4): dispatcher com LISTEN em conexão
 * DEDICADA (fora do pooler transaction-mode) + polling dinâmico (100ms com
 * itens / 1s vazio / fallback 60s), varredura de timers, e execução de jobs
 * pelo JobHandlerRegistry — handler FORA de transação, conclusão SEMPRE pelo
 * contrato público POST /v1/jobs/{id}/complete|fail com lock_token (D22/D12).
 */
const config = loadConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const sql = createDb(config.DATABASE_URL, { max: 5 });
// Conexão DEDICADA do LISTEN: cliente próprio com max 1 — nunca passa pelo
// pool de queries nem por pooler em transaction-mode (plano §F2 item 2).
const listenSql = createDb(config.DATABASE_URL, { max: 1 });
const apiBase = process.env.WORKER_API_BASE ?? `http://localhost:${config.API_PORT}`;
const workerId = `worker-${process.pid}`;

const registry = createHandlerRegistry({
  log: (message, fields) => logger.info(fields ?? {}, message),
});
const waker = createWaker();

await sql`SELECT 1`;
await listenSql.listen(OUTBOX_CHANNEL, (tenantId) => {
  logger.debug({ tenantId }, 'notify da outbox — acordando o loop');
  waker.wake();
});
logger.info({ workerId, apiBase, channel: OUTBOX_CHANNEL }, 'worker F2 de pé (LISTEN + poll dinâmico)');

async function machineToken(tenantId: string): Promise<string> {
  // Token de máquina restrito a jobs (plano §6): papel operator via RBAC.
  const { accessToken } = await signAccessToken(
    { sub: workerId, tenantId, role: 'operator' },
    { secret: config.JWT_SECRET, accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS },
  );
  return accessToken;
}

async function tenantsWithWork(): Promise<string[]> {
  const rows = await sql`SELECT id FROM tenants`;
  return rows.map((r) => r.id as string);
}

async function conclude(
  tenantId: string,
  jobId: string,
  lockToken: string,
  run: Awaited<ReturnType<typeof registry.run>>,
): Promise<void> {
  const token = await machineToken(tenantId);
  const path = run.ok ? 'complete' : 'fail';
  const body = run.ok
    ? { lockToken, ...(run.result ? { result: run.result } : {}) }
    : { lockToken, error: run.error.slice(0, 2000) };
  const response = await fetch(`${apiBase}/v1/jobs/${jobId}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (response.ok) {
    logger.info({ jobId, path }, 'job concluído via contrato');
  } else {
    // 409 = fencing (lease reassumida): outro worker é o dono agora.
    logger.warn({ jobId, path, status: response.status }, 'conclusão recusada pelo contrato');
  }
}

async function tick(): Promise<boolean> {
  let hadWork = false;
  for (const tenantId of await tenantsWithWork()) {
    const dispatched = await dispatchOutboxOnce(sql, tenantId, {
      onInfo: (row) => logger.debug({ effect: row.effect.type }, 'efeito informativo'),
    });
    if (dispatched.deadLettered > 0) {
      logger.error({ tenantId, ...dispatched }, 'efeitos em dead-letter → incidents');
    }
    if (dispatched.processed > 0) {
      hadWork = true;
      logger.info({ tenantId, ...dispatched }, 'outbox despachada');
    }

    const swept = await sweepDueTimersOnce(sql, tenantId);
    if (swept.fired > 0) {
      hadWork = true;
      logger.info({ tenantId, ...swept }, 'timers disparados');
    }

    const jobs = await lockJobs(sql, tenantId, workerId, { leaseMs: 30_000 });
    for (const job of jobs) {
      hadWork = true;
      const context: JobContext = {
        jobId: job.id,
        instanceId: job.instance_id,
        tenantId,
        type: job.type,
        payload: job.payload,
      };
      const run = await registry.run(context);
      await conclude(tenantId, job.id, job.lock_token!, run);
    }
  }
  return hadWork;
}

let running = true;
const shutdown = async (signal: string) => {
  if (!running) return;
  running = false;
  logger.info({ signal }, 'encerrando worker');
  waker.wake();
  await listenSql.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

let delay = IDLE_BASE_MS;
while (running) {
  let hadWork = false;
  try {
    hadWork = await tick();
  } catch (error) {
    logger.error({ err: error }, 'tick falhou — segue no próximo');
  }
  delay = nextDelayMs(delay, hadWork);
  await waker.sleep(delay);
}
export {};
