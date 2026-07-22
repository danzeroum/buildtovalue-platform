import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

/** Fotografia das filas do runtime por tenant — métricas 9.2. */
export interface RuntimeDepths {
  outboxPending: number;
  jobsAvailable: number;
  /** Timers vencidos há mais de `lateAfterMs` e ainda armados (alerta 9.2). */
  timersLate: number;
  incidentsOpen: number;
}

export async function runtimeDepths(
  sql: Sql,
  tenantId: string,
  options: { now?: () => string; lateAfterMs?: number } = {},
): Promise<RuntimeDepths> {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const lateAfterMs = options.lateAfterMs ?? 60_000;
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`SELECT
      (SELECT count(*) FROM outbox WHERE status = 'pending')::int AS outbox_pending,
      (SELECT count(*) FROM jobs WHERE status = 'available')::int AS jobs_available,
      (SELECT count(*) FROM timers WHERE status = 'armed'
         AND fire_at <= ${now}::timestamptz - make_interval(secs => ${lateAfterMs / 1000}))::int AS timers_late,
      (SELECT count(*) FROM incidents WHERE status = 'open')::int AS incidents_open`;
    return {
      outboxPending: row.outbox_pending as number,
      jobsAvailable: row.jobs_available as number,
      timersLate: row.timers_late as number,
      incidentsOpen: row.incidents_open as number,
    };
  });
}
