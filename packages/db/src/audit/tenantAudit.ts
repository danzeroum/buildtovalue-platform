import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

/**
 * Trilha de auditoria de TENANT (ADENDO-03 D33) — eventos de governança SEM
 * instância (a history_events é ancorada em instância). Append-only por
 * PERMISSÃO de banco (migração 0006: app_api só SELECT+INSERT). O envelope de
 * ATOR é campo de 1ª classe CONSULTÁVEL (nunca enterrado em payload), para o
 * auditor filtrar por quem fez o quê. `event_type`/`resource_type`/
 * `resource_id` são estáveis (catálogo no contrato); `anchor_ref` recebe a
 * referência de ancoragem quando o job de digest (D35) rodar.
 */
export type ActorType = 'user' | 'system' | 'agent';

export interface AuditActor {
  type: ActorType;
  id: string;
  requestId?: string;
}

export interface TenantAuditInput {
  eventType: string;
  resourceType: string;
  resourceId?: string;
  motivo?: string;
  payload?: Record<string, unknown>;
  anchorRef?: string;
}

/** Grava dentro de uma tx JÁ no contexto do tenant (atômico com a ação). */
export async function recordTenantAuditEventTx(
  tx: TransactionSql,
  tenantId: string,
  actor: AuditActor,
  input: TenantAuditInput,
): Promise<void> {
  await tx`
    INSERT INTO tenant_audit_events
      (tenant_id, actor_type, actor_id, request_id,
       event_type, resource_type, resource_id, motivo, payload, anchor_ref)
    VALUES (${tenantId}, ${actor.type}, ${actor.id}, ${actor.requestId ?? null},
            ${input.eventType}, ${input.resourceType}, ${input.resourceId ?? null},
            ${input.motivo ?? null}, ${tx.json((input.payload ?? {}) as never)},
            ${input.anchorRef ?? null})`;
}

/** Grava avulso (abre a própria tx com o contexto de tenant). */
export async function recordTenantAuditEvent(
  sql: Sql,
  tenantId: string,
  actor: AuditActor,
  input: TenantAuditInput,
): Promise<void> {
  await withTenant(sql, tenantId, (tx) => recordTenantAuditEventTx(tx, tenantId, actor, input));
}
