import {
  effectRequiresGate,
  parseRef,
  formatRef,
  isToolRef,
  type ToolContract,
  type ToolEffect,
  type ToolAuthorization,
} from '@buildtovalue/agentflow';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

/**
 * Registry de TOOL CONTRACTS (AG-2.2 etapa 5, D31). Espelha o de agentes: deploy
 * IMUTÁVEL, `ref` (`tool:x@1.0.0`) como identidade. O contrato declara `effect` +
 * `authorization` (campo próprio, nunca inferido). O GATE de deploy trava a
 * coerência: um efeito que EXIGE gate (`write-irreversible`/`external-commitment`)
 * não pode declarar `authorization: 'automatica'` — seria irreversível automático,
 * o que o D31 proíbe.
 */
export interface ToolDefinitionRow {
  id: string;
  tool_id: string;
  version: string;
  ref: string;
  name: string;
  capability: string;
  effect: ToolEffect;
  authorization: ToolAuthorization;
  data_scope: string;
  contract: ToolContract;
  created_at: string;
}

export interface ToolContractIssue {
  code: 'TOOL_REF_INVALID' | 'TOOL_EFFECT_AUTOMATICA_GATED' | 'TOOL_KIND';
  message: string;
}

export type DeployToolOutcome =
  | { ok: true; tool: ToolDefinitionRow }
  | { ok: false; issues: ToolContractIssue[] };

/** Valida a coerência do contrato (o GATE de deploy). Puro. */
export function validateToolContract(contract: ToolContract): ToolContractIssue[] {
  const issues: ToolContractIssue[] = [];
  if (contract.kind !== 'ToolContract') {
    issues.push({ code: 'TOOL_KIND', message: `kind '${String(contract.kind)}' não é 'ToolContract'` });
  }
  const ref = `${contract.id}@${contract.version}`;
  if (!isToolRef(ref)) {
    issues.push({ code: 'TOOL_REF_INVALID', message: `ref '${ref}' não é um tool ref válido (tool:*@semver)` });
  }
  // D31: efeito com gate NÃO pode ser automático.
  if (effectRequiresGate(contract.effect) && contract.authorization === 'automatica') {
    issues.push({
      code: 'TOOL_EFFECT_AUTOMATICA_GATED',
      message: `efeito '${contract.effect}' exige gate humano — 'authorization: automatica' é proibido (D31); use 'gate' ou 'proibida'`,
    });
  }
  return issues;
}

export async function deployToolDefinition(
  sql: Sql,
  tenantId: string,
  input: { contract: ToolContract; createdBy?: string },
): Promise<DeployToolOutcome> {
  const issues = validateToolContract(input.contract);
  if (issues.length > 0) return { ok: false, issues };
  const c = input.contract;
  const ref = formatRef({ id: c.id, version: c.version });
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx<ToolDefinitionRow[]>`
      INSERT INTO tool_definitions
        (tenant_id, tool_id, version, ref, name, capability, effect, authz, data_scope, contract, created_by)
      VALUES (${tenantId}, ${c.id}, ${c.version}, ${ref}, ${c.name}, ${c.capability},
              ${c.effect}, ${c.authorization}, ${c.dataScope}, ${tx.json(c as never)}, ${input.createdBy ?? null})
      RETURNING id, tool_id, version, ref, name, capability, effect, authz AS authorization, data_scope, contract, created_at`;
    return { ok: true, tool: row };
  });
}

export async function getToolDefinitionByRef(
  sql: Sql,
  tenantId: string,
  ref: string,
): Promise<ToolDefinitionRow | undefined> {
  return withTenant(sql, tenantId, (tx) => getToolDefinitionByRefTx(tx, ref));
}

/** Variante tx-scoped — consumida pelo lint de deploy (mesma tx do deploy). */
export async function getToolDefinitionByRefTx(
  tx: TransactionSql,
  ref: string,
): Promise<ToolDefinitionRow | undefined> {
  const rows = await tx<ToolDefinitionRow[]>`
    SELECT id, tool_id, version, ref, name, capability, effect, authz AS authorization, data_scope, contract, created_at
    FROM tool_definitions WHERE ref = ${ref}`;
  return rows[0];
}

/** Resolve o efeito de um tool ref (para o lint do gate). `null` se não publicado. */
export async function toolEffectOfTx(
  tx: TransactionSql,
  ref: string,
): Promise<ToolEffect | null> {
  let normalized = ref;
  try {
    normalized = formatRef(parseRef(ref).ref);
  } catch {
    return null;
  }
  const tool = await getToolDefinitionByRefTx(tx, normalized);
  return tool ? tool.effect : null;
}
