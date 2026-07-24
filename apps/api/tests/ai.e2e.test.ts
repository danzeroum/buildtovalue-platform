import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createEnvKeyProvider,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  withTenant,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * AG-3.2 (P4 — inteligência do tenant + kill-switch) na API. Aceites nomeados:
 *  - motivo obrigatório NAS DUAS DIREÇÕES (pausar e retomar);
 *  - a CHAVE nunca volta (só o ponteiro secret://);
 *  - LEITURA AMPLA × ESCRITA ESTREITA (operator lê o fato, não aciona/configura);
 *  - FATO sem RAZÃO na rota ampla (a razão é reservada ao admin);
 *  - AUDITOR lê a config (evidência de binding) mas 403 ao ACIONAR (read × operate).
 */
const KEY_REF = 'secret://kms/acme/deepseek';
const INCIDENT_REASON = 'suspeita de vazamento no fornecedor X';

describe('AG-3.2 · rotas de inteligência + kill-switch', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let adminTok: string;
  let operatorTok: string;
  let auditorTok: string;
  let realAdminId: string;
  let realAdminTok: string;

  beforeAll(async () => {
    db = await createTestDatabase('ai_routes');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ai', 'AiCo') RETURNING id`;
    tenant = t.id as string;
    // config existente (o kill-switch exige linha; o keyRef é PONTEIRO, nunca a chave)
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO tenant_ai_config (tenant_id, provider, model, key_ref)
               VALUES (${tenant}, 'openai-compatible', 'deepseek-chat', ${KEY_REF})`;
      // usuário REAL (G-UX-3: o banner precisa do NOME, não do id cru) — a
      // resolução server-side (users.findById) depende de uma linha existir.
      const [u] = await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'ana@aico.test', ${await hashPassword('x')}, 'Ana Ruiz', 'admin') RETURNING id`;
      realAdminId = u.id as string;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, { keyProvider: createEnvKeyProvider('segredo-ai-e2e-ok-16+') }),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: adminTok } = await signAccessToken({ sub: 'admin', tenantId: tenant, role: 'admin' }, jwt));
    ({ accessToken: operatorTok } = await signAccessToken({ sub: 'op', tenantId: tenant, role: 'operator' }, jwt));
    ({ accessToken: auditorTok } = await signAccessToken({ sub: 'aud', tenantId: tenant, role: 'auditor' }, jwt));
    ({ accessToken: realAdminTok } = await signAccessToken({ sub: realAdminId, tenantId: tenant, role: 'admin' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it('motivo OBRIGATÓRIO nas duas direções (pausar e retomar) — 400 sem motivo', async () => {
    for (const paused of [true, false]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/ai/kill-switch',
        headers: bearer(adminTok),
        payload: { paused }, // sem reason
      });
      expect(res.statusCode).toBe(400); // zod barra o corpo
    }
  });

  it('admin ACIONA com motivo → 200; o FATO na rota ampla NÃO carrega a razão', async () => {
    const on = await app.inject({
      method: 'POST',
      url: '/v1/ai/kill-switch',
      headers: bearer(adminTok),
      payload: { paused: true, reason: INCIDENT_REASON },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ state: 'paused', by: { type: 'user', id: 'admin' } });
    // o eco do POST também não devolve a razão
    expect(on.body).not.toContain('vazamento');
    // degrade honesto: 'admin' é um sub SINTÉTICO (sem linha em `users`) — o
    // resolvedor de nome nunca derruba a resposta, só devolve displayName null.
    expect(on.json().by.displayName).toBeNull();

    // rota AMPLA (operator): vê o FATO (estado/ator/quando), NUNCA a razão
    const fato = await app.inject({ method: 'GET', url: '/v1/ai/kill-switch', headers: bearer(operatorTok) });
    expect(fato.statusCode).toBe(200);
    const body = fato.json();
    expect(body).toMatchObject({ state: 'paused', by: { type: 'user', id: 'admin' } });
    expect(body.since).toBeTruthy();
    expect('reason' in body).toBe(false);
    expect(fato.body).not.toContain('vazamento');
  });

  it('LEITURA AMPLA × ESCRITA ESTREITA: operator lê o fato, mas 403 em acionar/configurar/ler-config', async () => {
    // lê o fato: OK
    expect((await app.inject({ method: 'GET', url: '/v1/ai/kill-switch', headers: bearer(operatorTok) })).statusCode).toBe(200);
    // aciona: 403
    expect(
      (await app.inject({ method: 'POST', url: '/v1/ai/kill-switch', headers: bearer(operatorTok), payload: { paused: false, reason: 'x' } })).statusCode,
    ).toBe(403);
    // configura: 403
    expect(
      (await app.inject({ method: 'PUT', url: '/v1/ai/config', headers: bearer(operatorTok), payload: { provider: 'anthropic', model: 'c', keyRef: KEY_REF, reason: 'x' } })).statusCode,
    ).toBe(403);
    // lê a config (nível 2): 403 — operator não tem ai:read-config
    expect((await app.inject({ method: 'GET', url: '/v1/ai/config', headers: bearer(operatorTok) })).statusCode).toBe(403);
  });

  it('a CHAVE nunca volta: GET config (admin) traz o PONTEIRO secret://, nunca o segredo', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ai/config', headers: bearer(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keyRef).toBe(KEY_REF); // ponteiro
    expect(body.keyConfigured).toBe(true);
    // nenhum campo de chave crua na resposta
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('key');
    expect(res.body).not.toMatch(/sk-[a-z0-9]/i); // nada com cara de chave
    // admin (ai:configure) VÊ a razão do kill-switch (nível 2)
    expect(body.killSwitch).toMatchObject({ state: 'paused', reason: INCIDENT_REASON });
  });

  it('AUDITOR lê a config (evidência de binding, sem a razão) mas 403 ao ACIONAR o kill-switch', async () => {
    const cfg = await app.inject({ method: 'GET', url: '/v1/ai/config', headers: bearer(auditorTok) });
    expect(cfg.statusCode).toBe(200);
    const body = cfg.json();
    // vê provider/model/base_url/keyRef ponteiro
    expect(body).toMatchObject({ provider: 'openai-compatible', model: 'deepseek-chat', keyRef: KEY_REF });
    // mas a RAZÃO (nível 2) é reservada — auditor a vê como null, mesmo pausado
    expect(body.killSwitch.state).toBe('paused');
    expect(body.killSwitch.reason).toBeNull();
    expect(cfg.body).not.toContain('vazamento');
    // e NÃO aciona nada: 403 (separação read × operate do papel)
    const act = await app.inject({
      method: 'POST',
      url: '/v1/ai/kill-switch',
      headers: bearer(auditorTok),
      payload: { paused: false, reason: 'auditor tentando' },
    });
    expect(act.statusCode).toBe(403);
  });

  it('admin CONFIGURA (motivo + fx por tenant) → 200, ponteiro de volta; keyRef não-secret → 422', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/v1/ai/config',
      headers: bearer(adminTok),
      payload: { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/acme/anthropic', fxUsdBrl: 5.3, reason: 'troca de provedor' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ provider: 'anthropic', fxUsdBrl: 5.3, keyConfigured: true });

    // keyRef em CLARO (não secret://) → 422 (validação de domínio, D29)
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/ai/config',
      headers: bearer(adminTok),
      payload: { provider: 'anthropic', model: 'claude', keyRef: 'sk-plaintext-danger', reason: 'x' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain('sk-plaintext-danger'); // nem no erro a chave vaza de volta
  });

  it('G-UX-3 (banner): ator REAL resolve para o NOME de exibição (não o id cru)', async () => {
    const on = await app.inject({
      method: 'POST',
      url: '/v1/ai/kill-switch',
      headers: bearer(realAdminTok),
      payload: { paused: true, reason: 'teste de nome de exibição' },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({
      state: 'paused',
      by: { type: 'user', id: realAdminId, displayName: 'Ana Ruiz' },
    });

    // o FATO amplo (o que o banner consome) resolve o MESMO nome — não só o eco do POST.
    const fato = await app.inject({ method: 'GET', url: '/v1/ai/kill-switch', headers: bearer(operatorTok) });
    expect(fato.statusCode).toBe(200);
    expect(fato.json().by).toMatchObject({ id: realAdminId, displayName: 'Ana Ruiz' });
  });
});
