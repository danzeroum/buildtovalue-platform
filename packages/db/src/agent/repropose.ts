import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import type { AuditActor } from '../audit/tenantAudit.js';
import { REPROPOSAL_CAP, requestReproposal, getGateState } from './gate.js';

/**
 * REPROPOSTA do gate (AG-2.2 etapa 5 slice 3 final, D31 Q4). Fecha a Q4 ("ação
 * explícita + cap duro") de forma real: o operador manda REAVALIAR uma proposta
 * (tipicamente expirada). Cada reproposta:
 *  - respeita o CAP DURO por elemento (estourou → recusa com motivo, nunca silêncio);
 *  - reabre o baseline D28 na revisão ATUAL (a nova proposta vale contra o estado novo);
 *  - grava FATO na trilha (`agent:reproposta`: envelope de ator + momento + #N) —
 *    a reproposta CONSOME NOVO ORÇAMENTO; o consumo é auditável, não silencioso.
 * A reavaliação em si (o agente gerar a nova proposta contra o estado atual) exige
 * o re-disparo do agentTask — item de runtime maior; aqui grava-se a AUTORIZAÇÃO
 * explícita (com custo e teto), que é o que a Q4 nomeia.
 */
export type ReproposeResult =
  | { ok: true; count: number; cap: number }
  | { ok: false; reason: 'cap-exceeded'; count: number; cap: number }
  | { ok: false; reason: 'no-gate-state' };

export async function reproposeGateTx(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  elementId: string,
  actor: AuditActor,
  motivo: string,
): Promise<ReproposeResult> {
  // o gate precisa ter PROPOSTO (instance_gate_state existe, gravado no gate-open).
  const state = await getGateState(tx, instanceId, elementId);
  if (!state) return { ok: false, reason: 'no-gate-state' };
  const [inst] = await tx<{ revision: number }[]>`SELECT revision FROM instances WHERE id = ${instanceId}`;
  const currentRevision = inst ? Number(inst.revision) : state.proposalRevision;

  const outcome = await requestReproposal(tx, tenantId, instanceId, elementId, currentRevision);
  if (!outcome.ok) return { ok: false, reason: 'cap-exceeded', count: outcome.count, cap: REPROPOSAL_CAP };

  // FATO da reproposta (marcação §6): ator + momento + #N + consumo de orçamento.
  // effect_key único por reproposta (a contagem) — append-only, nunca sobrescreve.
  await tx`INSERT INTO history_events
      (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
    VALUES (${tenantId}, ${instanceId}, ${currentRevision * 100_000 + 61_000 + outcome.count},
            'agent:reproposta',
            ${tx.json({ actor: { type: actor.type, id: actor.id, requestId: actor.requestId }, motivo, elementId, reproposta: outcome.count, cap: REPROPOSAL_CAP, budget: 'novo-orçamento-consumido' } as never)},
            'host', ${`host:gate-repropose:${instanceId}:${elementId}:${outcome.count}`})
    ON CONFLICT (effect_key) DO NOTHING`;
  return { ok: true, count: outcome.count, cap: REPROPOSAL_CAP };
}

export async function reproposeGate(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  elementId: string,
  actor: AuditActor,
  motivo: string,
): Promise<ReproposeResult> {
  return withTenant(sql, tenantId, (tx) => reproposeGateTx(tx, tenantId, instanceId, elementId, actor, motivo));
}
