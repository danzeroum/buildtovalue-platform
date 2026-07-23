import {
  validateGraph,
  parseRef,
  formatRef,
  AgentRefError,
  type AgentWorkflow,
  type ValidationIssue,
} from '@buildtovalue/agentflow';
import { agentTasksOf, type BpmnDiagram } from '@buildtovalue/core';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { historySeq } from '../runtime/outbox.js';

/**
 * Registry de AGENTES (AG-2.2 etapa 3 [GATE + MIGRAÇÃO]). Espelha o registry de
 * process/form: deploy IMUTÁVEL com `validateGraph` no GATE — issue de erro =
 * nada gravado, a mesma UI de rejeição do D19. `ref` (`id@version`) é o PIN da
 * corrida; a versão é semver DECLARADA pelo autor (não auto-incrementada).
 *
 * Resolução de ref:
 *   - PINADA (`agnt-rsch@2.1.0`): lookup exato pela `ref` canônica.
 *   - FLUTUANTE (`agnt-rsch`, sem `@`): latest-per-name por semver (resolvida
 *     UMA vez no start da instância, nunca por execução de job — etapa 3 §1).
 * O pin efetivo resolvido é o que a corrida grava no history_events.
 */
export interface AgentDefinitionRow {
  id: string;
  agent_id: string;
  version: string;
  ref: string;
  name: string;
  autonomy_level: number;
  graph: AgentWorkflow;
  created_at: string;
}

export type DeployAgentOutcome =
  | { ok: true; definition: AgentDefinitionRow; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Compara dois semver `major.minor.patch` (parseRef já normalizou para a forma
 * cheia). Ordem numérica por componente — a lexical erraria `10.0.0 < 9.0.0`.
 * Retorna >0 se `a` é mais novo que `b`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Deploy IMUTÁVEL com o GATE de validação. `validateGraph` roda headless (a
 * mesma checagem do save/promoção da lib); qualquer issue `error` bloqueia e
 * NADA é gravado. A `ref` canônica (`formatRef`) carimba a identidade — a
 * UNIQUE (tenant, ref) recusa re-deploy da MESMA versão (imutabilidade: sobe
 * versão nova, nunca reescreve). Sem `resolveDelegate`/`resolveTool` injetados,
 * delegate/tool degradam a warning (§1.7 da lib) — nunca falso-erro.
 */
export async function deployAgentDefinition(
  sql: Sql,
  tenantId: string,
  input: { graph: AgentWorkflow; createdBy?: string },
): Promise<DeployAgentOutcome> {
  const issues = validateGraph(input.graph);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) return { ok: false, issues };

  const ref = formatRef({ id: input.graph.id, version: input.graph.version });
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx<AgentDefinitionRow[]>`
      INSERT INTO agent_definitions
        (tenant_id, agent_id, version, ref, name, autonomy_level, graph, created_by)
      VALUES (${tenantId}, ${input.graph.id}, ${input.graph.version}, ${ref},
              ${input.graph.name}, ${input.graph.autonomyLevel},
              ${tx.json(input.graph as never)}, ${input.createdBy ?? null})
      RETURNING id, agent_id, version, ref, name, autonomy_level, graph, created_at`;
    return { ok: true, definition: row, warnings: issues };
  });
}

export async function getAgentDefinitionByRef(
  sql: Sql,
  tenantId: string,
  ref: string,
): Promise<AgentDefinitionRow | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<AgentDefinitionRow[]>`
      SELECT id, agent_id, version, ref, name, autonomy_level, graph, created_at
      FROM agent_definitions WHERE ref = ${ref}`;
    return rows[0];
  });
}

/**
 * Resultado da resolução de um agentTask: o PIN efetivo (ref canônica cheia) +
 * a definição resolvida. `floating` marca que o ref de entrada NÃO trazia
 * versão — o start da instância grava a versão resolvida (etapa 3 §1). `null`
 * quando o id não existe no registry do tenant.
 */
export interface ResolvedAgentDefinition {
  definition: AgentDefinitionRow;
  /** ref canônica efetiva (`id@version`) — o PIN a gravar no history_events. */
  pinnedRef: string;
  /** true = ref de entrada era flutuante (sem `@version`), resolvida agora. */
  floating: boolean;
}

