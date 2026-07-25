import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

export interface RefreshTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/** Persistência dos refresh tokens (só o HASH — nunca o valor cru). */
export interface RefreshTokenRepository {
  /** Devolve o `id` da linha criada — vira o claim `sid` do access token (AG-3.5). */
  create(tenantId: string, userId: string, tokenHash: string, expiresAt: Date): Promise<string>;
  findByHash(tenantId: string, tokenHash: string): Promise<RefreshTokenRow | undefined>;
  revoke(tenantId: string, id: string): Promise<void>;
  /** Revoga TODOS os refresh tokens ativos do usuário — `exceptId` preserva UMA sessão
   *  (AG-3.5: "trocar senha encerra as outras", `exceptId` = `sid` do request atual). */
  revokeAllForUser(tenantId: string, userId: string, exceptId?: string): Promise<void>;
}

/** Variante tx-scoped — consumida por `admin/members.ts` para compor a revogação na
 *  MESMA transação da desativação/reset/troca de senha (atomicidade — AG-3.5). */
export async function revokeAllForUserTx(
  tx: TransactionSql,
  userId: string,
  exceptId?: string,
): Promise<void> {
  if (exceptId) {
    await tx`UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL AND id != ${exceptId}`;
  } else {
    await tx`UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL`;
  }
}

export function createRefreshTokenRepository(sql: Sql): RefreshTokenRepository {
  return {
    async create(tenantId, userId, tokenHash, expiresAt) {
      return withTenant(sql, tenantId, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
          VALUES (${tenantId}, ${userId}, ${tokenHash}, ${expiresAt})
          RETURNING id`;
        return row.id;
      });
    },
    async findByHash(tenantId, tokenHash) {
      return withTenant(sql, tenantId, async (tx) => {
        const rows = await tx<RefreshTokenRow[]>`
          SELECT id, tenant_id, user_id, token_hash, expires_at, revoked_at
          FROM refresh_tokens WHERE token_hash = ${tokenHash}`;
        return rows[0];
      });
    },
    async revoke(tenantId, id) {
      await withTenant(sql, tenantId, async (tx) => {
        await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${id}`;
      });
    },
    async revokeAllForUser(tenantId, userId, exceptId) {
      await withTenant(sql, tenantId, (tx) => revokeAllForUserTx(tx, userId, exceptId));
    },
  };
}
