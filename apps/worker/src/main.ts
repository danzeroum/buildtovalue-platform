import { loadConfig } from '@platform/config';
import { signAccessToken } from '@platform/auth';
import { createDb, dispatchOutboxOnce, lockJobs, sweepDueTimersOnce } from '@platform/db';
import { createLogger } from '@platform/observability';

/**
 * Worker do WALKING SKELETON (F1.8): loop de dispatch da outbox
 * (FOR UPDATE SKIP LOCKED) + execução de jobs pelo CONTRATO PÚBLICO —
 * o handler roda FORA de transação e conclui via POST /v1/jobs/{id}/complete
 * com lock_token (D22/D12). A F2 troca o polling fixo por LISTEN dedicado +
 * polling dinâmico (100ms–1s, fallback 60s) e registra handlers reais no
 * JobHandlerRegistry; aqui o handler é o noop do skeleton.
 */
const config = loadConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const sql = createDb(config.DATABASE_URL, { max: 5 });
const apiBase = process.env.WORKER_API_BASE ?? `http://localhost:${config.API_PORT}`;
const workerId = `worker-${process.pid}`;

await sql`SELECT 1`;
logger.info({ workerId, apiBase }, 'worker do skeleton de pé');

async function machineToken(tenantId: string): Promise<string> {
  // Token de máquina restrito a jobs (plano §6): papel operator via RBAC.
  const { accessToken } = await signAccessToken(
    { sub: workerId, tenantId, role: 'operator' },
    { secret: config.JWT_SECRET, accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS },
  );
  return accessToken;
}

async function tenantsWithWork(): Promise<string[]> {
  // Skeleton: varre tenants com outbox/jobs pendentes (a F2 herda isto no
  // dispatcher com LISTEN por canal). Conexão do worker é app_api (RLS) —
  // a listagem vem das próprias linhas visíveis por tenant via união dos
  // contextos conhecidos: aqui, tenants da tabela (SELECT liberado).
  const rows = await sql`SELECT id FROM tenants`;
  return rows.map((r) => r.id as string);
}

async function tick(): Promise<void> {
  for (const tenantId of await tenantsWithWork()) {
    const dispatched = await dispatchOutboxOnce(sql, tenantId, {
      onInfo: (row) => logger.debug({ effect: row.effect.type }, 'efeito informativo'),
    });
    if (dispatched.processed > 0) logger.info({ tenantId, ...dispatched }, 'outbox despachada');

    // Timers vencidos → TimerFired → avanço (F2.4). A varredura marca
    // 'fired' na mesma tx do avanço; efeitos resultantes saem no próximo
    // dispatch da outbox.
    const swept = await sweepDueTimersOnce(sql, tenantId);
    if (swept.fired > 0) logger.info({ tenantId, ...swept }, 'timers disparados');

    const jobs = await lockJobs(sql, tenantId, workerId, { leaseMs: 30_000 });
    for (const job of jobs) {
      // handler noop FORA de tx; conclusão SEMPRE pelo contrato público.
      const token = await machineToken(tenantId);
      const response = await fetch(`${apiBase}/v1/jobs/${job.id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ lockToken: job.lock_token }),
      });
      if (response.ok) logger.info({ jobId: job.id }, 'job concluído via contrato');
      else logger.warn({ jobId: job.id, status: response.status }, 'conclusão recusada (fencing?)');
    }
  }
}

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

const POLL_MS = 500;
while (running) {
  try {
    await tick();
  } catch (error) {
    logger.error({ err: error }, 'tick falhou — segue no próximo');
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
export {};