/**
 * Resolve o ref de um agentTask no START da instância (nunca por job). Aceita:
 *   - `id@version` (PINADO) → lookup exato; a versão é o pin, verbatim.
 *   - `id` (FLUTUANTE, sem `@`) → latest-per-name por semver; a versão
 *     resolvida vira o pin gravado.
 * Retorna `null` se nada casar. Deliberadamente distingue as duas formas por
 * `parseRef` (que exige `@`): sem `@` é flutuante; com `@` é pinado.
 */
export async function resolveAgentRef(
  sql: Sql,
  tenantId: string,
  agentRef: string,
): Promise<ResolvedAgentDefinition | null> {
  return withTenant(sql, tenantId, (tx) => resolveAgentRefTx(tx, agentRef));
}

/** Variante tx-scoped de {@link resolveAgentRef}: resolve DENTRO da transação
 * do start da instância (o pin é gravado no mesmo commit que cria a corrida). */
export async function resolveAgentRefTx(
  tx: TransactionSql,
  agentRef: string,
): Promise<ResolvedAgentDefinition | null> {
  // Pinado se `parseRef` aceita (tem `@version`); flutuante caso contrário.
  let pinned: { id: string; version: string } | null = null;
  try {
    pinned = parseRef(agentRef).ref;
  } catch (error) {
    if (!(error instanceof AgentRefError)) throw error;
  }

  if (pinned) {
    const ref = formatRef(pinned);
    const [row] = await tx<AgentDefinitionRow[]>`
      SELECT id, agent_id, version, ref, name, autonomy_level, graph, created_at
      FROM agent_definitions WHERE ref = ${ref}`;
    return row ? { definition: row, pinnedRef: row.ref, floating: false } : null;
  }
  // Flutuante: todas as versões do id, maior semver vence (ordenação em JS —
  // a lexical do Postgres erraria a comparação de versões).
  const rows = await tx<AgentDefinitionRow[]>`
    SELECT id, agent_id, version, ref, name, autonomy_level, graph, created_at
    FROM agent_definitions WHERE agent_id = ${agentRef}`;
  if (rows.length === 0) return null;
  const latest = rows.reduce((best, r) => (compareSemver(r.version, best.version) > 0 ? r : best));
  return { definition: latest, pinnedRef: latest.ref, floating: true };
}

/** Pin de um agentTask resolvido no START (etapa 3 §1) — gravado no history_events. */
export interface AgentPin {
  elementId: string;
  /** ref DECLARADA no BPMN (flutuante `agnt-x` ou pinada `agnt-x@1.0.0`). */
  requestedRef: string;
  /** ref efetiva resolvida (`agnt-x@1.0.0`) — o PIN da corrida. */
  resolvedRef: string;
  version: string;
  /** true = a ref declarada era flutuante e foi pinada agora. */
  floating: boolean;
  /** envelope de ator (D33) — quem resolveu o pin (o runtime = `system`). */
  actor: { type: 'agent' | 'user' | 'system'; id: string; requestId?: string };
}

export type AgentPinResult =
  | { ok: true; pin: AgentPin }
  | { ok: false; elementId: string; requestedRef: string; reason: 'unpublished' };

/**
 * Resolução AUDITÁVEL dos agentTasks no START da instância (etapa 3 §1). Para
 * CADA `agentTask` do diagrama:
 *   - lê `agentWorkflowRef` (a ref declarada, flutuante ou pinada);
 *   - resolve contra o registry NESTA transação — o pin efetivo é gravado no
 *     MESMO commit que cria a corrida, NUNCA por execução de job;
 *   - grava um `history_events` `agentPinResolved` com a versão efetiva (a
 *     "versão efetiva aparece no history_events da corrida"). Ref flutuante que
 *     não resolve = incidente `agentUnpublished` (parada honesta: o registry é
 *     o único caminho governado — publique o agente).
 *
 * `seq` no range da revisão 0 (pré-StartInstance): o pin PRECEDE a semântica do
 * processo. effect_key determinístico por (instância, elemento) — idempotente.
 */
