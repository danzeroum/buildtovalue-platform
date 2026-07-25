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
import { recordTenantAuditEventTx, type AuditActor } from '../audit/tenantAudit.js';

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

/**
 * P5 (AG-3.4, shape `ag3-4-shape-proposta-p5-tools.md` §1.1/§1.2). D31 fica
 * ORTOGONAL a este toggle: `enabled` só responde "está disponível para o
 * tenant?" — nunca muda `effect`/`authorization`, que continuam vindo, ao
 * vivo, de `tool_definitions` (imutável).
 */

/** Ausência de linha em `tenant_tools` = desabilitada (honesto, não erro — §2.1). */
export async function isToolEnabledForTenantTx(
  tx: TransactionSql,
  tenantId: string,
  toolId: string,
): Promise<boolean> {
  const rows = await tx<{ enabled: boolean }[]>`
    SELECT enabled FROM tenant_tools WHERE tenant_id = ${tenantId} AND tool = ${toolId}`;
  return rows[0]?.enabled ?? false;
}

export interface TenantToolCatalogItem {
  toolId: string;
  ref: string;
  name: string;
  capability: string;
  effect: ToolEffect;
  authorization: ToolAuthorization;
  dataScope: string;
  /** De `tenant_tools`; sem linha ainda = false. */
  enabled: boolean;
  /** Computado de `authorization` — nunca de `tenant_tools.requires_gate` (vestigial, decisão 3 §4). */
  requiresGate: boolean;
}

interface CatalogRow {
  tool_id: string;
  ref: string;
  name: string;
  capability: string;
  effect: ToolEffect;
  authorization: ToolAuthorization;
  data_scope: string;
  enabled: boolean | null;
}

function toCatalogItem(row: CatalogRow): TenantToolCatalogItem {
  return {
    toolId: row.tool_id,
    ref: row.ref,
    name: row.name,
    capability: row.capability,
    effect: row.effect,
    authorization: row.authorization,
    dataScope: row.data_scope,
    enabled: row.enabled ?? false,
    requiresGate: row.authorization === 'gate',
  };
}

/**
 * Catálogo do tenant: última versão publicada de cada `tool_id` × estado de
 * habilitação. `ORDER BY created_at DESC` (não `version DESC`) — `version` é
 * semver STRING (ex. "10.0.0" < "9.0.0" lexicograficamente), então o padrão
 * `DISTINCT ON (name) ... ORDER BY version DESC` usado em `process_definitions`
 * (version INTEGER lá) seria incorreto aqui; `created_at` é monotônico
 * (tabela append-only).
 */
export async function listTenantToolsTx(
  tx: TransactionSql,
  tenantId: string,
): Promise<TenantToolCatalogItem[]> {
  const rows = await tx<CatalogRow[]>`
    SELECT DISTINCT ON (d.tool_id)
      d.tool_id, d.ref, d.name, d.capability, d.effect, d.authz AS authorization, d.data_scope,
      tt.enabled
    FROM tool_definitions d
    LEFT JOIN tenant_tools tt ON tt.tenant_id = d.tenant_id AND tt.tool = d.tool_id
    WHERE d.tenant_id = ${tenantId}
    ORDER BY d.tool_id, d.created_at DESC`;
  return rows.map(toCatalogItem);
}

export async function listTenantTools(sql: Sql, tenantId: string): Promise<TenantToolCatalogItem[]> {
  return withTenant(sql, tenantId, (tx) => listTenantToolsTx(tx, tenantId));
}

async function catalogItemByToolIdTx(
  tx: TransactionSql,
  tenantId: string,
  toolId: string,
): Promise<TenantToolCatalogItem | undefined> {
  const rows = await tx<CatalogRow[]>`
    SELECT d.tool_id, d.ref, d.name, d.capability, d.effect, d.authz AS authorization, d.data_scope,
           tt.enabled
    FROM tool_definitions d
    LEFT JOIN tenant_tools tt ON tt.tenant_id = d.tenant_id AND tt.tool = d.tool_id
    WHERE d.tenant_id = ${tenantId} AND d.tool_id = ${toolId}
    ORDER BY d.created_at DESC LIMIT 1`;
  return rows[0] ? toCatalogItem(rows[0]) : undefined;
}

export type SetTenantToolEnabledOutcome =
  | { ok: true; tool: TenantToolCatalogItem }
  | { ok: false; code: 'TOOL_NOT_FOUND' }
  | { ok: false; code: 'TOOL_FORBIDDEN' };

/**
 * `PATCH /v1/tools/:toolId` (§2.2). `proibida` nunca liga para tenant nenhum —
 * invariante da plataforma, não decisão de tenant (D31). Motivo obrigatório
 * nas duas direções (mesmo padrão do kill-switch), auditado em
 * `tenant_audit_events` (ação de tenant, sem instância — D33).
 */
export async function setTenantToolEnabledTx(
  tx: TransactionSql,
  tenantId: string,
  toolId: string,
  enabled: boolean,
  actor: AuditActor,
  motivo: string,
): Promise<SetTenantToolEnabledOutcome> {
  const current = await catalogItemByToolIdTx(tx, tenantId, toolId);
  if (!current) return { ok: false, code: 'TOOL_NOT_FOUND' };
  if (enabled && current.authorization === 'proibida') return { ok: false, code: 'TOOL_FORBIDDEN' };
  await tx`
    INSERT INTO tenant_tools (tenant_id, tool, enabled, updated_at)
    VALUES (${tenantId}, ${toolId}, ${enabled}, now())
    ON CONFLICT (tenant_id, tool) DO UPDATE SET enabled = ${enabled}, updated_at = now()`;
  await recordTenantAuditEventTx(tx, tenantId, actor, {
    eventType: 'tools.toggled',
    resourceType: 'tenant_tools',
    resourceId: toolId,
    motivo,
    payload: { toolId, ref: current.ref, enabled },
  });
  return { ok: true, tool: { ...current, enabled } };
}

export async function setTenantToolEnabled(
  sql: Sql,
  tenantId: string,
  toolId: string,
  enabled: boolean,
  actor: AuditActor,
  motivo: string,
): Promise<SetTenantToolEnabledOutcome> {
  return withTenant(sql, tenantId, (tx) => setTenantToolEnabledTx(tx, tenantId, toolId, enabled, actor, motivo));
}
