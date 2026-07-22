import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

export type UserRole = 'admin' | 'analyst' | 'business' | 'operator';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
}

/**
 * Repositório de usuários (DIP, G-COD-1): a API depende desta interface, não
 * do driver. Toda consulta tenant-scoped passa por `withTenant` (RLS).
 */
export interface UserRepository {
  findTenantBySlug(slug: string): Promise<TenantRow | undefined>;
  findByEmail(tenantId: string, email: string): Promise<UserRow | undefined>;
  findById(tenantId: string, id: string): Promise<UserRow | undefined>;
}

export function createUserRepository(sql: Sql): UserRepository {
  return {
    async findTenantBySlug(slug) {
      const rows = await sql<TenantRow[]>`
        SELECT id, slug, name FROM tenants WHERE slug = ${slug}`;
      return rows[0];
    },
    async findByEmail(tenantId, email) {
      return withTenant(sql, tenantId, async (tx: TransactionSql) => {
        const rows = await tx<UserRow[]>`
          SELECT id, tenant_id, email, password_hash, display_name, role
          FROM users WHERE lower(email) = lower(${email})`;
        return rows[0];
      });
    },
    async findById(tenantId, id) {
      return withTenant(sql, tenantId, async (tx: TransactionSql) => {
        const rows = await tx<UserRow[]>`
          SELECT id, tenant_id, email, password_hash, display_name, role
          FROM users WHERE id = ${id}`;
        return rows[0];
      });
    },
  };
}
