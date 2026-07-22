import { randomUUID } from 'node:crypto';
import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

export interface JobRow {
  id: string;
  instance_id: string;
  wait_key: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'available' | 'locked' | 'completed' | 'failed';
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
  options: { limit?: number; leaseMs?: number } = {},
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
        WHERE status = 'available'
           OR (status = 'locked' AND lock_until < now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${options.limit ?? 5}
      )
      RETURNING id, instance_id, wait_key, type, payload, status, lock_token, retries_left`;
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
