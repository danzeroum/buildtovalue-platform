import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { dispatchOutboxOnce, insertEffects } from '../src/runtime/outbox.js';
import { effectKey } from '../src/runtime/effectKey.js';
import { retryIncident } from '../src/runtime/operate.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Dead-letter re-enfileirável (D22, AG-2.1) — fecha a ERRATA §7. O efeito que
 * esgota tentativas vira incidente COM o payload do efeito guardado (migração
 * 0006); o /retry o devolve à outbox em vez de responder 409.
 */
describe('dead-letter re-enfileirável (D22)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;
  let instance: string;

  beforeAll(async () => {
    db = await createTestDatabase('dead_letter');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    tenant = t.id as string;
    instance = await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return inst.id as string;
    });
    await migrator.end();
    api = postgres(db.apiUrl, { max: 3, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('efeito esgotado vira incidente COM payload; retry re-enfileira na outbox', async () => {
    // efeito que FALHA em applyEffect: OpenUserTask sem elementId → element_id
    // é NOT NULL → viola constraint → esgota tentativas → dead-letter.
    const dlKey = effectKey(instance, 3, 0, 'OpenUserTask');
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        { effectKey: dlKey, effect: { type: 'OpenUserTask', waitKey: 'dl-task', formRef: 'x' } as never },
      ]),
    );
    const res = await dispatchOutboxOnce(api, tenant, { maxAttempts: 1 });
    expect(res.deadLettered).toBe(1);

    // incidente carrega o payload do efeito (migração 0006)
    const [inc] = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT id, payload FROM incidents WHERE kind = 'effectDispatchFailed'`,
    );
    expect((inc.payload as { effectKey?: string }).effectKey).toBe(dlKey);
    expect((inc.payload as { effect?: { type?: string } }).effect?.type).toBe('OpenUserTask');

    // 4) retry RE-ENFILEIRA (antes: 409) — efeito volta à outbox, incidente 'retried'
    const retry = await retryIncident(api, tenant, inc.id as string, 'operador');
    expect(retry).toMatchObject({ ok: true, rearmedJobs: 0, reEnqueuedEffects: 1 });

    const back = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT effect_key, status FROM outbox WHERE effect_key = ${dlKey}`,
    );
    expect(back).toHaveLength(1);
    expect(back[0].status).toBe('pending');

    const [inc2] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM incidents WHERE id = ${inc.id}`);
    expect(inc2.status).toBe('retried');
  });

  it('re-enfileiramento é atômico + idempotente por effect_key (crash-test D11 do caminho novo)', async () => {
    // dead-letter isolado deste caso
    const dlKey = effectKey(instance, 4, 0, 'OpenUserTask');
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        { effectKey: dlKey, effect: { type: 'OpenUserTask', waitKey: 'dl-task-2', formRef: 'x' } as never },
      ]),
    );
    await dispatchOutboxOnce(api, tenant, { maxAttempts: 1 });
    const [inc] = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT id FROM incidents WHERE payload->>'effectKey' = ${dlKey}`,
    );

    // 1º retry re-enfileira (reusa a effect_key ORIGINAL)
    expect(await retryIncident(api, tenant, inc.id as string, 'op')).toMatchObject({ ok: true, reEnqueuedEffects: 1 });

    // 2º retry: incidente já 'retried' (não 'open') → notOpen, NÃO re-enfileira
    expect(await retryIncident(api, tenant, inc.id as string, 'op')).toMatchObject({ ok: false, reason: 'notOpen' });

    // Backstop FÍSICO: forço o incidente de volta a 'open' (o PIOR caso de um
    // crash que NÃO fosse atômico, que o withTenant/begin já previne) e retento.
    // O re-INSERT do MESMO effect_key é no-op (ON CONFLICT / UNIQUE) — a outbox
    // nunca fica com dois. É o UNIQUE(effect_key) segurando, D11.
    await withTenant(api, tenant, (tx) => tx`UPDATE incidents SET status = 'open' WHERE id = ${inc.id}`);
    await retryIncident(api, tenant, inc.id as string, 'op');
    const rows = await withTenant(api, tenant, (tx) => tx`SELECT effect_key FROM outbox WHERE effect_key = ${dlKey}`);
    expect(rows).toHaveLength(1);
  });
});
