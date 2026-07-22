import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
  EXAMPLE_DEFINITION_REF,
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
 * Cancelamento pelo CONTRATO PÚBLICO (aceite F2): POST /v1/instances/:id/cancel
 * fecha TODAS as esperas — a task some, o timer não dispara — e cancelar de
 * novo é 409 problem+json.
 */
describe('POST /v1/instances/:id/cancel (aceite F2)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestDatabase('cancel_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('cx', 'Cancel') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'op@cx.test', ${await hashPassword('x')}, 'Op', 'admin')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({});
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql),
      dbReady: async () => true,
    });
    await app.ready();
    ({ accessToken: token } = await signAccessToken(
      { sub: 'op', tenantId: tenant, role: 'admin' },
      { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  it('cancela, fecha task e timer, e recusa o segundo cancelamento com 409', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const started = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth,
      payload: { definitionRef: EXAMPLE_DEFINITION_REF, businessKey: 'cx-1' },
    });
    expect(started.statusCode).toBe(201);
    const id = started.json().id as string;
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0) break;
    }

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/instances/${id}/cancel`,
      headers: auth,
      payload: { reason: 'pedido do operador' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0) break;
    }

    const [task] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT status FROM user_tasks WHERE instance_id = ${id}`);
    expect(task.status).toBe('cancelled'); // a task SOME da Tasklist
    const [timer] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT status FROM timers WHERE instance_id = ${id}`);
    expect(timer.status).toBe('cancelled'); // o timer NÃO dispara

    const again = await app.inject({
      method: 'POST',
      url: `/v1/instances/${id}/cancel`,
      headers: auth,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toContain('/problems/conflict');

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/instances/00000000-0000-0000-0000-000000000000/cancel',
      headers: auth,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});
