import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockJobs, pauseJob } from '../src/runtime/jobs.js';
import { resumeAgentJobs } from '../src/agent/resume.js';
import { setKillSwitch, upsertTenantAiConfig } from '../src/agent/tenantAiConfig.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * RETOMADA da parada honesta (AG-2.2 etapa 5 slice 3, ADENDO-02 §5.2). A outra
 * metade do `pauseJob`: sem caminho de retomada o job pausado fica estacionado
 * para sempre (hang silencioso). Prova a semântica §5.2 nomeada pelo dono:
 *
 *  - kill-switch → job pausado → REATIVAÇÃO → job volta a `available` → a fila
 *    o re-pega (o walk conclui);
 *  - budget → retomada é AÇÃO EXPLÍCITA do operador, NUNCA automática; a
 *    reativação do kill-switch não toca em job pausado por budget;
 *  - ambas gravam FATO na trilha (`agent:retomado`: quem, quando, por quê —
 *    envelope D33) + evento de auditoria do tenant.
 */
describe('retomada da parada honesta — paused → available (§5.2)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  const actor = { type: 'user' as const, id: 'operador', requestId: 'req-retomada' };

  async function seedAgentJob(waitKey: string): Promise<string> {
    return withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO jobs (tenant_id, instance_id, wait_key, type, payload)
        VALUES (${tenant}, ${instanceId}, ${waitKey}, 'agent', '{}'::jsonb) RETURNING id`;
      return row.id as string;
    });
  }

  /** Lockar + estacionar um job de agente com a voz da parada. */
  async function parkJob(waitKey: string, kind: 'budget' | 'kill-switch'): Promise<string> {
    const jobId = await seedAgentJob(waitKey);
    const locked = await lockJobs(api, tenant, `w-${waitKey}`, { limit: 20 });
    const mine = locked.find((j) => j.id === jobId)!;
    const out = await pauseJob(api, tenant, jobId, mine.lock_token!, `parada honesta: ${kind}`, kind);
    expect(out.ok).toBe(true);
    return jobId;
  }

  beforeAll(async () => {
    db = await createTestDatabase('agent_resume');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('rt', 'Retomada') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    // config de inteligência do tenant (necessária para o kill-switch existir)
    await upsertTenantAiConfig(
      api,
      tenant,
      { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/rt/anthropic' },
      actor,
    );
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('kill-switch: aciona → job estaciona → REATIVA → volta a available → a fila o re-pega', async () => {
    const jobId = await parkJob(`ks:${instanceId}:1`, 'kill-switch');

    // aciona o kill-switch: enquanto pausado, nenhum job agent é lockado.
    await setKillSwitch(api, tenant, true, actor, 'suspeita de custo anômalo');
    const whilePaused = await lockJobs(api, tenant, 'w-ks', { limit: 20, types: ['agent'] });
    expect(whilePaused.find((j) => j.id === jobId)).toBeUndefined();

    // REATIVA (→ false): retoma AUTOMATICAMENTE os jobs pausados por kill-switch.
    await setKillSwitch(api, tenant, false, actor, 'custo verificado, liberado');

    const [job] = await withTenant(api, tenant, (tx) =>
      tx`SELECT status, pause_kind, error FROM jobs WHERE id = ${jobId}`);
    expect(job.status).toBe('available'); // paused → available
    expect(job.pause_kind).toBeNull(); // a voz da parada é limpa
    expect(job.error).toBeNull();

    // fato na trilha (envelope D33: quem, por quê) — o walk pode seguir.
    const [fact] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'agent:retomado' ORDER BY id`);
    expect(fact.kind).toBe('agent:retomado');
    expect(fact.payload).toMatchObject({
      actor: { type: 'user', id: 'operador' },
      pauseKind: 'kill-switch',
    });

    // evento de auditoria do tenant (D33) da retomada.
    const audit = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM tenant_audit_events WHERE event_type = 'agent.jobs.resumed' ORDER BY id`);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ pauseKind: 'kill-switch', count: 1 });

    // a fila re-pega o job que voltou (o walk conclui).
    const relocked = await lockJobs(api, tenant, 'w-ks2', { limit: 20, types: ['agent'] });
    expect(relocked.find((j) => j.id === jobId)).toBeDefined();
    // devolve para não sujar os próximos testes
    await withTenant(api, tenant, (tx) =>
      tx`UPDATE jobs SET status='completed', lock_token=NULL, lock_until=NULL WHERE id=${jobId}`);
  });

  it('budget: reativar o kill-switch NÃO retoma o job pausado por budget (retomada só explícita)', async () => {
    const jobId = await parkJob(`bg:${instanceId}:1`, 'budget');

    // reativar o kill-switch mira SÓ pause_kind='kill-switch' — budget fica parado.
    await setKillSwitch(api, tenant, true, actor, 'nova suspeita');
    await setKillSwitch(api, tenant, false, actor, 'liberado de novo');

    const [job] = await withTenant(api, tenant, (tx) =>
      tx`SELECT status, pause_kind FROM jobs WHERE id = ${jobId}`);
    expect(job.status).toBe('paused'); // budget NÃO foi retomado automaticamente
    expect(job.pause_kind).toBe('budget');
  });

  it('budget: retomada EXPLÍCITA do operador devolve o job à fila + grava fato/auditoria', async () => {
    const jobId = await parkJob(`bg:${instanceId}:2`, 'budget');

    const res = await resumeAgentJobs(api, tenant, 'budget', actor, 'teto elevado — retomar');
    expect(res.resumed).toBeGreaterThanOrEqual(1);
    expect(res.instanceIds).toContain(instanceId);

    const jobs = await withTenant(api, tenant, (tx) =>
      tx`SELECT status FROM jobs WHERE pause_kind IS NULL AND id = ${jobId}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('available');

    const fact = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'agent:retomado'
           AND payload->>'pauseKind' = 'budget' ORDER BY id`);
    expect(fact.length).toBeGreaterThanOrEqual(1);
    expect(fact[fact.length - 1].payload).toMatchObject({ pauseKind: 'budget', motivo: 'teto elevado — retomar' });
  });

  it('retomada sem nada pausado é no-op (não grava fato nem auditoria fantasma)', async () => {
    const before = await withTenant(api, tenant, (tx) =>
      tx`SELECT count(*)::int AS n FROM tenant_audit_events WHERE event_type = 'agent.jobs.resumed'`);
    const res = await resumeAgentJobs(api, tenant, 'budget', actor, 'nada a retomar');
    expect(res.resumed).toBe(0);
    const after = await withTenant(api, tenant, (tx) =>
      tx`SELECT count(*)::int AS n FROM tenant_audit_events WHERE event_type = 'agent.jobs.resumed'`);
    expect(after[0].n).toBe(before[0].n); // sem paused → sem evento
  });
});
