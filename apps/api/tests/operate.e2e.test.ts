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
 * Leva 5 da esteira F3 (shape §6b/§7): GET /v1/timers; incidentes com
 * retry (jobs failed re-armados, auditado), 409 honesto para dead-letter
 * (pendência registrada — re-enfileirar exige migração) e resolution com
 * motivo (auditado).
 */
describe('operate — timers e incidents retry/resolution (shape §6b/§7)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestDatabase('operate_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('op', 'Operate') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'op@op.test', ${await hashPassword('x')}, 'Op', 'admin')`;
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
      { sub: 'operador', tenantId: tenant, role: 'admin' },
      { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function drain(): Promise<void> {
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) return;
    }
  }

  it('GET /v1/timers lista com filtros status/instanceId', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth(),
      payload: { definitionRef: EXAMPLE_DEFINITION_REF, businessKey: 'tm-1' },
    });
    const id = started.json().id as string;
    await drain();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/timers?instanceId=${id}&status=armed`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({
      instanceId: id,
      elementId: 'reviewTimeout',
      status: 'armed',
    });
  });

  it('incidente de job failed: retry re-arma o job (auditado); resolution com motivo (auditado)', async () => {
    // esgota os retries de um job do skeleton pelo contrato público
    const started = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth(),
      payload: { businessKey: 'inc-1' },
    });
    const id = started.json().id as string;
    await drain();
    for (let i = 0; i < 4; i++) {
      const locks = await app.inject({
        method: 'POST',
        url: '/v1/jobs/locks',
        headers: auth(),
        payload: { workerId: 'w-op', limit: 50 },
      });
      const job = (locks.json().jobs as Array<{ id: string; instanceId: string; lockToken: string }>).find(
        (j) => j.instanceId === id,
      );
      if (!job) break;
      await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/failure`,
        headers: auth(),
        payload: { lockToken: job.lockToken, error: `boom ${i}` },
      });
    }
    await drain(); // o RaiseIncident do engine vira linha em incidents
    const [jobRow] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT status FROM jobs WHERE instance_id = ${id}`);
    expect(jobRow.status).toBe('failed');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/incidents?instanceId=${id}&status=open`,
      headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(1);
    const incident = list.json().items[0] as { id: string; kind: string };

    // retry: job volta a available com retries restaurados; incidente 'retried'
    const retry = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${incident.id}/retry`,
      headers: auth(),
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().rearmedJobs).toBe(1);
    const [rearmed] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT status, retries_left, error FROM jobs WHERE instance_id = ${id}`);
    expect(rearmed).toMatchObject({ status: 'available', retries_left: 3, error: null });
    const [auditRetry] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${id} AND kind = 'incidentRetried'`);
    expect(auditRetry.payload).toMatchObject({ actor: 'operador', rearmedJobs: 1 });

    // segundo retry do MESMO incidente: não está mais 'open' → 409
    const retryAgain = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${incident.id}/retry`,
      headers: auth(),
      payload: {},
    });
    expect(retryAgain.statusCode).toBe(409);

    // resolution manual de um novo incidente exige motivo e audita
    // (re-esgota o job para gerar outro incidente aberto)
    for (let i = 0; i < 4; i++) {
      const locks = await app.inject({
        method: 'POST',
        url: '/v1/jobs/locks',
        headers: auth(),
        payload: { workerId: 'w-op', limit: 50 },
      });
      const job = (locks.json().jobs as Array<{ id: string; instanceId: string; lockToken: string }>).find(
        (j) => j.instanceId === id,
      );
      if (!job) break;
      await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/failure`,
        headers: auth(),
        payload: { lockToken: job.lockToken, error: `boom-2-${i}` },
      });
    }
    await drain();
    const open = await app.inject({
      method: 'GET',
      url: `/v1/incidents?instanceId=${id}&status=open`,
      headers: auth(),
    });
    const second = open.json().items[0] as { id: string };
    const semMotivo = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${second.id}/resolution`,
      headers: auth(),
      payload: {},
    });
    expect(semMotivo.statusCode).toBe(400); // motivo obrigatório
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${second.id}/resolution`,
      headers: auth(),
      payload: { reason: 'falha de integração externa reconhecida' },
    });
    expect(resolved.statusCode).toBe(200);
    const [auditResolve] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${id} AND kind = 'incidentResolved'`);
    expect(auditResolve.payload).toMatchObject({
      actor: 'operador',
      reason: 'falha de integração externa reconhecida',
    });
  });
});
