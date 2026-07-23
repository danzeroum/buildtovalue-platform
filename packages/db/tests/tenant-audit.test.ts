import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { recordTenantAuditEvent } from '../src/audit/tenantAudit.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Trilha de auditoria de tenant (D33): envelope de ator CONSULTÁVEL, isolamento
 * por tenant (RLS), e append-only por permissão (o teste de UPDATE/DELETE
 * negado vive em rls-isolation; aqui provamos a semântica de negócio).
 */
describe('tenant_audit_events (D33)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await createTestDatabase('tenant_audit');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [a] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    const [b] = await migrator`INSERT INTO tenants (slug, name) VALUES ('globex', 'Globex') RETURNING id`;
    tenantA = a.id as string;
    tenantB = b.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('grava com envelope de ator consultável e é isolado por tenant', async () => {
    await recordTenantAuditEvent(
      api,
      tenantA,
      { type: 'user', id: 'ana', requestId: 'req-1' },
      {
        eventType: 'config.ai.updated',
        resourceType: 'ai_config',
        resourceId: tenantA,
        motivo: 'trocou o provider do tenant',
        payload: { provider: 'anthropic' },
      },
    );

    // o auditor filtra por ATOR e event_type direto nas colunas (não em payload)
    const rows = await withTenant(
      api,
      tenantA,
      (tx) => tx`SELECT actor_type, actor_id, request_id, event_type, resource_type, resource_id, motivo
                 FROM tenant_audit_events WHERE event_type = 'config.ai.updated' AND actor_id = 'ana'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: 'user',
      actor_id: 'ana',
      request_id: 'req-1',
      event_type: 'config.ai.updated',
      resource_type: 'ai_config',
    });

    // RLS: o tenant B não enxerga o evento de A
    const fromB = await withTenant(api, tenantB, (tx) => tx`SELECT id FROM tenant_audit_events`);
    expect(fromB.length).toBe(0);
    // sem contexto de tenant: nada
    const noCtx = await api`SELECT id FROM tenant_audit_events`;
    expect(noCtx.length).toBe(0);
  });

  it('actor system/agent também são aceitos (envelope D33)', async () => {
    await recordTenantAuditEvent(
      api,
      tenantB,
      { type: 'system', id: 'digest-job' },
      { eventType: 'audit.integrity.verified', resourceType: 'audit_interval' },
    );
    const rows = await withTenant(
      api,
      tenantB,
      (tx) => tx`SELECT actor_type FROM tenant_audit_events WHERE event_type = 'audit.integrity.verified'`,
    );
    expect(rows[0]?.actor_type).toBe('system');
  });
});
