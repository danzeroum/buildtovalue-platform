import {
  validateGraph,
  parseRef,
  formatRef,
  AgentRefError,
  type AgentWorkflow,
  type ValidationIssue,
} from '@buildtovalue/agentflow';
import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

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
  // Pinado se `parseRef` aceita (tem `@version`); flutuante caso contrário.
  let pinned: { id: string; version: string } | null = null;
  try {
    pinned = parseRef(agentRef).ref;
  } catch (error) {
    if (!(error instanceof AgentRefError)) throw error;
  }

  return withTenant(sql, tenantId, async (tx) => {
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
  });
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
