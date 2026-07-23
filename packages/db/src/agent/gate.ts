import type { TransactionSql } from '../client.js';
import { getToolDefinitionByRefTx } from '../registry/toolStore.js';
import type { AgentActor } from './agentTrail.js';

/**
 * Ciclo do gate de tool (AG-2.2 etapa 5, D31/D28). O agente PROPÕE (o world-delta
 * abre a tarefa de gate); o humano aprova/reprova; o efeito só roda sob selo. As
 * decisões de RUNTIME (proposta expirou? pode repropor?) leem `instance_gate_state`
 * (operacional), nunca a trilha.
 */

/** CAP DURO de repropostas por elemento (decisão do dono, Q4): reproposta é ação
 * explícita; o cap é o backstop de runaway (propõe→avança→expira→repropõe). */
export const REPROPOSAL_CAP = 3;

export interface GateState {
  proposalRevision: number;
  reproposalCount: number;
}

/** Abre (ou re-abre) o gate: grava a revisão da proposta no estado operacional.
 * `reproposal:false` = 1ª proposta (INSERT); a reproposta usa {@link requestReproposal}. */
export async function recordGateProposal(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  elementId: string,
  proposalRevision: number,
): Promise<void> {
  await tx`INSERT INTO instance_gate_state (tenant_id, instance_id, element_id, proposal_revision)
    VALUES (${tenantId}, ${instanceId}, ${elementId}, ${proposalRevision})
    ON CONFLICT (tenant_id, instance_id, element_id) DO NOTHING`;
}

export async function getGateState(
  tx: TransactionSql,
  instanceId: string,
  elementId: string,
): Promise<GateState | null> {
  const [row] = await tx<{ proposal_revision: number; reproposal_count: number }[]>`
    SELECT proposal_revision, reproposal_count FROM instance_gate_state
    WHERE instance_id = ${instanceId} AND element_id = ${elementId}`;
  return row ? { proposalRevision: row.proposal_revision, reproposalCount: row.reproposal_count } : null;
}

/**
 * D28 re-verify na aprovação: a proposta ainda vale se a instância não avançou
 * desde que o gate abriu. `fresh:false` → estado "proposta expirada" (voz própria,
 * não botão mudo) — reavaliar, não executar.
 */
export function verifyProposalFresh(state: GateState, currentRevision: number): { fresh: boolean } {
  return { fresh: state.proposalRevision === currentRevision };
}

export type ReproposalOutcome =
  | { ok: true; count: number }
  | { ok: false; reason: 'cap-exceeded'; count: number };

/**
 * Reproposta EXPLÍCITA (operador/gate) — nunca automática (evita o laço da Q4).
 * Incrementa o contador sob o CAP; estourou → parada honesta "reavaliação manual".
 * Cada reproposta re-abre com a nova revisão e consome budget (visível na trilha
 * pelo caller). Retorna a nova contagem para o caller gravar o fato.
 */
export async function requestReproposal(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  elementId: string,
  newRevision: number,
  cap: number = REPROPOSAL_CAP,
): Promise<ReproposalOutcome> {
  const state = await getGateState(tx, instanceId, elementId);
  const count = state?.reproposalCount ?? 0;
  if (count >= cap) return { ok: false, reason: 'cap-exceeded', count };
  await tx`UPDATE instance_gate_state
    SET reproposal_count = reproposal_count + 1, proposal_revision = ${newRevision}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND instance_id = ${instanceId} AND element_id = ${elementId}`;
  return { ok: true, count: count + 1 };
}

/**
 * SELO de procedência do efeito (D31, encaixe (b) do designer): a linha de trilha
 * do efeito carrega gate id + ator + momento + a tool/classe. É a prova de que o
 * efeito irreversível rodou SOB aprovação humana — não conteúdo, procedência.
 */
export interface EffectSelo {
  gateId: string;
  tool: string;
  effectClass: string;
  actor: AgentActor;
  approvedAt: string;
}

export function effectSelo(input: {
  gateId: string;
  tool: string;
  effectClass: string;
  actor: AgentActor;
  approvedAt: string;
}): EffectSelo {
  return { ...input };
}

/**
 * STALENESS de tool (adição 2 do designer, 4ª voz de parada): antes de executar o
 * efeito, a tool aprovada precisa AINDA existir/valer. Mudou/foi despublicada
 * desde a aprovação → `stale` (o gate aprovado segue visível na trilha; a falha é
 * POSTERIOR ao aval de boa-fé). Distinta de budget/kill-switch/needs-gate.
 */
export async function checkToolFresh(
  tx: TransactionSql,
  toolRef: string,
): Promise<{ fresh: boolean }> {
  const tool = await getToolDefinitionByRefTx(tx, toolRef);
  return { fresh: tool !== undefined };
}
