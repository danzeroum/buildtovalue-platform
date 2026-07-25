import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

export type UserRole = 'admin' | 'analyst' | 'business' | 'operator' | 'auditor';

/** Mesmo conjunto do CHECK de `users.date_format` (migração 0021). */
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  active: boolean;
  must_change_password: boolean;
  timezone: string;
  date_format: DateFormat;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
}

/** Estado mínimo consultado A CADA request autenticado (AG-3.5, `app.authenticate`) —
 *  SELECT por PK, sem join, o mais barato possível. */
export interface UserAuthState {
  active: boolean;
  mustChangePassword: boolean;
}

/**
 * Repositório de usuários (DIP, G-COD-1): a API depende desta interface, não
 * do driver. Toda consulta tenant-scoped passa por `withTenant` (RLS).
 */
export interface UserRepository {
  findTenantBySlug(slug: string): Promise<TenantRow | undefined>;
  findByEmail(tenantId: string, email: string): Promise<UserRow | undefined>;
  findById(tenantId: string, id: string): Promise<UserRow | undefined>;
  /** Consultada a CADA request autenticado — mantida separada de `findById` (que traz
   *  mais colunas) para o custo por request ficar o menor possível (AG-3.5 §1.1). */
  getAuthState(tenantId: string, id: string): Promise<UserAuthState | undefined>;
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
          SELECT id, tenant_id, email, password_hash, display_name, role,
                 active, must_change_password, timezone, date_format
          FROM users WHERE lower(email) = lower(${email})`;
        return rows[0];
      });
    },
    async findById(tenantId, id) {
      return withTenant(sql, tenantId, async (tx: TransactionSql) => {
        const rows = await tx<UserRow[]>`
          SELECT id, tenant_id, email, password_hash, display_name, role,
                 active, must_change_password, timezone, date_format
          FROM users WHERE id = ${id}`;
        return rows[0];
      });
    },
    async getAuthState(tenantId, id) {
      return withTenant(sql, tenantId, async (tx: TransactionSql) => {
        const rows = await tx<{ active: boolean; must_change_password: boolean }[]>`
          SELECT active, must_change_password FROM users WHERE id = ${id}`;
        return rows[0] ? { active: rows[0].active, mustChangePassword: rows[0].must_change_password } : undefined;
      });
    },
  };
}