export async function recordAgentPinsAtStart(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  diagram: BpmnDiagram,
  engineVersion: string,
): Promise<AgentPinResult[]> {
  const tasks = agentTasksOf(diagram);
  const results: AgentPinResult[] = [];
  let index = 0;
  for (const node of tasks) {
    const requestedRef =
      typeof node.properties.agentWorkflowRef === 'string' ? node.properties.agentWorkflowRef : '';
    if (!requestedRef) {
      // agentTask sem ref é defeito de modelagem — o deploy (lint) barra antes;
      // em runtime, incidente honesto em vez de corrida sem agente.
      await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key)
        VALUES (${tenantId}, ${instanceId}, 'agentUnpublished',
                ${`agentTask '${node.id}' sem agentWorkflowRef`},
                ${`host:agent-pin:${instanceId}:${node.id}`})
        ON CONFLICT (effect_key) DO NOTHING`;
      results.push({ ok: false, elementId: node.id, requestedRef: '', reason: 'unpublished' });
      continue;
    }
    const resolved = await resolveAgentRefTx(tx, requestedRef);
    if (!resolved) {
      await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key)
        VALUES (${tenantId}, ${instanceId}, 'agentUnpublished',
                ${`agentTask '${node.id}': ref '${requestedRef}' não publicada no registry`},
                ${`host:agent-pin:${instanceId}:${node.id}`})
        ON CONFLICT (effect_key) DO NOTHING`;
      results.push({ ok: false, elementId: node.id, requestedRef, reason: 'unpublished' });
      continue;
    }
    const pin: AgentPin = {
      elementId: node.id,
      requestedRef,
      resolvedRef: resolved.pinnedRef,
      version: resolved.definition.version,
      floating: resolved.floating,
      // envelope de ator (D33): a resolução do pin é ato do RUNTIME (host), não do
      // agente — `system`. Gravado desde já, consultável, sem migração retroativa.
      actor: { type: 'system', id: 'runtime' },
    };
    // EVIDÊNCIA (append-only, D32): a versão efetiva aparece no history_events.
    await tx`INSERT INTO history_events
        (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
      VALUES (${tenantId}, ${instanceId}, ${historySeq(0, index)}, 'agent:pinResolved',
              ${tx.json(pin as never)}, ${engineVersion},
              ${`host:agent-pin:${instanceId}:${node.id}`})
      ON CONFLICT (effect_key) DO NOTHING`;
    // ESTADO OPERACIONAL (0008): a MESMA TX grava o pin na tabela dedicada que o
    // despacho do CreateJob(agent) lê — nunca a trilha. Imutável; idempotente.
    await tx`INSERT INTO instance_agent_pins
        (tenant_id, instance_id, element_id, declared_ref, effective_ref)
      VALUES (${tenantId}, ${instanceId}, ${node.id}, ${requestedRef}, ${resolved.pinnedRef})
      ON CONFLICT (tenant_id, instance_id, element_id) DO NOTHING`;
    results.push({ ok: true, pin });
    index += 1;
  }
  return results;
}

/** Pin operacional lido no despacho do CreateJob(agent) — a fonte de execução
 * (NUNCA a trilha). `null` quando não há pin para o (instância, elemento). */
export interface OperationalAgentPin {
  declaredRef: string;
  effectiveRef: string;
}

export async function getInstanceAgentPin(
  tx: TransactionSql,
  instanceId: string,
  elementId: string,
): Promise<OperationalAgentPin | null> {
  const [row] = await tx<{ declared_ref: string; effective_ref: string }[]>`
    SELECT declared_ref, effective_ref FROM instance_agent_pins
    WHERE instance_id = ${instanceId} AND element_id = ${elementId}`;
  return row ? { declaredRef: row.declared_ref, effectiveRef: row.effective_ref } : null;
}

/**
 * Catálogo latest-per-name (uma linha por `agent_id`, a maior versão semver).
 * Espelha `listStartableDefinitions`; a redução por semver é em JS (a lexical
 * do Postgres não serve para versões). Não-hot: UI de catálogo/deploy.
 */
export async function listAgentDefinitions(
  sql: Sql,
  tenantId: string,
): Promise<Omit<AgentDefinitionRow, 'graph'>[]> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<AgentDefinitionRow[]>`
      SELECT id, agent_id, version, ref, name, autonomy_level, created_at
      FROM agent_definitions
      ORDER BY agent_id, created_at`;
    const latestById = new Map<string, Omit<AgentDefinitionRow, 'graph'>>();
    for (const r of rows) {
      const prev = latestById.get(r.agent_id);
      if (!prev || compareSemver(r.version, prev.version) > 0) latestById.set(r.agent_id, r);
    }
    return [...latestById.values()];
  });
}
