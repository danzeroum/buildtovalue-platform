import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { recordTenantAuditEventTx, type AuditActor } from '../audit/tenantAudit.js';
import { historySeq, OUTBOX_CHANNEL } from '../runtime/outbox.js';

/**
 * RETOMADA da parada honesta (AG-2.2 etapa 5 slice 3, ADENDO-02 §5.2). A outra
 * metade do `pauseJob`: move os jobs de agente `paused` de volta a `available`,
 * para o worker os re-pegar. Semântica §5.2 (a reativação devolve os agentes ao
 * trabalho) — sem isto o job fica estacionado para sempre (hang silencioso).
 *
 *  - **kill-switch**: reativar (kill_switch → false) retoma AUTOMATICAMENTE os
 *    jobs pausados por kill-switch daquele tenant.
 *  - **budget**: retomada é AÇÃO EXPLÍCITA do operador (elevar o teto / mandar
 *    retomar) — nunca automática; cada retomada consome orçamento novo (mesma
 *    disciplina da reproposta).
 * As duas gravam FATO na trilha (`agent:retomado`: quem, quando, por quê — envelope
 * D33) + evento de auditoria do tenant, e acordam o worker (pg_notify).
 */
export type PauseKind = 'budget' | 'kill-switch';

export interface ResumeResult {
  resumed: number;
  instanceIds: string[];
}

export async function resumeAgentJobsTx(
  tx: TransactionSql,
  tenantId: string,
  kind: PauseKind,
  actor: AuditActor,
  motivo: string,
): Promise<ResumeResult> {
  const rows = await tx<{ id: string; instance_id: string }[]>`
    UPDATE jobs SET status = 'available', pause_kind = NULL, error = NULL
    WHERE status = 'paused' AND pause_kind = ${kind}
    RETURNING id, instance_id`;
  for (const row of rows) {
    // effect_key único por retomada da instância (conta as anteriores) — a trilha
    // é append-only; re-pausar+retomar gera outra linha, não sobrescreve.
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM history_events
      WHERE instance_id = ${row.instance_id} AND kind = 'agent:retomado'`;
    await tx`INSERT INTO history_events
        (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
      VALUES (${tenantId}, ${row.instance_id}, ${historySeq(0, 60_000 + n)}, 'agent:retomado',
              ${tx.json({ actor: { type: actor.type, id: actor.id, requestId: actor.requestId }, motivo, pauseKind: kind } as never)},
              'host', ${`host:agent-resume:${row.instance_id}:${n}`})
      ON CONFLICT (effect_key) DO NOTHING`;
  }
  if (rows.length > 0) {
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'agent.jobs.resumed',
      resourceType: 'jobs',
      resourceId: tenantId,
      motivo,
      payload: { pauseKind: kind, count: rows.length },
    });
    // acorda o dispatcher: os jobs voltaram para a fila.
    await tx`SELECT pg_notify(${OUTBOX_CHANNEL}, ${tenantId})`;
  }
  return { resumed: rows.length, instanceIds: rows.map((r) => r.instance_id) };
}

/** Retomada explícita (budget) — o operador manda retomar. */
export async function resumeAgentJobs(
  sql: Sql,
  tenantId: string,
  kind: PauseKind,
  actor: AuditActor,
  motivo: string,
): Promise<ResumeResult> {
  return withTenant(sql, tenantId, (tx) => resumeAgentJobsTx(tx, tenantId, kind, actor, motivo));
}
