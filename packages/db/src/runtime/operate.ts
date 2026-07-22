import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { insertAuditEvent } from './audit.js';

/**
 * Superfícies do Operate (shape §6b/§7): timers somente-leitura e o ciclo de
 * vida de incidentes (retry/resolution, auditados).
 */
export interface TimerListItem {
  id: string;
  instance_id: string;
  element_id: string;
  fire_at: string;
  status: string;
  created_at: string;
}

export async function listTimers(
  sql: Sql,
  tenantId: string,
  options: { cursor?: string; limit?: number; status?: string; instanceId?: string } = {},
): Promise<{ items: TimerListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor
    ? (() => {
        const raw = Buffer.from(options.cursor!, 'base64url').toString('utf8');
        const at = raw.lastIndexOf('|');
        return at > 0 ? { createdAt: raw.slice(0, at), id: raw.slice(at + 1) } : undefined;
      })()
    : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, instance_id, element_id, fire_at, status, created_at,
             created_at::text AS created_at_cursor
      FROM timers
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.instanceId ?? null}::uuid IS NULL OR instance_id = ${options.instanceId ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as TimerListItem[];
    const nextCursor =
      rows.length > limit
        ? Buffer.from(`${rows[limit - 1].created_at_cursor}|${rows[limit - 1].id}`).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}

export interface IncidentListItem {
  id: string;
  instance_id: string;
  kind: string;
  message: string;
  status: string;
  created_at: string;
}

export async function listIncidents(
  sql: Sql,
  tenantId: string,
  options: { cursor?: string; limit?: number; status?: string; kind?: string; instanceId?: string } = {},
): Promise<{ items: IncidentListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor
    ? (() => {
        const raw = Buffer.from(options.cursor!, 'base64url').toString('utf8');
        const at = raw.lastIndexOf('|');
        return at > 0 ? { createdAt: raw.slice(0, at), id: raw.slice(at + 1) } : undefined;
      })()
    : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, instance_id, kind, message, status, created_at,
             created_at::text AS created_at_cursor
      FROM incidents
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.kind ?? null}::text IS NULL OR kind = ${options.kind ?? null})
        AND (${options.instanceId ?? null}::uuid IS NULL OR instance_id = ${options.instanceId ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as IncidentListItem[];
    const nextCursor =
      rows.length > limit
        ? Buffer.from(`${rows[limit - 1].created_at_cursor}|${rows[limit - 1].id}`).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}

export type IncidentRetryOutcome =
  | { ok: true; rearmedJobs: number }
  | { ok: false; reason: 'notFound' | 'notOpen' | 'notRetryable'; message: string };

/**
 * POST /v1/incidents/{id}/retry (shape §7): re-tenta a CAUSA.
 * - Jobs FAILED da instância voltam a 'available' com retries restaurados.
 * - Efeito em dead-letter (effectDispatchFailed) NÃO é re-enfileirável na
 *   v1: a fila é efêmera e o efeito foi removido — re-enfileirar exigiria
 *   guardar o payload no incidente (migração nova = gate; registrado em
 *   pendencias.md). Resposta honesta: 409 apontando /resolution.
 */
export async function retryIncident(
  sql: Sql,
  tenantId: string,
  incidentId: string,
  actor: string,
): Promise<IncidentRetryOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [incident] = await tx`
      SELECT id, instance_id, kind, status FROM incidents
      WHERE id = ${incidentId} FOR UPDATE`;
    if (!incident) return { ok: false, reason: 'notFound', message: 'incidente não existe' };
    if (incident.status !== 'open') {
      return { ok: false, reason: 'notOpen', message: `incidente está '${String(incident.status)}'` };
    }
    const rearmed = await tx`
      UPDATE jobs SET status = 'available', retries_left = 3, error = NULL,
        lock_token = NULL, lock_until = NULL
      WHERE instance_id = ${incident.instance_id} AND status = 'failed'`;
    if (rearmed.count === 0) {
      return {
        ok: false,
        reason: 'notRetryable',
        message:
          incident.kind === 'effectDispatchFailed'
            ? 'efeito em dead-letter não é re-enfileirável na v1 (fila efêmera) — use /resolution; re-enfileiramento entra com a próxima migração'
            : 'nada re-tentável para este incidente (nenhum job failed na instância) — use /resolution',
      };
    }
    await tx`UPDATE incidents SET status = 'retried' WHERE id = ${incidentId}`;
    await insertAuditEvent(tx, tenantId, String(incident.instance_id), 'incidentRetried', {
      incidentId,
      kind: String(incident.kind),
      rearmedJobs: rearmed.count,
      actor,
    });
    return { ok: true, rearmedJobs: rearmed.count };
  });
}

export type IncidentResolveOutcome =
  | { ok: true }
  | { ok: false; reason: 'notFound' | 'alreadyResolved'; message: string };

/** POST /v1/incidents/{id}/resolution: resolve manualmente, com motivo. */
export async function resolveIncident(
  sql: Sql,
  tenantId: string,
  incidentId: string,
  input: { reason: string; actor: string },
): Promise<IncidentResolveOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [incident] = await tx`
      SELECT id, instance_id, kind, status FROM incidents
      WHERE id = ${incidentId} FOR UPDATE`;
    if (!incident) return { ok: false, reason: 'notFound', message: 'incidente não existe' };
    if (incident.status === 'resolved') {
      return { ok: false, reason: 'alreadyResolved', message: 'incidente já resolvido' };
    }
    await tx`UPDATE incidents SET status = 'resolved' WHERE id = ${incidentId}`;
    await insertAuditEvent(tx, tenantId, String(incident.instance_id), 'incidentResolved', {
      incidentId,
      kind: String(incident.kind),
      actor: input.actor,
      reason: input.reason,
    });
    return { ok: true };
  });
}
