import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createEnvKeyProvider,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  deployFormDefinition,
  deployProcessDefinition,
  dispatchOutboxOnce,
  withTenant,
} from '@platform/db';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * Etapa 6 pelo CONTRATO HTTP: `decision` no corpo + `decisionVar` no detalhe.
 * A decisão NUNCA é ignorada em silêncio — declarada+ausente e não-declarada+
 * enviada respondem 422 explícito (a pior falha desta família seria uma
 * aprovação que não faz nada).
 */
describe('user-tasks completion — decision × decisionVar (etapa 6)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let deps: ReturnType<typeof fakeDeps>;
  let tenant: string;
  let biz: string;
  let admin: string;

  const dfForm: FormSchema = {
    formId: 'df',
    version: 1,
    title: 'Decisão',
    fields: [{ key: 'obs', type: 'text', label: 'Obs', dataClassification: 'internal' }],
  } as unknown as FormSchema;

  function decisionDiagram(withVar: boolean): BpmnDiagram {
    const d = createDiagram({ name: 'Dec' });
    d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
    const review = createNode({ id: 'review', type: 'userTask', label: 'r', x: 200, y: 0 });
    review.properties.formRef = 'df@1';
    review.properties.candidateRoles = ['business'];
    if (withVar) review.properties.decisionVar = 'decisao';
    d.nodes.review = review;
    if (withVar) {
      d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 400, y: 0 });
      d.nodes.endA = createNode({ id: 'endA', type: 'endEvent', label: 'a', x: 600, y: -40 });
      d.nodes.endR = createNode({ id: 'endR', type: 'endEvent', label: 'r', x: 600, y: 40 });
      d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'gw' });
      d.edges.gA = createEdge({ id: 'gA', sourceId: 'gw', targetId: 'endA' });
      d.edges.gA.properties.condition = 'decisao = "aprovar"';
      d.edges.gR = createEdge({ id: 'gR', sourceId: 'gw', targetId: 'endR' });
      d.edges.gR.properties.condition = 'decisao = "reprovar"';
    } else {
      d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'e', x: 400, y: 0 });
      d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'end' });
    }
    d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
    return d;
  }

  beforeAll(async () => {
    db = await createTestDatabase('decision_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('dx', 'DecX') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'b@dx.test', ${await hashPassword('x')}, 'Bea', 'business')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, { keyProvider: createEnvKeyProvider('segredo-decisao-api-ok-1234') }),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: biz } = await signAccessToken({ sub: 'bea', tenantId: tenant, role: 'business' }, jwt));
    ({ accessToken: admin } = await signAccessToken({ sub: 'adm', tenantId: tenant, role: 'admin' }, jwt));

    await deployFormDefinition(sql, tenant, { formId: 'df', schema: dfForm });
    await deployProcessDefinition(sql, tenant, { name: 'dec', diagram: decisionDiagram(true), engineVersion: 'e2e' });
    await deployProcessDefinition(sql, tenant, { name: 'plain', diagram: decisionDiagram(false), engineVersion: 'e2e' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function startAndClaim(ref: string): Promise<{ taskId: string; token: string }> {
    const start = await app.inject({ method: 'POST', url: '/v1/instances', headers: auth(admin), payload: { definitionRef: ref, businessKey: `${ref}-${Math.random()}`.slice(0, 40) } });
    expect(start.statusCode).toBe(201);
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) break;
    }
    const [task] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${start.json().id} AND status = 'open'`);
    const taskId = task.id as string;
    const claim = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(biz) });
    expect(claim.statusCode).toBe(200);
    return { taskId, token: claim.json().claimToken as string };
  }

  it('o detalhe da task expõe decisionVar (null quando não há decisão)', async () => {
    const withVar = await startAndClaim('dec@1');
    const detail = await app.inject({ method: 'GET', url: `/v1/user-tasks/${withVar.taskId}`, headers: auth(biz) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().decisionVar).toBe('decisao');

    const noVar = await startAndClaim('plain@1');
    const detail2 = await app.inject({ method: 'GET', url: `/v1/user-tasks/${noVar.taskId}`, headers: auth(biz) });
    expect(detail2.json().decisionVar).toBeNull();
  });

  it('conclusão SEM decision numa task que a exige → 422 (nunca aceita-e-descarta)', async () => {
    const { taskId, token } = await startAndClaim('dec@1');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(biz),
      payload: { claimToken: token, submission: {} },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/decisionVar|obrigat/i);
  });

  it('decision numa task que NÃO a declara → 422 decisionUnexpected', async () => {
    const { taskId, token } = await startAndClaim('plain@1');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(biz),
      payload: { claimToken: token, submission: {}, decision: 'aprovar' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/não declara|não seria roteada/i);
  });

  it('decision válida conclui (200) e roteia; decision vazia é rejeitada (400 zod)', async () => {
    const empty = await startAndClaim('dec@1');
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${empty.taskId}/completion`,
      headers: auth(biz),
      payload: { claimToken: empty.token, submission: {}, decision: '' },
    });
    expect(bad.statusCode).toBe(400); // min(1) do zod

    const ok = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${empty.taskId}/completion`,
      headers: auth(biz),
      payload: { claimToken: empty.token, submission: {}, decision: 'aprovar' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
