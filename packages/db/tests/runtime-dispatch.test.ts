import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectKey } from '../src/runtime/effectKey.js';
import { completeJob, failJob, lockJobs } from '../src/runtime/jobs.js';
import { dispatchOutboxOnce, insertEffects, outboxDepth } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Testes do NÚCLEO do walking skeleton que não depende do engine publicado:
 * dispatcher SKIP LOCKED com crash simulado + re-dispatch idempotente, e o
 * contrato de jobs com lease + fencing por lock_token (D12). O e2e completo
 * (engine publicado pinado exato → 100 instâncias sem efeito duplicado)
 * entra no fechamento do F1.8.
 */
describe('runtime skeleton — outbox e jobs (migração 0002)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  async function seedInstance(): Promise<string> {
    return withTenant(api, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version,
          state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'test', 1, '{}'::jsonb, 'active')
        RETURNING id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('runtime_test');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`
      INSERT INTO tenants (slug, name) VALUES ('rt', 'Runtime') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('dispatch de CreateJob cria o job e DELETA a linha da outbox (fila efêmera)', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 1, 0, 'CreateJob'),
          effect: { type: 'CreateJob', waitKey: `svc:${instance}`, jobType: 'noop', payload: {} },
        },
      ]),
    );
    const result = await dispatchOutboxOnce(api, tenant);
    expect(result.processed).toBe(1);
    expect(await outboxDepth(api, tenant)).toBe(0);
    const jobs = await withTenant(api, tenant, (tx) => tx`SELECT wait_key, status FROM jobs`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ wait_key: `svc:${instance}`, status: 'available' });
  });

  it('CRASH no meio do dispatch → rollback → re-dispatch SEM efeito duplicado', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 1, 0, 'CreateJob'),
          effect: { type: 'CreateJob', waitKey: `crash:${instance}`, jobType: 'noop' },
        },
        {
          effectKey: effectKey(instance, 1, 1, 'EmitHistory'),
          effect: { type: 'EmitHistory', kind: 'x' },
        },
      ]),
    );
    // worker "morre" depois de processar o 1º item do lote (job já inserido
    // NA TX) e antes de commitar — tudo reverte.
    await expect(
      dispatchOutboxOnce(api, tenant, {
        onCrash: (_row, index) => {
          if (index === 1) throw new Error('kill -9 simulado');
        },
      }),
    ).rejects.toThrow('kill -9 simulado');
    expect(await outboxDepth(api, tenant)).toBe(2); // nada consumido
    const afterCrash = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT id FROM jobs WHERE wait_key = ${'crash:' + instance}`,
    );
    expect(afterCrash).toHaveLength(0); // rollback limpou o insert parcial

    // worker novo re-dispacha: exatamente UM job, outbox drenada.
    const retry = await dispatchOutboxOnce(api, tenant);
    expect(retry.processed).toBe(2);
    expect(await outboxDepth(api, tenant)).toBe(0);
    const jobs = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT id FROM jobs WHERE wait_key = ${'crash:' + instance}`,
    );
    expect(jobs).toHaveLength(1);
  });

  it('effect_key deduplica: reinserção do MESMO efeito é no-op', async () => {
    const instance = await seedInstance();
    const key = effectKey(instance, 2, 0, 'CreateJob');
    for (let i = 0; i < 3; i++) {
      await withTenant(api, tenant, (tx) =>
        insertEffects(tx, tenant, instance, [
          { effectKey: key, effect: { type: 'CreateJob', waitKey: `dup:${instance}`, jobType: 'noop' } },
        ]),
      );
    }
    expect(await outboxDepth(api, tenant)).toBe(1);
    await dispatchOutboxOnce(api, tenant);
  });

  it('fencing (D12): lease expira, outro worker re-toma, token velho leva 409', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 3, 0, 'CreateJob'),
          effect: { type: 'CreateJob', waitKey: `fence:${instance}`, jobType: 'noop' },
        },
      ]),
    );
    await dispatchOutboxOnce(api, tenant);

    // worker A trava com lease curtíssimo e "morre" sem concluir
    const lockedA = await lockJobs(api, tenant, 'worker-a', { leaseMs: 50, limit: 20 });
    const jobA = lockedA.find((j) => j.wait_key === `fence:${instance}`)!;
    expect(jobA).toBeDefined();
    const staleToken = jobA.lock_token!;
    await new Promise((r) => setTimeout(r, 80)); // lease expira

    // worker B re-toma o MESMO job (lease vencido volta à fila)
    const lockedB = await lockJobs(api, tenant, 'worker-b', { leaseMs: 30_000, limit: 20 });
    const jobB = lockedB.find((j) => j.wait_key === `fence:${instance}`)!;
    expect(jobB.id).toBe(jobA.id);
    expect(jobB.lock_token).not.toBe(staleToken);

    // A acorda atrasado: token velho é rejeitado (API responde 409)
    const late = await completeJob(api, tenant, jobA.id, staleToken);
    expect(late).toEqual({ ok: false, reason: 'staleToken' });

    // B conclui com o token vigente — exatamente uma conclusão
    const done = await completeJob(api, tenant, jobB.id, jobB.lock_token!);
    expect(done.ok).toBe(true);
    const replay = await completeJob(api, tenant, jobB.id, jobB.lock_token!);
    expect(replay).toEqual({ ok: false, reason: 'notLocked' });
  });

  it('failJob devolve à fila enquanto há retries; esgotado vira failed', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 4, 0, 'CreateJob'),
          effect: { type: 'CreateJob', waitKey: `fail:${instance}`, jobType: 'noop' },
        },
      ]),
    );
    await dispatchOutboxOnce(api, tenant);
    await withTenant(api, tenant, (tx) =>
      tx`UPDATE jobs SET retries_left = 1 WHERE wait_key = ${'fail:' + instance}`,
    );

    const pick = async () =>
      (await lockJobs(api, tenant, 'w', { limit: 20 })).find(
        (j) => j.wait_key === `fail:${instance}`,
      )!;
    let job = await pick();
    const first = await failJob(api, tenant, job.id, job.lock_token!, 'boom');
    expect(first.ok && first.job.status).toBe('available');

    job = await pick();
    const second = await failJob(api, tenant, job.id, job.lock_token!, 'boom outra vez');
    expect(second.ok && second.job.status).toBe('failed');
  });

  it('RLS cobre as três tabelas novas (sem contexto, nada aparece)', async () => {
    expect((await api`SELECT id FROM instances`).length).toBe(0);
    expect((await api`SELECT id FROM outbox`).length).toBe(0);
    expect((await api`SELECT id FROM jobs`).length).toBe(0);
  });
});
