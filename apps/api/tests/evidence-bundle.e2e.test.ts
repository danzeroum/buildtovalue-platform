import { signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * P7 (Evidence Bundle, AG-3.6, shape `ag3-6-shape-proposta-p7-evidence-bundle.md`):
 * rota FINA escopada sob `operate:read`, nunca `audit:export` — o operador vê a
 * evidência da instância que já pode ver, nunca a trilha inteira do tenant.
 */
describe('GET /v1/instances/:id/evidence-bundle (P7, AG-3.6)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let operatorToken: string;
  let businessToken: string;
  let adminToken: string;

  beforeAll(async () => {
    db = await createTestDatabase('evidence_bundle_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('evb', 'EvB') RETURNING id`;
    tenant = t.id as string;
    const operatorId = await seedTestUser(migrator, tenant, { email: 'op@evb.test', displayName: 'Op', role: 'operator' });
    const businessId = await seedTestUser(migrator, tenant, { email: 'biz@evb.test', displayName: 'Biz', role: 'business' });
    const adminId = await seedTestUser(migrator, tenant, { email: 'admin@evb.test', displayName: 'Admin', role: 'admin' });
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
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: operatorToken } = await signAccessToken({ sub: operatorId, tenantId: tenant, role: 'operator', sid: 'test' }, jwt));
    ({ accessToken: businessToken } = await signAccessToken({ sub: businessId, tenantId: tenant, role: 'business', sid: 'test' }, jwt));
    ({ accessToken: adminToken } = await signAccessToken({ sub: adminId, tenantId: tenant, role: 'admin', sid: 'test' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  async function startAndDrain(businessKey: string, token: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: bearer(token),
      payload: { businessKey },
    });
    expect(res.statusCode).toBe(201);
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) break;
    }
    return res.json().id as string;
  }

  it('operator (operate:read) vê o recibo escopado a ESTA instância — digest, âncora, cobertura', async () => {
    const id = await startAndDrain('evb-1', adminToken);
    const res = await app.inject({ method: 'GET', url: `/v1/instances/${id}/evidence-bundle`, headers: bearer(operatorToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receipt.assurance).toBe('self-recorded');
    expect(body.receipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.every((r: { resourceType: string; resourceId: string }) => r.resourceType === 'instance' && r.resourceId === id)).toBe(true);
  });

  it('a instância B não vaza na evidência da instância A (filtro travado, não decorativo)', async () => {
    const a = await startAndDrain('evb-a', adminToken);
    const b = await startAndDrain('evb-b', adminToken);
    const res = await app.inject({ method: 'GET', url: `/v1/instances/${a}/evidence-bundle`, headers: bearer(operatorToken) });
    expect(res.statusCode).toBe(200);
    const ids = new Set(res.json().records.map((r: { resourceId: string }) => r.resourceId));
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(false);
  });

  it('business (sem operate:read) → 403; instância inexistente → 404', async () => {
    const id = await startAndDrain('evb-2', adminToken);
    const forbidden = await app.inject({ method: 'GET', url: `/v1/instances/${id}/evidence-bundle`, headers: bearer(businessToken) });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/instances/00000000-0000-0000-0000-000000000000/evidence-bundle',
      headers: bearer(operatorToken),
    });
    expect(missing.statusCode).toBe(404);
  });
});
