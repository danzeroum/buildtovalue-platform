import { signAccessToken } from '@platform/auth';
import {
  buildAgentFacts,
  createDb,
  createEnvKeyProvider,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  persistAgentTrail,
  withTenant,
  type Classifications,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * Custo real na trilha do agente na API (AG-3.3). `GET /v1/instances/:id/history`
 * é gated por `instances:read` (AMPLO — business/analyst também têm) — mais
 * amplo que `operate:read`. Aceite nomeado: business/analyst NÃO veem `cost` no
 * histórico (herança simples vazaria gasto de LLM); operator/admin veem.
 */
const COST = {
  cents: 512,
  currency: 'BRL',
  priceTableVersion: 'deepseek-2026-07',
  fxRate: 5.28,
  usage: { inputTokens: 200, outputTokens: 60 },
};

describe('AG-3.3 · custo do agente no histórico da API — RBAC operate:read', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let instanceId: string;
  let businessTok: string;
  let analystTok: string;
  let operatorTok: string;
  let adminTok: string;

  beforeAll(async () => {
    db = await createTestDatabase('agent_cost_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acapi', 'AgentCostApi') RETURNING id`;
    tenant = t.id as string;
    const bizId = await seedTestUser(migrator, tenant, { email: 'biz@acapi.test', displayName: 'Biz', role: 'business' });
    const analystId = await seedTestUser(migrator, tenant, { email: 'an@acapi.test', displayName: 'An', role: 'analyst' });
    const operatorId = await seedTestUser(migrator, tenant, { email: 'op@acapi.test', displayName: 'Op', role: 'operator' });
    const adminId = await seedTestUser(migrator, tenant, { email: 'admin@acapi.test', displayName: 'Admin', role: 'admin' });
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'com-agente@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const classifications: Classifications = {};
    const facts = buildAgentFacts({
      io: {},
      visitedNodes: ['llm-review'],
      complete: true,
      costByNode: { 'llm-review': COST },
    });
    await withTenant(sql, tenant, (tx) =>
      persistAgentTrail(tx, {
        tenantId: tenant,
        instanceId,
        elementId: 'classificar',
        agentRef: 'agnt-aprova@1.0.0',
        actor: { type: 'agent', id: 'agnt-aprova@1.0.0', requestId: 'job-1' },
        facts,
        classifications,
        engineVersion: 'e',
        revision: 1,
      }),
    );

    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, { keyProvider: createEnvKeyProvider('segredo-agent-cost-e2e-ok') }),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: businessTok } = await signAccessToken({ sub: bizId, tenantId: tenant, role: 'business', sid: 'test' }, jwt));
    ({ accessToken: analystTok } = await signAccessToken({ sub: analystId, tenantId: tenant, role: 'analyst', sid: 'test' }, jwt));
    ({ accessToken: operatorTok } = await signAccessToken({ sub: operatorId, tenantId: tenant, role: 'operator', sid: 'test' }, jwt));
    ({ accessToken: adminTok } = await signAccessToken({ sub: adminId, tenantId: tenant, role: 'admin', sid: 'test' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it('business (instances:read, sem operate:read) VÊ a linha mas NÃO o custo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/history`,
      headers: bearer(businessTok),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const acao = body.items.find((i: { kind: string; payload: { nodeId?: string } }) => i.kind === 'agent:acao' && i.payload.nodeId === 'llm-review');
    expect(acao).toBeDefined(); // a linha da trilha É visível — instances:read é amplo o bastante
    expect('cost' in acao.payload).toBe(false); // mas o custo, não
    expect(res.body).not.toContain('priceTableVersion');
  });

  it('analyst (instances:read, sem operate:read): mesmo degrade — sem custo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/history`,
      headers: bearer(analystTok),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('priceTableVersion');
  });

  it('operator (operate:read) VÊ o custo completo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/history`,
      headers: bearer(operatorTok),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const acao = body.items.find((i: { kind: string; payload: { nodeId?: string } }) => i.kind === 'agent:acao' && i.payload.nodeId === 'llm-review');
    expect(acao.payload.cost).toEqual(COST);
  });

  it('admin (operate:read via ALL) também vê o custo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/history`,
      headers: bearer(adminTok),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const acao = body.items.find((i: { kind: string; payload: { nodeId?: string } }) => i.kind === 'agent:acao' && i.payload.nodeId === 'llm-review');
    expect(acao.payload.cost).toEqual(COST);
  });
});
