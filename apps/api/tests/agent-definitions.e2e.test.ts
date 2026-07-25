import { APPROVAL_GATE_AGENT, type AgentWorkflow } from '@buildtovalue/agentflow';
import { signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRegistry,
  createRuntime,
  createUserRepository,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * P6 (deploy de agente, AG-3.6, shape `ag3-6-shape-proposta-p6-agent-deploy.md`):
 * mesmo padrão de process-definitions — deploy imutável com lint no gate (422 +
 * issues, nada gravado em erro), /lint para dry-run, RBAC reaproveitada
 * (definitions:deploy/definitions:read — decisão do dono: sem permissão nova).
 */
function graphAt(id: string, version: string, mutate?: (g: AgentWorkflow) => void): AgentWorkflow {
  const g: AgentWorkflow = structuredClone(APPROVAL_GATE_AGENT);
  g.id = id;
  g.version = version;
  mutate?.(g);
  return g;
}

describe('agent-definitions (P6, AG-3.6)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let analystToken: string;
  let operatorToken: string;
  let businessToken: string;

  beforeAll(async () => {
    db = await createTestDatabase('agent_definitions_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('agd', 'AgD') RETURNING id`;
    tenant = t.id as string;
    const analystId = await seedTestUser(migrator, tenant, { email: 'an@agd.test', displayName: 'Analyst', role: 'analyst' });
    const operatorId = await seedTestUser(migrator, tenant, { email: 'op@agd.test', displayName: 'Op', role: 'operator' });
    const businessId = await seedTestUser(migrator, tenant, { email: 'biz@agd.test', displayName: 'Biz', role: 'business' });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql),
      registry: createRegistry(sql, 'test'),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: analystToken } = await signAccessToken({ sub: analystId, tenantId: tenant, role: 'analyst', sid: 'test' }, jwt));
    ({ accessToken: operatorToken } = await signAccessToken({ sub: operatorId, tenantId: tenant, role: 'operator', sid: 'test' }, jwt));
    ({ accessToken: businessToken } = await signAccessToken({ sub: businessId, tenantId: tenant, role: 'business', sid: 'test' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it('deploy VÁLIDO grava com ref canônica (201); RBAC: definitions:deploy (analyst) sim, business não (403)', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/agent-definitions',
      headers: bearer(businessToken),
      payload: { graph: graphAt('agnt-http-1', '1.0.0') },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-definitions',
      headers: bearer(analystToken),
      payload: { graph: graphAt('agnt-http-1', '1.0.0') },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ agentId: 'agnt-http-1', version: '1.0.0', ref: 'agnt-http-1@1.0.0' });
    expect(body.autonomyLevel).toBe(APPROVAL_GATE_AGENT.autonomyLevel);
  });

  it('GATE: grafo com issue de erro → 422 + issues, NADA gravado', async () => {
    const bad = graphAt('agnt-http-ruim', '1.0.0', (g) => {
      const llm = g.nodes.find((n) => n.type === 'llm');
      if (llm && llm.type === 'llm') llm.config.promptRef = 'sem-arroba';
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-definitions',
      headers: bearer(analystToken),
      payload: { graph: bad },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues.some((i: { severity: string }) => i.severity === 'error')).toBe(true);

    // nada gravado: não aparece na listagem.
    const list = await app.inject({ method: 'GET', url: '/v1/agent-definitions', headers: bearer(operatorToken) });
    expect(list.json().items.some((a: { agentId: string }) => a.agentId === 'agnt-http-ruim')).toBe(false);
  });

  it('/lint faz DRY-RUN — mesmas issues do deploy, nada persistido', async () => {
    const bad = graphAt('agnt-http-lint', '1.0.0', (g) => {
      const llm = g.nodes.find((n) => n.type === 'llm');
      if (llm && llm.type === 'llm') llm.config.promptRef = 'sem-arroba';
    });
    const lint = await app.inject({
      method: 'POST',
      url: '/v1/agent-definitions/lint',
      headers: bearer(analystToken),
      payload: { graph: bad },
    });
    expect(lint.statusCode).toBe(200);
    expect(lint.json().issues.some((i: { severity: string }) => i.severity === 'error')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/v1/agent-definitions', headers: bearer(operatorToken) });
    expect(list.json().items.some((a: { agentId: string }) => a.agentId === 'agnt-http-lint')).toBe(false);
  });

  it('GET lista a versão MAIS RECENTE por agente; definitions:read (operator) vê, sem precisar de deploy', async () => {
    await app.inject({ method: 'POST', url: '/v1/agent-definitions', headers: bearer(analystToken), payload: { graph: graphAt('agnt-http-2', '1.0.0') } });
    await app.inject({ method: 'POST', url: '/v1/agent-definitions', headers: bearer(analystToken), payload: { graph: graphAt('agnt-http-2', '2.0.0') } });

    const res = await app.inject({ method: 'GET', url: '/v1/agent-definitions', headers: bearer(operatorToken) });
    expect(res.statusCode).toBe(200);
    const entry = res.json().items.find((a: { agentId: string }) => a.agentId === 'agnt-http-2');
    expect(entry).toMatchObject({ version: '2.0.0', ref: 'agnt-http-2@2.0.0' });
  });

  it('re-deploy da MESMA versão é recusado (UNIQUE ref, imutabilidade — mesmo comportamento de process-definitions)', async () => {
    const first = await app.inject({ method: 'POST', url: '/v1/agent-definitions', headers: bearer(analystToken), payload: { graph: graphAt('agnt-http-imut', '1.0.0') } });
    expect(first.statusCode).toBe(201);
    // a UNIQUE (tenant, ref) rejeita a nível de banco — o mesmo `rejects.toThrow`
    // provado em agent-registry.test.ts; na porta HTTP vira 500 (erro não
    // classificado, igual a qualquer outra constraint de imutabilidade do produto).
    const again = await app.inject({ method: 'POST', url: '/v1/agent-definitions', headers: bearer(analystToken), payload: { graph: graphAt('agnt-http-imut', '1.0.0') } });
    expect(again.statusCode).toBe(500);
  });
});
