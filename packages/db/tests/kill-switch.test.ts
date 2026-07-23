import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { lockJobs } from '../src/runtime/jobs.js';
import {
  assertSecretRef,
  getTenantAiConfig,
  setKillSwitch,
  upsertTenantAiConfig,
} from '../src/agent/tenantAiConfig.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Kill-switch (ADENDO-02 §5.2, aceite nomeado 2): semântica COMPLETA.
 * - novos jobs `agent` NÃO lockam enquanto pausado;
 * - os demais tipos (proxy dos gates humanos/serviços) SEGUEM valendo;
 * - reativação volta a lockar;
 * - acionar e reativar são AUDITADOS com motivo (trilha de tenant, D33).
 * - segredo só como `secret://…` (D29).
 */
describe('kill-switch de agente (D29 / §5.2)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('killswitch');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      // um job de agente e um job comum (serviço), ambos disponíveis
      await tx`INSERT INTO jobs (tenant_id, instance_id, wait_key, type)
        VALUES (${tenant}, ${inst.id}, 'w-agent', 'agent')`;
      await tx`INSERT INTO jobs (tenant_id, instance_id, wait_key, type)
        VALUES (${tenant}, ${inst.id}, 'w-http', 'http-call')`;
    });
    await migrator.end();
    api = postgres(db.apiUrl, { max: 3, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('segredo só como secret:// (D29)', () => {
    expect(() => assertSecretRef('sk-plaintext-123')).toThrow(/secret:\/\//);
    expect(() => assertSecretRef('secret://kms/acme/anthropic')).not.toThrow();
  });

  it('config auditada; kill-switch pausa SÓ os jobs agent; reativação volta a lockar', async () => {
    const actor = { type: 'user' as const, id: 'admin', requestId: 'r1' };
    await upsertTenantAiConfig(
      api,
      tenant,
      { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/acme/anthropic' },
      actor,
    );
    expect((await getTenantAiConfig(api, tenant))?.killSwitch).toBe(false);

    // PAUSA
    await setKillSwitch(api, tenant, true, actor, 'suspeita de custo anômalo');
    expect((await getTenantAiConfig(api, tenant))?.killSwitch).toBe(true);

    // agente pausado: lockJobs NÃO devolve o job agent; o http-call SEGUE
    const lockedWhilePaused = await lockJobs(api, tenant, 'worker-1', { limit: 10 });
    const types = lockedWhilePaused.map((j) => j.type).sort();
    expect(types).toEqual(['http-call']); // agent ficou de fora; serviço seguiu

    // devolve o http-call para não interferir na reativação
    await withTenant(api, tenant, (tx) => tx`UPDATE jobs SET status='available', lock_token=NULL, lock_until=NULL WHERE type='http-call'`);

    // REATIVA
    await setKillSwitch(api, tenant, false, actor, 'custo verificado, liberado');
    const lockedAfter = await lockJobs(api, tenant, 'worker-1', { limit: 10, types: ['agent'] });
    expect(lockedAfter.map((j) => j.type)).toEqual(['agent']); // agora locka

    // auditoria: pausa + reativação com motivo (trilha de tenant D33)
    const audit = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT event_type, motivo, payload FROM tenant_audit_events
                 WHERE event_type = 'agent.killswitch.toggled' ORDER BY id`,
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ motivo: 'suspeita de custo anômalo' });
    expect(audit[0].payload).toMatchObject({ killed: true });
    expect(audit[1]).toMatchObject({ motivo: 'custo verificado, liberado' });
    expect(audit[1].payload).toMatchObject({ killed: false });
  });
});
