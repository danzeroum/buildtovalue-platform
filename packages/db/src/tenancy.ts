import type { Sql, TransactionSql } from './client.js';

/**
 * Executa `fn` numa transação com o contexto de tenant setado via
 * `SET LOCAL app.tenant_id` (set_config com is_local=true) — o mecanismo que
 * as policies de RLS da migração 0001 consomem (D7). Fora de `withTenant`,
 * NENHUMA linha tenant-scoped é visível: o default é o isolamento.
 *
 * SET LOCAL morre com a transação: não há vazamento de contexto entre
 * requisições mesmo com pool de conexões.
 */
export async function withTenant<T>(
  sql: Sql,
  tenantId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  })) as T;
}
