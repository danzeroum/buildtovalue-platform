import { createServer } from 'node:http';
import { loadConfig } from '@platform/config';
import { signAccessToken } from '@platform/auth';
import {
  buildAgentFacts,
  classificationsForRef,
  createDb,
  createEnvKeyProvider,
  createFieldCipher,
  dispatchOutboxOnce,
  getAgentDefinitionByRef,
  getInstance,
  lockJobs,
  persistAgentTrail,
  runAgentJob,
  type AgentJobInput,
  OUTBOX_CHANNEL,
  runtimeDepths,
  sweepDueTimersOnce,
  sweepIdempotencyKeys,
  withTenant,
} from '@platform/db';
import { createLogger, createRuntimeMetrics } from '@platform/observability';
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

// AgentRunner (AG-2.2 etapa 3): materializa o `agentTask` (job type 'agent') —
// CAMINHA o grafo agentflow. O interior não é determinístico (D27). Parada
// honesta em execução (kill-switch entre passos) + budget preservam a trilha
// parcial → incidente com voz de operador, nunca conclusão silenciosa.
// `resolveGraph` agora é REGISTRY-BACKED: o job carrega o PIN (`agentRef` já
// resolvido no start da instância) e o grafo GOVERNADO vem do registry, verbatim
// (validateGraph passou no deploy). O caminho de grafo-em-payload foi DELETADO
// (colapso §2.10) — não há mais grafo não-governado em produção nem em teste.
registry.register('agent', async (job) => {
  const input: AgentJobInput = {
    elementId: typeof job.payload.elementId === 'string' ? job.payload.elementId : undefined,
    // `effectiveRef` = o PIN substituído no despacho (etapa 4); o worker roda o
    // grafo governado por ele, nunca pela ref declarada/flutuante.
    agentRef: typeof job.payload.effectiveRef === 'string' ? job.payload.effectiveRef : undefined,
    fixtures: job.payload.fixtures as AgentJobInput['fixtures'],
  };
  const outcome = await runAgentJob(sql, job.tenantId, input, {
    resolveGraph: async (i) => {
      if (!i.agentRef) return null;
      const def = await getAgentDefinitionByRef(sql, job.tenantId, i.agentRef);
      return def ? { graph: def.graph } : null;
    },
  });
  // Trilha MASCARADA (etapa 3 §2): grava o I/O do agente em history_events.agent_io,
  // CONSERVADOR por padrão (nunca em claro). A parada honesta também vira fato. As
  // classificações vêm da definição da instância (mesmo mapa da costura LGPD F2).
  // Best-effort: falha ao gravar a trilha é logada, não reverte a conclusão do job.
  try {
    const instance = await getInstance(sql, job.tenantId, job.instanceId);
    if (instance) {
      const classifications = await classificationsForRef(sql, job.tenantId, instance.definition_ref);
      const facts = buildAgentFacts({
        io: { output: outcome.walk.output ?? {} },
        visitedNodes: outcome.walk.visitedNodes,
        complete: outcome.walk.complete,
        stopReason: outcome.ok ? undefined : outcome.message,
        decisions: outcome.walk.decisions,
      });
      await withTenant(sql, job.tenantId, (tx) =>
        persistAgentTrail(tx, {
          tenantId: job.tenantId,
          instanceId: job.instanceId,
          elementId: input.elementId ?? 'agentTask',
          agentRef: input.agentRef ?? '',
          // envelope de ator (D33): o AGENTE corre esta trilha; id = pin efetivo,
          // requestId = o job (correlação da corrida). Gravado desde já.
          actor: { type: 'agent', id: input.agentRef ?? 'agentTask', requestId: job.jobId },
          facts,
          classifications,
          engineVersion: instance.engine_version,
          revision: instance.revision,
        }),
      );
    }
  } catch (error) {
    logger.warn({ jobId: job.jobId, err: error }, 'trilha de agente não gravada (conclusão segue)');
  }
  return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.message };
});
const waker = createWaker();
// Costura LGPD (D20): a varredura de timers avança instâncias que podem ter
// variáveis sensitive — mesmo cipher da API.
const cipher = config.FIELD_KEY_SECRET
  ? createFieldCipher(createEnvKeyProvider(config.FIELD_KEY_SECRET))
  : undefined;

// Métricas 9.2: /metrics em porta própria do worker (Prometheus scrape).
const metrics = createRuntimeMetrics();
const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? 9100);
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metrics.registry.metrics().then((body: string) => {
      res.setHeader('content-type', metrics.registry.contentType);
      res.end(body);
    });
  } else {
    res.statusCode = 404;
    res.end();
  }
});
metricsServer.listen(metricsPort);

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
  // nomes NOVOS do contrato (shape §5, decisão 10.a); aliases somem na F4
  const path = run.ok ? 'completion' : 'failure';
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

// Limpeza das idempotency_keys (retenção 24h) em cadência espaçada — não a
// cada tick.
let lastIdempotencySweep = 0;
const IDEMPOTENCY_SWEEP_INTERVAL_MS = 10 * 60_000;

async function tick(): Promise<boolean> {
  let hadWork = false;
  const sweepKeys = Date.now() - lastIdempotencySweep > IDEMPOTENCY_SWEEP_INTERVAL_MS;
  if (sweepKeys) lastIdempotencySweep = Date.now();
  for (const tenantId of await tenantsWithWork()) {
    if (sweepKeys) {
      const cleaned = await sweepIdempotencyKeys(sql, tenantId);
      if (cleaned.deleted > 0) logger.info({ tenantId, ...cleaned }, 'idempotency_keys expiradas removidas');
    }
    const dispatched = await dispatchOutboxOnce(sql, tenantId, {
      onInfo: (row) => logger.debug({ effect: row.effect.type }, 'efeito informativo'),
    });
    metrics.effectsDispatched.inc({ tenant: tenantId }, dispatched.processed);
    if (dispatched.deadLettered > 0) {
      metrics.effectsDeadLettered.inc({ tenant: tenantId }, dispatched.deadLettered);
      logger.error({ tenantId, ...dispatched }, 'efeitos em dead-letter → incidents');
    }
    if (dispatched.processed > 0) {
      hadWork = true;
      logger.info({ tenantId, ...dispatched }, 'outbox despachada');
    }

    const swept = await sweepDueTimersOnce(sql, tenantId, { cipher });
    if (swept.fired > 0) {
      hadWork = true;
      metrics.timersFired.inc({ tenant: tenantId }, swept.fired);
      logger.info({ tenantId, ...swept }, 'timers disparados');
    }

    const depths = await runtimeDepths(sql, tenantId);
    metrics.outboxDepth.set({ tenant: tenantId }, depths.outboxPending);
    metrics.jobsAvailable.set({ tenant: tenantId }, depths.jobsAvailable);
    metrics.timersLate.set({ tenant: tenantId }, depths.timersLate);
    metrics.incidentsOpen.set({ tenant: tenantId }, depths.incidentsOpen);

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
  metricsServer.close();
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
