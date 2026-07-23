import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHonestStop } from '../src/agent/agentRunner.js';
import { lockJobs, pauseJob } from '../src/runtime/jobs.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * PARADA HONESTA × FALHA (AG-2.2 etapa 5 slice 3, ADENDO-02 §5). `budget` e
 * `kill-switch` são pausas esperadas (âmbar, ESTACIONA o job, sem incidente);
 * `no-config`/`no-graph`/`walk-error` são falhas (vermelho, incidente). Prova a
 * distinção que a marcação do designer exige — parada honesta não vira card vermelho.
 */
describe('parada honesta × falha — o job estaciona, não vira incidente (§5)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  async function seedAgentJob(waitKey: string): Promise<string> {
    return withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO jobs (tenant_id, instance_id, wait_key, type, payload)
        VALUES (${tenant}, ${instanceId}, ${waitKey}, 'agent', '{}'::jsonb) RETURNING id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('honest_stop');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('isHonestStop: budget/kill-switch âmbar; no-config/no-graph/walk-error vermelho', () => {
    expect(isHonestStop('budget')).toBe(true);
    expect(isHonestStop('kill-switch')).toBe(true);
    expect(isHonestStop('no-config')).toBe(false);
    expect(isHonestStop('no-graph')).toBe(false);
    expect(isHonestStop('walk-error')).toBe(false);
  });

  it('pauseJob ESTACIONA o job (paused) SEM incidente; a fila não o re-pega', async () => {
    await seedAgentJob(`hs:${instanceId}:1`);
    const [locked] = await lockJobs(api, tenant, 'w1', { limit: 10 });
    expect(locked.type).toBe('agent');
    const out = await pauseJob(api, tenant, locked.id, locked.lock_token!, 'kill-switch acionado — parada honesta', 'kill-switch');
    expect(out.ok).toBe(true);

    // job em 'paused' (não 'failed'); SEM incidente aberto; a fila não o re-pega.
    const [job] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM jobs WHERE id = ${locked.id}`);
    expect(job.status).toBe('paused');
    const incidents = await withTenant(api, tenant, (tx) => tx`
      SELECT 1 FROM incidents WHERE instance_id = ${instanceId}`);
    expect(incidents).toHaveLength(0); // parada honesta NÃO abre incidente (contraste com failJob)
    const again = await lockJobs(api, tenant, 'w2', { limit: 10 });
    expect(again.find((j) => j.id === locked.id)).toBeUndefined(); // 'paused' sai da fila
  });

  it('pauseJob respeita o fencing (lock_token velho → recusa)', async () => {
    await seedAgentJob(`hs:${instanceId}:2`);
    const [locked] = await lockJobs(api, tenant, 'w3', { limit: 10 });
    const bad = await pauseJob(api, tenant, locked.id, '00000000-0000-0000-0000-000000000000', 'x', 'kill-switch');
    expect(bad).toMatchObject({ ok: false });
  });
});
