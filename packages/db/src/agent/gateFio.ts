import type { BpmnDiagram } from '@buildtovalue/core';
import type { TransactionSql } from '../client.js';
import { getToolDefinitionByRefTx } from '../registry/toolStore.js';
import { historySeq } from '../runtime/outbox.js';
import type { AgentActor } from './agentTrail.js';
import { checkToolFresh, effectSelo, type EffectSelo } from './gate.js';
import { buildWorldDelta, deriveProcessConsequence, type WorldDelta } from './worldDelta.js';

/**
 * O FIO do gate de tool (AG-2.2 etapa 5 slice 3, item 2, D31): world-delta →
 * payload → selo. Liga as peças provadas isoladas (worldDelta/gate) ao estado
 * REAL — o payload da tarefa de gate e a linha `agent:acao` do efeito.
 *
 *  1. buildGatePayloadTx: monta o world-delta do gate a partir do ToolContract
 *     RESOLVIDO (uma vez) + params propostos + consequência derivada do BPMN.
 *     `processConsequence:null` = degrade honesto (só as duas dimensões da tool;
 *     nunca inferir consequência que possa estar errada).
 *  2. setGatePayloadTx: grava o world-delta no `user_tasks.payload` do gate.
 *  3. sealGatedEffectTx: na execução do efeito (após o aval), a STALENESS é
 *     verificada; fresca → linha `agent:acao` com o SELO (prova D31); alterada/
 *     desabilitada → incidente `agentToolStale` (vermelho), o efeito NÃO executa,
 *     e o gate aprovado permanece na trilha (o humano aprovou de boa-fé).
 */

/** Monta o world-delta do gate: contrato resolvido 1× + params + consequência. */
export async function buildGatePayloadTx(
  tx: TransactionSql,
  args: { toolRef: string; params: Record<string, unknown>; diagram: BpmnDiagram; gateElementId: string },
): Promise<WorldDelta | null> {
  const tool = await getToolDefinitionByRefTx(tx, args.toolRef);
  if (!tool) return null; // tool inexistente: sem world-delta (o deploy garante que exista)
  const processConsequence = deriveProcessConsequence(args.diagram, args.gateElementId);
  return buildWorldDelta({
    toolRef: tool.ref,
    capability: tool.capability,
    effect: tool.effect,
    authorization: tool.authorization,
    dataScope: tool.data_scope,
    evidenceRequired: tool.contract.evidenceRequired,
    params: args.params,
    processConsequence,
  });
}

/** Grava o world-delta no payload da tarefa de gate (só se ela FOR gate). */
export async function setGatePayloadTx(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  gateElementId: string,
  payload: WorldDelta,
): Promise<void> {
  await tx`UPDATE user_tasks SET payload = ${tx.json(payload as never)}
    WHERE tenant_id = ${tenantId} AND instance_id = ${instanceId}
      AND element_id = ${gateElementId} AND is_gate = true`;
}

export type SealOutcome =
  | { executed: true; selo: EffectSelo }
  | { executed: false; reason: 'tool-stale' };

/**
 * Sela e executa o efeito sob gate. A STALENESS (adição 2 do designer, D31) é a
 * porta: a tool aprovada precisa AINDA existir/valer no momento da execução.
 *  · fresca  → grava a linha `agent:acao` do efeito com o SELO {gateId, tool,
 *    effectClass, actor, approvedAt} — procedência, não conteúdo. É a prova D31.
 *  · stale   → incidente `agentToolStale` (vermelho — distinto de budget/kill-switch
 *    âmbar), o efeito NÃO roda; o gate aprovado (fato anterior) permanece visível.
 * Append-only: effect_key determinístico por (instância, gate) → idempotente.
 */
export async function sealGatedEffectTx(
  tx: TransactionSql,
  args: {
    tenantId: string;
    instanceId: string;
    gateElementId: string;
    toolRef: string;
    actor: AgentActor;
    approvedAt: string;
    revision: number;
    engineVersion: string;
  },
): Promise<SealOutcome> {
  const fresh = await checkToolFresh(tx, args.toolRef);
  if (!fresh.fresh) {
    await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key, payload)
      VALUES (${args.tenantId}, ${args.instanceId}, 'agentToolStale',
              ${`efeito não executado — a tool ${args.toolRef} mudou/foi desabilitada desde a aprovação`},
              ${`host:gate-stale:${args.instanceId}:${args.gateElementId}`},
              ${tx.json({ toolRef: args.toolRef, gateId: args.gateElementId, actor: args.actor, approvedAt: args.approvedAt } as never)})
      ON CONFLICT (effect_key) DO NOTHING`;
    return { executed: false, reason: 'tool-stale' };
  }
  const tool = await getToolDefinitionByRefTx(tx, args.toolRef);
  const selo = effectSelo({
    gateId: args.gateElementId,
    tool: args.toolRef,
    effectClass: tool!.effect,
    actor: args.actor,
    approvedAt: args.approvedAt,
  });
  // SELO na linha `agent:acao` do EFEITO (marcação §4): prova de que o efeito
  // irreversível rodou SOB aprovação humana. Não é enfeite — é auditoria D31.
  await tx`INSERT INTO history_events
      (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
    VALUES (${args.tenantId}, ${args.instanceId}, ${historySeq(args.revision, 55_000)},
            'agent:acao',
            ${tx.json({ elementId: args.gateElementId, actor: args.actor, selo, message: `efeito sob gate: ${args.toolRef}` } as never)},
            ${args.engineVersion},
            ${`host:gate-effect:${args.instanceId}:${args.gateElementId}`})
    ON CONFLICT (effect_key) DO NOTHING`;
  return { executed: true, selo };
}
