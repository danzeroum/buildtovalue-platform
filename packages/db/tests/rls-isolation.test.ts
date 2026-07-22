import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * O TESTE PERMANENTE DE ISOLAMENTO DE TENANTS (D7, gate 8.4).
 * Roda contra o schema REAL (migração 0001) com o papel REAL da aplicação
 * (app_api, sem BYPASSRLS). Se qualquer mudança futura de schema ou policy
 * abrir vazamento entre tenants, este arquivo fica vermelho.
 */
describe('RLS — isolamento de tenants (migração 0001)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await createTestDatabase('rls_test');
    // Seed via papel de migração (FORCE RLS vale até para o dono: o seed de
    // users também precisa do contexto de tenant — exercita o withTenant).
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [a] = await migrator`
      INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    const [b] = await migrator`
      INSERT INTO tenants (slug, name) VALUES ('globex', 'Globex') RETURNING id`;
    tenantA = a.id as string;
    tenantB = b.id as string;
    await withTenant(migrator, tenantA, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenantA}, 'ana@acme.test', 'x', 'Ana', 'admin')`;
    });
    await withTenant(migrator, tenantB, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenantB}, 'bob@globex.test', 'x', 'Bob', 'operator')`;
    });
    await migrator.end();
    api = postgres(db.apiUrl, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('app_api NÃO tem BYPASSRLS (gate 8.4)', async () => {
    const [row] = await api`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_api'`;
    expect(row.rolbypassrls).toBe(false);
  });

  it('sem contexto de tenant, NENHUMA linha é visível (default = isolamento)', async () => {
    const rows = await api`SELECT id FROM users`;
    expect(rows.length).toBe(0);
  });

  it('com contexto do tenant A, só as linhas de A aparecem', async () => {
    const rows = await withTenant(api, tenantA, (tx) => tx`SELECT email FROM users`);
    expect(rows.map((r) => r.email)).toEqual(['ana@acme.test']);
  });

  it('tenant A não enxerga linhas de B nem por filtro explícito', async () => {
    const rows = await withTenant(
      api,
      tenantA,
      (tx) => tx`SELECT email FROM users WHERE tenant_id = ${tenantB}`,
    );
    expect(rows.length).toBe(0);
  });

  it('INSERT cross-tenant é rejeitado pelo WITH CHECK', async () => {
    await expect(
      withTenant(api, tenantA, (tx) =>
        tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
           VALUES (${tenantB}, 'intruso@globex.test', 'x', 'Intruso', 'admin')`,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('UPDATE não alcança linhas de outro tenant', async () => {
    const result = await withTenant(
      api,
      tenantA,
      (tx) => tx`UPDATE users SET display_name = 'hack' WHERE tenant_id = ${tenantB}`,
    );
    expect(result.count).toBe(0);
    const check = await withTenant(api, tenantB, (tx) => tx`SELECT display_name FROM users`);
    expect(check[0].display_name).toBe('Bob');
  });

  it('contexto SET LOCAL morre com a transação (sem vazamento entre requests)', async () => {
    await withTenant(api, tenantA, (tx) => tx`SELECT 1 AS ok`);
    const after = await api`SELECT id FROM users`;
    expect(after.length).toBe(0);
  });

  it('app_api não escreve em tenants (criação de tenant é administrativa)', async () => {
    await expect(api`INSERT INTO tenants (slug, name) VALUES ('evil', 'Evil')`).rejects.toThrow(
      /row-level security|permission denied/i,
    );
  });

  it('refresh_tokens segue o mesmo isolamento', async () => {
    const [user] = await withTenant(api, tenantA, (tx) => tx`SELECT id FROM users`);
    await withTenant(api, tenantA, (tx) =>
      tx`INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
         VALUES (${tenantA}, ${user.id}, 'h1', now() + interval '1 day')`,
    );
    const fromB = await withTenant(api, tenantB, (tx) => tx`SELECT id FROM refresh_tokens`);
    expect(fromB.length).toBe(0);
    const noContext = await api`SELECT id FROM refresh_tokens`;
    expect(noContext.length).toBe(0);
  });
});
