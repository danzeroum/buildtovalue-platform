import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { anchorTrailOnce, verifyAnchors } from '../src/audit/anchor.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Gate de MÁQUINA do caminho de PRODUÇÃO da ancoragem: o watermark REAL
 * (`pg_snapshot_xmin(pg_current_snapshot())`), sem injeção. Roda ISOLADO
 * (`test:serial`, config própria, depois do run principal) porque o snapshot é
 * global ao cluster — com outras suítes escrevendo em paralelo ele seria
 * não-determinístico. Aqui, sozinho, a marca cobre as linhas já commitadas.
 *
 * Auditoria de evidência: sem este teste, o caminho real era categoria (b)
 * — verificado uma vez no smoke. Com ele, é (a).
 */
describe('audit anchors — watermark REAL (serial, isolado)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let migrator: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('audit_anchor_real');
    migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'proc@1', '1.1.0', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = inst.id as string;
      for (let i = 0; i < 4; i++) {
        await tx`INSERT INTO history_events
            (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
          VALUES (${tenant}, ${instanceId}, ${700010 + i}, ${'k' + i},
                  ${tx.json({ actor: { type: 'user', id: 'ana' }, n: i })}, '1.1.0', ${'e' + i + ':' + instanceId})`;
      }
    });
    // fecha a conexão do migrador para não deixar transação/idle no snapshot
    await migrator.end();
    migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    api = postgres(db.apiUrl, { max: 2, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('watermark real (pg_snapshot_xmin) ancora as linhas commitadas', async () => {
    // sem `watermark` injetado → caminho de PRODUÇÃO. Isolado, o snapshot cobre
    // as 4 linhas já commitadas. Uma retentativa curta absorve qualquer xid
    // residual da criação do database.
    let res = await anchorTrailOnce(api, tenant, 'instance');
    for (let tries = 0; res.skipped === 'empty' && tries < 10; tries++) {
      await new Promise((r) => setTimeout(r, 200));
      res = await anchorTrailOnce(api, tenant, 'instance');
    }
    expect(res.anchorId, 'watermark real deveria ancorar as linhas commitadas').toBeDefined();
    expect(res.rowCount).toBe(4);
    expect(res.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const v = await verifyAnchors(api, tenant, 'instance');
    expect(v.ok).toBe(true);
    expect(v.anchorCount).toBe(1);
  });
});
