import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentJob } from '../src/agent/agentRunner.js';
import { fixtureAiProvider } from '../src/agent/aiProvider.js';
import { upsertTenantAiConfig } from '../src/agent/tenantAiConfig.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * AgentRunner core (AG-2.2 etapa 1): corrida DETERMINÍSTICA sob fixtures — o CI
 * nunca chama LLM real (D27). O resultado (variáveis) é o determinístico; o
 * interior não. BlockedDecision (sem-config/sem-provider/erro) nunca finge que
 * agiu: devolve bloqueio com voz de operador (o worker o vira incidente).
 */
describe('AgentRunner — corrida sob fixtures (AG-2.2 etapa 1)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;
  const actor = { type: 'user' as const, id: 'admin', requestId: 'r1' };

  beforeAll(async () => {
    db = await createTestDatabase('agent_runner');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  const fixtures = fixtureAiProvider({
    'Classifique: reembolso de R$ 200': { text: 'aprovar', costCents: 3 },
  });

  it('config presente + fixture → resultado determinístico (agentText + custo)', async () => {
    await upsertTenantAiConfig(
      api,
      tenant,
      { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/ag/anthropic' },
      actor,
    );
    const out = await runAgentJob(
      api,
      tenant,
      { prompt: 'Classifique: reembolso de R$ 200', elementId: 'classificar' },
      () => fixtures,
    );
    expect(out).toEqual({ ok: true, result: { agentText: 'aprovar', agentCostCents: 3 } });
  });

  it('sem provider disponível (resolver → null) → bloqueio no-provider (voz de operador)', async () => {
    const out = await runAgentJob(api, tenant, { prompt: 'x', elementId: 'classificar' }, () => null);
    expect(out).toMatchObject({ ok: false, blocked: 'no-provider' });
    if (!out.ok) expect(out.message).toMatch(/classificar.*indispon/i);
  });

  it('provider lança → bloqueio provider-error (nunca finge que concluiu)', async () => {
    const throwing = fixtureAiProvider({}); // sem fixture p/ o prompt → lança
    const out = await runAgentJob(api, tenant, { prompt: 'sem-fixture' }, () => throwing);
    expect(out).toMatchObject({ ok: false, blocked: 'provider-error' });
  });

  it('tenant SEM config de inteligência → bloqueio no-config', async () => {
    // segundo tenant, sem upsert de config
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t2] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag2', 'SemIA') RETURNING id`;
    const tenant2 = t2.id as string;
    await migrator.end();
    const out = await runAgentJob(api, tenant2, { prompt: 'x' }, () => fixtures);
    expect(out).toMatchObject({ ok: false, blocked: 'no-config' });
  });
});
