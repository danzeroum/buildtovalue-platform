import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createEnvKeyProvider,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
  EXAMPLE_DEFINITION_REF,
  isEncryptedField,
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

const CPF = '123.456.789-00';

/**
 * Leva 2 da esteira F3 (shape §4, ADENDO §3): máscara de sensitive na
 * listagem, reveal auditado com motivo obrigatório (decisão 10.c), PATCH
 * do operador cifrando na escrita, e cross-tenant = 404 (convenção §0).
 */
describe('variables — máscara, reveal auditado e PATCH (shape §4)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let tenantB: string;
  let token: string;
  let tokenB: string;
  let tokenBusiness: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('variables_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [a] = await migrator`INSERT INTO tenants (slug, name) VALUES ('va', 'VarA') RETURNING id`;
    const [b] = await migrator`INSERT INTO tenants (slug, name) VALUES ('vb', 'VarB') RETURNING id`;
    tenant = a.id as string;
    tenantB = b.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'op@va.test', ${await hashPassword('x')}, 'Op', 'admin')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, {
        keyProvider: createEnvKeyProvider('segredo-vars-e2e-ok'),
      }),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: token } = await signAccessToken({ sub: 'operador-ana', tenantId: tenant, role: 'admin' }, jwt));
    ({ accessToken: tokenB } = await signAccessToken({ sub: 'intruso', tenantId: tenantB, role: 'admin' }, jwt));
    ({ accessToken: tokenBusiness } = await signAccessToken({ sub: 'biz', tenantId: tenant, role: 'business' }, jwt));

    const started = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'vars-1',
        variables: { email: 'ana@titular.test' },
      },
    });
    expect(started.statusCode).toBe(201);
    instanceId = started.json().id as string;
    for (;;) {
      const r = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) break;
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('PATCH do operador cifra sensitive na escrita e audita SÓ os nomes', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/instances/${instanceId}/variables`,
      headers: auth(),
      payload: { set: { cpf: CPF, nota: 'aprovado com ressalva' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().updated.sort()).toEqual(['cpf', 'nota']);

    // em repouso: cifrada (classificação declarada pelo form do example@1)
    const [row] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT value, classification FROM variables
         WHERE instance_id = ${instanceId} AND name = 'cpf'`);
    expect(row.classification).toBe('sensitive');
    expect(isEncryptedField(row.value)).toBe(true);
    expect(JSON.stringify(row.value)).not.toContain(CPF);

    // auditoria: nomes SIM, valores NUNCA
    const [audit] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'variablesUpdated'`);
    expect(audit.payload).toMatchObject({ actor: 'operador-ana', names: ['cpf', 'nota'] });
    expect(JSON.stringify(audit.payload)).not.toContain(CPF);
  });

  it('GET lista com sensitive SEMPRE mascarada — o valor não existe no payload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/variables`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('cpf')).toMatchObject({ classification: 'sensitive', masked: true });
    expect(byName.get('cpf')).not.toHaveProperty('value');
    expect(byName.get('email')).toMatchObject({ classification: 'personal', value: 'ana@titular.test' });
    expect(res.body).not.toContain(CPF);
    expect(res.body).not.toContain('enc:v1:'); // nem o criptograma vaza
  });

  it('reveal: sem reason = 400; com reason revela, audita quem/qual/motivo; não-sensitive = 409', async () => {
    const semReason = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/variables/cpf/reveal`,
      headers: auth(),
      payload: {},
    });
    expect(semReason.statusCode).toBe(400);

    const revealed = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/variables/cpf/reveal`,
      headers: auth(),
      payload: { reason: 'verificação cadastral solicitada pelo titular' },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toEqual({ name: 'cpf', value: CPF });

    const [audit] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'sensitiveRevealed'`);
    expect(audit.payload).toMatchObject({
      name: 'cpf',
      actor: 'operador-ana',
      reason: 'verificação cadastral solicitada pelo titular',
    });
    expect(JSON.stringify(audit.payload)).not.toContain(CPF); // valor NUNCA

    const naoSensitive = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/variables/email/reveal`,
      headers: auth(),
      payload: { reason: 'x' },
    });
    expect(naoSensitive.statusCode).toBe(409);
  });

  it('RBAC: papel sem variables:reveal-sensitive = 403; cross-tenant = 404 SEMPRE', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/variables/cpf/reveal`,
      headers: { authorization: `Bearer ${tokenBusiness}` },
      payload: { reason: 'tentativa' },
    });
    expect(forbidden.statusCode).toBe(403);

    // outro tenant: a EXISTÊNCIA não vaza (convenção §0 — 404, nunca 403)
    const crossList = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/variables`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(crossList.statusCode).toBe(404);
    const crossReveal = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/variables/cpf/reveal`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { reason: 'x' },
    });
    expect(crossReveal.statusCode).toBe(404);
  });
});
