import { randomUUID } from 'node:crypto';
import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

export interface JobRow {
  id: string;
  instance_id: string;
  wait_key: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'available' | 'locked' | 'completed' | 'failed' | 'paused';
  lock_token: string | null;
  retries_left: number;
}

/**
 * Contrato de jobs (D4r/D12): lock com LEASE + lock_token de fencing.
 * Lease expirado devolve o job à fila (a query de lock re-toma locked
 * vencidos). complete/fail SÓ com o token vigente — token velho = conflito
 * (409 na API). Handlers rodam FORA de transação (D22) e concluem via
 * POST /v1/jobs/{id}/complete.
 */
export async function lockJobs(
  sql: Sql,
  tenantId: string,
  workerId: string,
  options: { limit?: number; leaseMs?: number; types?: string[] } = {},
): Promise<JobRow[]> {
  const leaseMs = options.leaseMs ?? 30_000;
  return withTenant(sql, tenantId, async (tx) => {
    const token = randomUUID();
    return await tx<JobRow[]>`
      UPDATE jobs SET
        status = 'locked',
        locked_by = ${workerId},
        lock_token = ${token},
        lock_until = now() + make_interval(secs => ${leaseMs / 1000})
      WHERE id IN (
        SELECT id FROM jobs
        WHERE (status = 'available'
           OR (status = 'locked' AND lock_until < now()))
          AND (${options.types ?? null}::text[] IS NULL OR type = ANY(${options.types ?? null}))
          -- kill-switch (D29/5.2): com o agente pausado, novos jobs do tipo
          -- agent NAO lockam; os demais tipos (e gates humanos) seguem. A RLS
          -- de tenant_ai_config ja restringe ao tenant corrente.
          AND NOT (type = 'agent' AND EXISTS (
            SELECT 1 FROM tenant_ai_config c
            WHERE c.tenant_id = ${tenantId} AND c.kill_switch = true))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${options.limit ?? 5}
      )
      RETURNING id, instance_id, wait_key, type, payload, status, lock_token, retries_left`;
  });
}

export interface JobListItem {
  id: string;
  instance_id: string;
  type: string;
  status: string;
  retries_left: number;
  error: string | null;
  created_at: string;
  /** §5.2: discrimina a parada honesta (budget/kill-switch) — null se não pausado.
   *  O Operate pinta a voz âmbar certa (parada honesta ≠ incidente vermelho). */
  pause_kind: string | null;
}

/** GET /v1/jobs (shape §5): cursor + filtros status/type/instanceId. */
export async function listJobs(
  sql: Sql,
  tenantId: string,
  options: {
    cursor?: string;
    limit?: number;
    status?: string;
    type?: string;
    instanceId?: string;
  } = {},
): Promise<{ items: JobListItem[]; nextCursor: string | null }> {
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
      SELECT id, instance_id, type, status, retries_left, error, created_at, pause_kind,
             created_at::text AS created_at_cursor
      FROM jobs
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.type ?? null}::text IS NULL OR type = ${options.type ?? null})
        AND (${options.instanceId ?? null}::uuid IS NULL OR instance_id = ${options.instanceId ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as JobListItem[];
    const nextCursor =
      rows.length > limit
        ? Buffer.from(`${rows[limit - 1].created_at_cursor}|${rows[limit - 1].id}`).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}

export type JobConclusion =
  | { ok: true; job: JobRow }
  | { ok: false; reason: 'notFound' | 'staleToken' | 'notLocked' };

/** Conclui um job APENAS com o lock_token vigente (fencing, D12). */
export async function completeJob(
  sql: Sql,
  tenantId: string,
  jobId: string,
  lockToken: string,
): Promise<JobConclusion> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<JobRow[]>`
      UPDATE jobs SET status = 'completed', lock_token = NULL, lock_until = NULL
      WHERE id = ${jobId} AND status = 'locked'
        AND lock_token = ${lockToken} AND lock_until >= now()
      RETURNING id, instance_id, wait_key, type, payload, status, lock_token, retries_left`;
    if (rows.length === 1) return { ok: true, job: rows[0] };
    const [existing] = await tx`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (!existing) return { ok: false, reason: 'notFound' };
    return { ok: false, reason: existing.status === 'locked' ? 'staleToken' : 'notLocked' };
  });
}

/** Falha com o token vigente: devolve à fila (retries) ou marca failed. */
/**
 * PARADA HONESTA (ADENDO-02 §5): estaciona o job de agente ('paused') sem
 * consumir retry nem abrir incidente — o contrário de `failJob`. Mesmo fencing
 * (lock_token vigente). O job sai da fila; a retomada é ação explícita (a fila só
 * pega 'available'). `error` carrega a voz da parada (budget/kill-switch) para a
 * coluna `error`, sem virar falha.
 */
export async function pauseJob(
  sql: Sql,
  tenantId: string,
  jobId: string,
  lockToken: string,
  reason: string,
  pauseKind: string,
): Promise<JobConclusion> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<JobRow[]>`
      UPDATE jobs SET status = 'paused', error = ${reason}, pause_kind = ${pauseKind},
                      lock_token = NULL, lock_until = NULL
      WHERE id = ${jobId} AND status = 'locked'
        AND lock_token = ${lockToken} AND lock_until >= now()
      RETURNING id, instance_id, wait_key, type, payload, status, lock_token, retries_left`;
    if (rows.length === 1) return { ok: true, job: rows[0] };
    const [existing] = await tx`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (!existing) return { ok: false, reason: 'notFound' };
    return { ok: false, reason: existing.status === 'locked' ? 'staleToken' : 'notLocked' };
  });
}

export async function failJob(
  sql: Sql,
  tenantId: string,
  jobId: string,
  lockToken: string,
  error: string,
): Promise<JobConclusion> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<JobRow[]>`
      UPDATE jobs SET
        status = CASE WHEN retries_left > 0 THEN 'available' ELSE 'failed' END,
        retries_left = greatest(retries_left - 1, 0),
        error = ${error},
        lock_token = NULL,
        lock_until = NULL
      WHERE id = ${jobId} AND status = 'locked'
        AND lock_token = ${lockToken} AND lock_until >= now()
      RETURNING id, instance_id, wait_key, type, payload, status, lock_token, retries_left`;
    if (rows.length === 1) return { ok: true, job: rows[0] };
    const [existing] = await tx`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (!existing) return { ok: false, reason: 'notFound' };
    return { ok: false, reason: existing.status === 'locked' ? 'staleToken' : 'notLocked' };
  });
}
