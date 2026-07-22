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
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * Leva 4 — FENCING FORMAL DE USER TASK (critério NOMEADO do aceite F3),
 * estilo crash test: claim persistente D21 sobrevive a RESTART da API;
 * token ROTACIONADO mata o anterior (10.b); reatribuição D24 invalida e
 * audita; validação no servidor pelo form PINADO (422 por campo); ZERO
 * conclusão dupla. Visibilidade §2.2: papel alheio filtrado/403.
 */
describe('user-tasks — claim D21 + fencing formal + assignment D24 (shape §6)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let deps: ReturnType<typeof fakeDeps>;
  let tenant: string;
  let maria: string;
  let joao: string;
  let operator: string;
  let analyst: string;

  async function makeApp(): Promise<ZodApp> {
    const built = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, {
        keyProvider: createEnvKeyProvider('segredo-tasks-e2e-ok'),
      }),
      dbReady: async () => true,
    });
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    db = await createTestDatabase('tasks_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('tk', 'Tasks') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'maria@tk.test', ${await hashPassword('x')}, 'Maria', 'business')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await makeApp();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: maria } = await signAccessToken({ sub: 'maria', tenantId: tenant, role: 'business' }, jwt));
    ({ accessToken: joao } = await signAccessToken({ sub: 'joao', tenantId: tenant, role: 'business' }, jwt));
    ({ accessToken: operator } = await signAccessToken({ sub: 'chefe', tenantId: tenant, role: 'admin' }, jwt));
    ({ accessToken: analyst } = await signAccessToken({ sub: 'ana-lista', tenantId: tenant, role: 'analyst' }, jwt));

    // deploy REAL: form pinado + processo com candidateRoles ['business']
    const schema: FormSchema = {
      formId: 'analise',
      version: 1,
      title: 'Análise',
      fields: [
        { key: 'approved', type: 'checkbox', label: 'Aprovado?', dataClassification: 'internal' },
        { key: 'parecer', type: 'text', label: 'Parecer', required: true, dataClassification: 'internal' },
      ],
    } as unknown as FormSchema;
    const form = await deployFormDefinition(sql, tenant, { formId: 'analise', schema });
    expect(form.ok).toBe(true);
    const diagram: BpmnDiagram = (() => {
      const d = createDiagram({ name: 'Análise' });
      d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
      const review = createNode({ id: 'review', type: 'userTask', label: 'r', x: 200, y: 0 });
      review.properties.formRef = 'analise@1';
      review.properties.candidateRoles = ['business'];
      d.nodes.review = review;
      d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'e', x: 400, y: 0 });
      d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
      d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'end' });
      return d;
    })();
    const proc = await deployProcessDefinition(sql, tenant, {
      name: 'analise',
      diagram,
      engineVersion: 'e2e',
    });
    expect(proc.ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function startTask(businessKey: string): Promise<{ instanceId: string; taskId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth(operator),
      payload: { definitionRef: 'analise@1', businessKey },
    });
    expect(res.statusCode).toBe(201);
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) break;
    }
    const [task] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${res.json().id} AND status = 'open'`);
    return { instanceId: res.json().id as string, taskId: task.id as string };
  }

  it('FENCING FORMAL: claim → holder 409 → rotação → RESTART → token velho 409 → completa 1x', async () => {
    const { taskId } = await startTask('fence-1');

    // Maria reivindica → T1
    const claim1 = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(maria) });
    expect(claim1.statusCode).toBe(200);
    const t1 = claim1.json().claimToken as string;

    // João tenta → 409 com HOLDER para a UI ("com maria desde …")
    const held = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(joao) });
    expect(held.statusCode).toBe(409);
    expect(held.json().holder).toMatchObject({ user: 'maria' });
    expect(held.json().holder.since).toBeTruthy();

    // Re-claim da PRÓPRIA Maria ROTACIONA (decisão 10.b): T2 mata T1
    const claim2 = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(maria) });
    const t2 = claim2.json().claimToken as string;
    expect(t2).not.toBe(t1);

    // RESTART da API (crash do processo): o claim é PERSISTENTE (D21)
    await app.close();
    app = await makeApp();

    // token VELHO pós-restart = 409 (fencing)
    const stale = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(maria),
      payload: { claimToken: t1, submission: { approved: true, parecer: 'ok' } },
    });
    expect(stale.statusCode).toBe(409);

    // validação NO SERVIDOR pelo form pinado: campo required faltando = 422
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(maria),
      payload: { claimToken: t2, submission: { approved: true } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors).toHaveProperty('parecer');

    // token VIGENTE + submissão válida = conclui e o engine avança
    const done = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(maria),
      payload: { claimToken: t2, submission: { approved: true, parecer: 'aprovado' } },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().instanceStatus).toBe('completed');

    // ZERO conclusão dupla
    const dupe = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(maria),
      payload: { claimToken: t2, submission: { approved: true, parecer: 'de novo' } },
    });
    expect(dupe.statusCode).toBe(409);
    const rows = await withTenant(sql, tenant, (tx) =>
      tx`SELECT count(*)::int AS n FROM user_tasks WHERE id = ${taskId} AND status = 'completed'`);
    expect(rows[0].n).toBe(1);
  });

  it('reatribuição D24: invalida o token vigente, audita ator+motivo; novo dono conclui', async () => {
    const { instanceId, taskId } = await startTask('fence-2');
    const claim = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(maria) });
    const tMaria = claim.json().claimToken as string;

    const assigned = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/assignment`,
      headers: auth(operator),
      payload: { assignee: 'joao', reason: 'Maria de férias' },
    });
    expect(assigned.statusCode).toBe(200);

    // auditoria da revogação: ator + motivo + de/para
    const [audit] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'taskReassigned'`);
    expect(audit.payload).toMatchObject({
      from: 'maria', to: 'joao', actor: 'chefe', reason: 'Maria de férias',
    });

    // token da Maria MORREU com a reatribuição
    const stale = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(maria),
      payload: { claimToken: tMaria, submission: { approved: true, parecer: 'x' } },
    });
    expect(stale.statusCode).toBe(409);

    // João (novo assignee) reivindica e conclui
    const claimJ = await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(joao) });
    expect(claimJ.statusCode).toBe(200);
    const done = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${taskId}/completion`,
      headers: auth(joao),
      payload: { claimToken: claimJ.json().claimToken, submission: { approved: false, parecer: 'rejeitado' } },
    });
    expect(done.statusCode).toBe(200);
  });

  it('visibilidade §2.2: papel alheio FILTRADO na lista; 403 com mensagem no acesso direto; unclaim alheio 403', async () => {
    const { taskId } = await startTask('fence-3');

    // analyst tem tasks:read mas papel fora dos candidateRoles ['business']
    const list = await app.inject({ method: 'GET', url: '/v1/user-tasks?status=open', headers: auth(analyst) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);

    const direct = await app.inject({ method: 'GET', url: `/v1/user-tasks/${taskId}`, headers: auth(analyst) });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().detail).toContain('business'); // mensagem de papel

    // business VÊ (filter=role) e admin vê tudo
    const forMaria = await app.inject({ method: 'GET', url: '/v1/user-tasks?filter=role', headers: auth(maria) });
    expect(forMaria.json().items.map((t: { id: string }) => t.id)).toContain(taskId);

    // unclaim de claim alheio = 403
    await app.inject({ method: 'POST', url: `/v1/user-tasks/${taskId}/claim`, headers: auth(maria) });
    const unclaimAlheio = await app.inject({
      method: 'DELETE',
      url: `/v1/user-tasks/${taskId}/claim`,
      headers: auth(joao),
    });
    expect(unclaimAlheio.statusCode).toBe(403);
    const unclaimProprio = await app.inject({
      method: 'DELETE',
      url: `/v1/user-tasks/${taskId}/claim`,
      headers: auth(maria),
    });
    expect(unclaimProprio.statusCode).toBe(204);
  });
});
