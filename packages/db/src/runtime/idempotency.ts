import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

/** Retenção das idempotency_keys (convenção §0 do shape): 24h. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/**
 * Limpeza das chaves expiradas de UM tenant (o worker varre os tenants no
 * loop, em cadência espaçada — a tabela é pequena por construção: chaves
 * vivem 24h e o índice idempotency_keys_age_idx serve o DELETE).
 */
export async function sweepIdempotencyKeys(
  sql: Sql,
  tenantId: string,
): Promise<{ deleted: number }> {
  return withTenant(sql, tenantId, async (tx) => {
    const result = await tx`
      DELETE FROM idempotency_keys
      WHERE created_at < now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})`;
    return { deleted: result.count };
  });
}
