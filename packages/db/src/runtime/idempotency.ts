import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';

/** Retenção das idempotency_keys (convenção §0 do shape): 24h. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/**
 * Limpeza das chaves expiradas de UM tenant (o worker varre os tenants no
 * loop, em cadência espaçada — a tabela é pequena por construção: chaves
 * vivem 24h e o índice idempotency_keys_age_idx serve o DELETE).
 */
export interface IdempotentHit {
  request_hash: string;
  status_code: number | null;
  response: unknown;
}

/** Busca uma chave (replay devolve a resposta original — convenção §0). */
export async function getIdempotentResponse(
  sql: Sql,
  tenantId: string,
  key: string,
): Promise<IdempotentHit | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<IdempotentHit[]>`
      SELECT request_hash, status_code, response
      FROM idempotency_keys WHERE key = ${key}`;
    return rows[0];
  });
}

/**
 * Grava a resposta de uma chave. ON CONFLICT DO NOTHING: numa corrida, a
 * PRIMEIRA gravação vence e o chamador re-lê (o replay é da vencedora).
 */
export async function putIdempotentResponse(
  sql: Sql,
  tenantId: string,
  key: string,
  requestHash: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response)
      VALUES (${tenantId}, ${key}, ${requestHash}, ${statusCode}, ${tx.json(response as never)})
      ON CONFLICT (tenant_id, key) DO NOTHING`;
  });
}

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
