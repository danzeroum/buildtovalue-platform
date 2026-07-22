import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
  withTenant,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * Leva 3 da esteira F3 (shape §5): locks em lote pelo contrato público,
 * sub-recursos /completion|/failure com os aliases DEPRECADOS
 * byte-idênticos (exigência da triagem da leva 2), e GET /v1/jobs.
 */
describe('jobs — locks, completion/failure + aliases deprecados, list (shape §5)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestDatabase('jobs_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('jx', 'Jobs') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'op@jx.test', ${await hashPassword('x')}, 'Op', 'admin')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql),
      dbReady: async () => true,
    });
    await app.ready();
    ({ accessToken: token } = await signAccessToken(
      { sub: 'worker-e2e', tenantId: tenant, role: 'admin' },
      { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function startAndDrain(businessKey: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth(),
      payload: { businessKey },
    });
    expect(res.statusCode).toBe(201);
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) break;
    }
    return res.json().id as string;
  }

  // cada chamada trava TUDO que estiver disponível — o mapa acumula os
  // lock_tokens de todas as chamadas para achar o job de cada instância.
  const locked = new Map<string, { id: string; lockToken: string }>();
  async function lockOne(instanceId: string): Promise<{ id: string; lockToken: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/locks',
      headers: auth(),
      payload: { workerId: 'w-e2e', limit: 50, types: ['noop'] },
    });
    expect(res.statusCode).toBe(200);
    for (const j of res.json().jobs as Array<{ id: string; instanceId: string; lockToken: string }>) {
      locked.set(j.instanceId, { id: j.id, lockToken: j.lockToken });
    }
    const job = locked.get(instanceId);
    expect(job, `job da instância ${instanceId} não lockado`).toBeDefined();
    return job!;
  }

  it('POST /v1/jobs/locks trava em lote com filtro de types e devolve lockToken', async () => {
    const instance = await startAndDrain('jobs-lock');
    const semMatch = await app.inject({
      method: 'POST',
      url: '/v1/jobs/locks',
      headers: auth(),
      payload: { workerId: 'w-e2e', types: ['tipo-que-nao-existe'] },
    });
    expect(semMatch.json().jobs).toEqual([]);
    const { lockToken } = await lockOne(instance);
    expect(lockToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('EQUIVALÊNCIA byte-idêntica alias↔rota nova: sucesso e fencing 409', async () => {
    // duas instâncias gêmeas → um job por rota; as respostas de SUCESSO
    // diferem só no id/campos da própria instância — comparamos a FORMA
    // (chaves + status) e o corpo do 409 de fencing byte a byte.
    const iNova = await startAndDrain('eq-nova');
    const iAlias = await startAndDrain('eq-alias');
    const jNova = await lockOne(iNova);
    const jAlias = await lockOne(iAlias);

    const viaNova = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jNova.id}/completion`,
      headers: auth(),
      payload: { lockToken: jNova.lockToken },
    });
    const viaAlias = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jAlias.id}/complete`,
      headers: auth(),
      payload: { lockToken: jAlias.lockToken },
    });
    expect(viaNova.statusCode).toBe(200);
    expect(viaAlias.statusCode).toBe(200);
    expect(Object.keys(viaNova.json()).sort()).toEqual(Object.keys(viaAlias.json()).sort());
    expect(viaNova.json().status).toBe(viaAlias.json().status);

    // fencing: repetir a conclusão nas DUAS rotas — 409 byte-idêntico
    // (normalizando o requestId, que é único por request)
    const norm = (body: string) => JSON.parse(body.replace(/"requestId":"[^"]+"/, '"requestId":"X"'));
    const dupNova = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jNova.id}/completion`,
      headers: auth(),
      payload: { lockToken: jNova.lockToken },
    });
    const dupAlias = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jNova.id}/complete`,
      headers: auth(),
      payload: { lockToken: jNova.lockToken },
    });
    expect(dupNova.statusCode).toBe(409);
    expect(dupAlias.statusCode).toBe(409);
    expect(norm(dupNova.body)).toEqual(norm(dupAlias.body));

    // failure ↔ fail: mesma equivalência no caminho de retry
    const iFail = await startAndDrain('eq-fail');
    const jFail = await lockOne(iFail);
    const viaFailure = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jFail.id}/failure`,
      headers: auth(),
      payload: { lockToken: jFail.lockToken, error: 'boom' },
    });
    expect(viaFailure.statusCode).toBe(200);
    expect(viaFailure.json()).toEqual({ status: 'available' }); // retry
    const jFail2 = await lockOne(iFail);
    const viaFail = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jFail2.id}/fail`,
      headers: auth(),
      payload: { lockToken: jFail2.lockToken, error: 'boom-2' },
    });
    expect(viaFail.statusCode).toBe(200);
    expect(viaFail.json()).toEqual({ status: 'available' });
  });

  it('OpenAPI: aliases marcados deprecated (SDK/console não os expõem); rotas novas não', async () => {
    const doc = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const paths = doc.json().paths as Record<string, { post?: { deprecated?: boolean } }>;
    expect(paths['/v1/jobs/{id}/complete']?.post?.deprecated).toBe(true);
    expect(paths['/v1/jobs/{id}/fail']?.post?.deprecated).toBe(true);
    expect(paths['/v1/jobs/{id}/completion']?.post?.deprecated).toBeUndefined();
    expect(paths['/v1/jobs/{id}/failure']?.post?.deprecated).toBeUndefined();
  });

  it('GET /v1/jobs lista com filtros status/type/instanceId', async () => {
    const instance = await startAndDrain('jobs-list');
    const byInstance = await app.inject({
      method: 'GET',
      url: `/v1/jobs?instanceId=${instance}`,
      headers: auth(),
    });
    expect(byInstance.statusCode).toBe(200);
    expect(byInstance.json().items).toHaveLength(1);
    expect(byInstance.json().items[0]).toMatchObject({ instanceId: instance, type: 'noop' });
    const completed = await app.inject({
      method: 'GET',
      url: '/v1/jobs?status=completed',
      headers: auth(),
    });
    expect(completed.json().items.every((j: { status: string }) => j.status === 'completed')).toBe(true);
    expect(completed.json().items.length).toBeGreaterThanOrEqual(2); // das concluídas acima
  });
});
