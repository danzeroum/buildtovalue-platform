import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { signAccessToken, type Role } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRegistry,
  createUserRepository,
  deployProcessDefinition,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * AG-2.1 etapa 5 [GATE] — GET /v1/startable-definitions.
 * O ponto da rota é FECHAR a lacuna de RBAC: o `business` tem `instances:start`
 * mas NÃO `definitions:read`. Aqui provamos, no servidor real, que:
 *  - a projeção é {id,name,version} — SEM diagrama/XML;
 *  - o `business` (sem definitions:read) recebe 200 nesta rota;
 *  - o MESMO business recebe 403 em /v1/process-definitions (a rota rica),
 *    isolando que o escopo desta é `instances:start` PURO.
 */
describe('GET /v1/startable-definitions (etapa 5, escopo instances:start puro)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let secret: string;

  /** Diagrama VÁLIDO sem userTask/form: start → serviceTask(noop) → end. */
  function serviceOnly(name: string): BpmnDiagram {
    const d = createDiagram({ name });
    d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'start', x: 0, y: 0 });
    const svc = createNode({ id: 'svc', type: 'serviceTask', label: 'svc', x: 200, y: 0 });
    svc.properties.jobType = 'noop';
    d.nodes.svc = svc;
    d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'end', x: 400, y: 0 });
    d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'svc' });
    d.edges.e2 = createEdge({ id: 'e2', sourceId: 'svc', targetId: 'end' });
    return d;
  }

  async function tokenFor(role: Role): Promise<string> {
    const { accessToken } = await signAccessToken(
      { sub: `${role}-user`, tenantId: tenant, role },
      { secret, accessTtlSeconds: 900 },
    );
    return accessToken;
  }

  beforeAll(async () => {
    db = await createTestDatabase('startable_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('st', 'Startable') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    // aprovacao com DUAS versões (a @1 aposenta ao publicar @2) + onboarding
    await deployProcessDefinition(sql, tenant, { name: 'aprovacao', diagram: serviceOnly('Aprovação'), engineVersion: 'test' });
    await deployProcessDefinition(sql, tenant, { name: 'aprovacao', diagram: serviceOnly('Aprovação'), engineVersion: 'test' });
    await deployProcessDefinition(sql, tenant, { name: 'onboarding', diagram: serviceOnly('Onboarding'), engineVersion: 'test' });

    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    secret = deps.config.JWT_SECRET;
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      registry: createRegistry(sql, 'test'),
      dbReady: async () => true,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  it('business (instances:start, SEM definitions:read) recebe {id,name,version,registryRef}; só a versão ativa', async () => {
    const token = await tokenFor('business');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/startable-definitions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // dois NOMES (não três linhas): aprovacao@2 + onboarding@1 — a @1 aposentou
    expect(body.items.length).toBe(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'registryRef', 'version']);
      expect(item).not.toHaveProperty('diagram'); // NUNCA vaza o modelo
    }
    const aprovacao = body.items.find((i: { name: string }) => i.name === 'aprovacao');
    expect(aprovacao.version).toBe(2);
    expect(aprovacao.registryRef).toBe('aprovacao@2'); // canônico, usado verbatim
  });

  it('o MESMO business é 403 em /v1/process-definitions — escopo desta rota é instances:start PURO', async () => {
    const token = await tokenFor('business');
    const rich = await app.inject({
      method: 'GET',
      url: '/v1/process-definitions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rich.statusCode).toBe(403); // não tem definitions:read
  });

  it('operator (definitions:read, SEM instances:start) → 403 na rota iniciável', async () => {
    // simetria: o operator é o inverso do business — lê o modelo mas não inicia.
    // Prova que o gate desta rota é `instances:start`, não definitions:read.
    const token = await tokenFor('operator');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/startable-definitions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cursor pagina sem repetir a linha de fronteira', async () => {
    const token = await tokenFor('analyst'); // analyst também tem instances:start
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/startable-definitions?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json();
    expect(b1.items).toHaveLength(1);
    expect(b1.nextCursor).toBeTruthy();

    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/startable-definitions?limit=1&cursor=${encodeURIComponent(b1.nextCursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const b2 = p2.json();
    expect(b2.items).toHaveLength(1);
    expect(b2.items[0].id).not.toBe(b1.items[0].id);
  });
});
