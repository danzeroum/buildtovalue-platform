import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { recordTenantAuditEvent } from '../src/audit/tenantAudit.js';
import { anchorLag, anchorTrailOnce, verifyAnchors } from '../src/audit/anchor.js';
import { exportAudit, type NormalizedActor } from '../src/audit/export.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Ancoragem periódica de digest (AG-2.4, D35) — o aceite nomeado (ADENDO-03 §3):
 * digest de intervalo ancorado; adulteração simulada de UMA linha → a verificação
 * falha APONTANDO o intervalo. Mais: a âncora carrega os DOIS sistemas de
 * coordenadas (xid + tempo), a fronteira `xid < watermark` é exclusiva, e o recibo
 * do export DECLARA a cobertura ancorada.
 *
 * DETERMINISMO: `pg_snapshot_xmin(pg_current_snapshot())` é GLOBAL ao cluster —
 * suítes paralelas (migrações em voo) o tornam não-determinístico. Estes testes
 * INJETAM a marca d'água (uma `pg_current_xact_id()` fresca, sempre acima das
 * linhas já commitadas) para exercitar a LÓGICA de âncora/verify/cobertura sem
 * corrida. A produção nunca injeta — usa sempre o snapshot real (o job do worker).
 */
describe('audit anchors (D35)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let migrator: postgres.Sql;
  let tenant: string;
  let instanceId: string;
  const gen: NormalizedActor = { type: 'user', id: 'auditor@acme', requestId: 'rq' };

  /** xid8 fresco (> qualquer linha já commitada) — marca d'água determinística. */
  async function freshWatermark(): Promise<string> {
    const [{ x }] = await api<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`;
    return x;
  }

  beforeAll(async () => {
    db = await createTestDatabase('audit_anchor');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'proc@1', '1.1.0', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = inst.id as string;
      for (let i = 0; i < 3; i++) {
        await tx`INSERT INTO history_events
            (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
          VALUES (${tenant}, ${instanceId}, ${700010 + i}, ${'kind' + i},
                  ${tx.json({ actor: { type: 'user', id: 'ana' }, n: i })}, '1.1.0', ${'k' + i + ':' + instanceId})`;
      }
    });
    api = postgres(db.apiUrl, { max: 3, onnotice: () => {} });
    await recordTenantAuditEvent(api, tenant, { type: 'user', id: 'ana', requestId: 'r1' }, {
      eventType: 'config.ai.updated',
      resourceType: 'ai_config',
      resourceId: tenant,
    });
    await recordTenantAuditEvent(api, tenant, { type: 'system', id: 'ks' }, {
      eventType: 'agent.killswitch.toggled',
      resourceType: 'ai_config',
      resourceId: tenant,
    });
  }, 60_000);

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('ancora ambas as trilhas; a âncora carrega xid E tempo (dois sistemas)', async () => {
    const wm = await freshWatermark();
    const t = await anchorTrailOnce(api, tenant, 'tenant', { watermark: wm });
    const i = await anchorTrailOnce(api, tenant, 'instance', { watermark: wm });
    expect(t.anchorId).toBeDefined();
    expect(t.rowCount).toBe(2);
    expect(i.rowCount).toBe(3);
    expect(t.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const [row] = await withTenant(api, tenant, (tx) =>
      tx`SELECT from_xid::text, to_xid::text, min_created_at, max_created_at, row_count, prev_anchor_digest
         FROM audit_anchors WHERE trail = 'instance'`);
    expect(row.min_created_at).not.toBeNull();
    expect(row.max_created_at).not.toBeNull();
    expect(row.from_xid).toBeDefined();
    expect(row.to_xid).toBeDefined();
    expect(row.prev_anchor_digest).toBeNull(); // primeira âncora da trilha
  });

  it('verify OK logo após ancorar (nada adulterado)', async () => {
    const v = await verifyAnchors(api, tenant, 'instance');
    expect(v.ok).toBe(true);
    expect(v.mismatches).toEqual([]);
    expect(v.anchorCount).toBe(1);
  });

  it('auto-referência: o evento audit.anchor.created cai FORA do intervalo que ancora', async () => {
    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT e.xid::text AS ev_xid, a.to_xid::text AS wm
         FROM tenant_audit_events e
         JOIN audit_anchors a ON a.trail = 'tenant'
         WHERE e.event_type = 'audit.anchor.created'
         ORDER BY e.id DESC LIMIT 1`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(BigInt(rows[0].ev_xid) >= BigInt(rows[0].wm)).toBe(true);
  });

  it('ADULTERAÇÃO de uma linha → verify FALHA apontando o intervalo', async () => {
    // um atacante com escrita no banco altera o payload de UMA linha já ancorada
    // (append-only barra o app_api; o migrador/owner simula o adversário privilegiado).
    await withTenant(migrator, tenant, (tx) =>
      tx`UPDATE history_events SET payload = ${tx.json({ actor: { type: 'user', id: 'MALLORY' } })}
         WHERE instance_id = ${instanceId} AND seq = 700011`);
    const v = await verifyAnchors(api, tenant, 'instance');
    expect(v.ok).toBe(false);
    expect(v.mismatches.length).toBeGreaterThanOrEqual(1);
    const m = v.mismatches[0];
    expect(m.reason).toBe('digest');
    // aponta o intervalo: from_xid/to_xid + limites de tempo
    expect(m.fromXid).toBeDefined();
    expect(m.toXid).toBeDefined();
    expect(m.minCreatedAt).not.toBeNull();
  });

  it('fronteira `xid < watermark` é EXCLUSIVA: linha nova fica FORA, e ancora na cadeia', async () => {
    // insere uma linha nova e captura o xid DELA
    await recordTenantAuditEvent(api, tenant, { type: 'user', id: 'nova' }, {
      eventType: 'config.ai.updated',
      resourceType: 'ai_config',
      resourceId: tenant,
    });
    const [{ nx }] = await withTenant(api, tenant, (tx) =>
      tx<{ nx: string }[]>`SELECT xid::text AS nx FROM tenant_audit_events
        WHERE actor_id = 'nova' ORDER BY id DESC LIMIT 1`);

    // se a linha nova está coberta por ALGUMA âncora (from_xid <= nx < to_xid)?
    const coveredCount = async (): Promise<number> => {
      const [{ c }] = await withTenant(api, tenant, (tx) =>
        tx<{ c: number }[]>`SELECT count(*)::int AS c FROM audit_anchors
          WHERE trail = 'tenant' AND ${nx}::xid8 >= from_xid AND ${nx}::xid8 < to_xid`);
      return c;
    };

    // ancorar com watermark = xid da linha nova → ela é EXCLUÍDA (xid == watermark, não <)
    await anchorTrailOnce(api, tenant, 'tenant', { watermark: nx });
    expect(await coveredCount()).toBe(0);
    expect((await anchorLag(api, tenant, 'tenant')).unanchoredRows).toBeGreaterThanOrEqual(1);

    // com watermark > nx a linha entra, na cadeia (prev != null)
    const t2 = await anchorTrailOnce(api, tenant, 'tenant', { watermark: await freshWatermark() });
    expect(t2.anchorId).toBeDefined();
    expect(await coveredCount()).toBe(1);
    const [second] = await withTenant(api, tenant, (tx) =>
      tx`SELECT prev_anchor_digest FROM audit_anchors WHERE trail='tenant' ORDER BY to_xid DESC LIMIT 1`);
    expect(second.prev_anchor_digest).not.toBeNull(); // cadeia de âncoras
    expect((await verifyAnchors(api, tenant, 'tenant')).ok).toBe(true);
  });

  it('recibo do export DECLARA a fronteira ancorada (cobertura, não inferência)', async () => {
    const { receipt } = await exportAudit(api, tenant, { source: 'tenant' }, gen, new Date().toISOString());
    expect(receipt.coverage).toBeDefined();
    expect(receipt.coverage.perTrail.tenant.throughXid).not.toBeNull();
    expect(receipt.coverage.unanchoredCount).toBeGreaterThanOrEqual(0);
    expect(typeof receipt.coverage.note).toBe('string');
  });
});
