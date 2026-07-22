import type { Sql } from '../client.js';
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
  create(tenantId: string, userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findByHash(tenantId: string, tokenHash: string): Promise<RefreshTokenRow | undefined>;
  revoke(tenantId: string, id: string): Promise<void>;
}

export function createRefreshTokenRepository(sql: Sql): RefreshTokenRepository {
  return {
    async create(tenantId, userId, tokenHash, expiresAt) {
      await withTenant(sql, tenantId, async (tx) => {
        await tx`INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
          VALUES (${tenantId}, ${userId}, ${tokenHash}, ${expiresAt})`;
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
  };
}
