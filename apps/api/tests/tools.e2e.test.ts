import { signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  deployToolDefinition,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * AG-3.4 (P5 — catálogo de tools por tenant, shape `ag3-4-shape-proposta-p5-tools.md`).
 * Aceite nomeado 4 (RBAC): `tools:read` admin+auditor; `tools:configure` só admin.
 * O único campo editável é `enabled` — `effect`/`authorization`/`requiresGate`
 * NUNCA são aceitos no corpo (422 explícito, nunca aceitar-e-descartar). Uma
 * tool `proibida` nunca liga (422, D31 — invariante da plataforma).
 */
const sendEmail = {
  kind: 'ToolContract', id: 'tool:send-email', version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: 'contato-cliente', authorization: 'gate',
  evidenceRequired: 'nenhuma', simulation: 'fixture-obrigatoria',
} as const;

const forbiddenTool = {
  kind: 'ToolContract', id: 'tool:apagar-tudo', version: '1.0.0', name: 'apagar_tudo',
  capability: 'apagar dados do tenant', inputSchema: {}, outputSchema: {},
  effect: 'write-irreversible', dataScope: 'tudo', authorization: 'proibida',
  evidenceRequired: 'nenhuma', simulation: 'fixture-obrigatoria',
} as const;

describe('AG-3.4 (P5) · rotas do catálogo de tools por tenant', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let adminTok: string;
  let auditorTok: string;
  let operatorTok: string;

  beforeAll(async () => {
    db = await createTestDatabase('tools_routes');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('tl', 'ToolCo') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    await deployToolDefinition(sql, tenant, { contract: sendEmail });
    await deployToolDefinition(sql, tenant, { contract: forbiddenTool });

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
    ({ accessToken: adminTok } = await signAccessToken({ sub: 'admin', tenantId: tenant, role: 'admin' }, jwt));
    ({ accessToken: auditorTok } = await signAccessToken({ sub: 'aud', tenantId: tenant, role: 'auditor' }, jwt));
    ({ accessToken: operatorTok } = await signAccessToken({ sub: 'op', tenantId: tenant, role: 'operator' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it('catálogo: enabled:false HONESTO sem linha em tenant_tools (nunca erro); requiresGate computado ao vivo', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(adminTok) });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const email = items.find((i) => i.toolId === 'tool:send-email')!;
    expect(email).toMatchObject({
      ref: 'tool:send-email@2.0.1', effect: 'external-commitment', authorization: 'gate',
      enabled: false, requiresGate: true,
    });
  });

  it('RBAC: auditor LÊ o catálogo (evidência) mas 403 ao configurar; operator não lê nem configura', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(auditorTok) })).statusCode).toBe(200);
    expect(
      (await app.inject({
        method: 'PATCH', url: '/v1/tools/tool:send-email', headers: bearer(auditorTok),
        payload: { enabled: true, reason: 'auditor tentando' },
      })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(operatorTok) })).statusCode).toBe(403);
  });

  it('admin LIGA com motivo → 200, catálogo reflete enabled:true', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tools/tool:send-email', headers: bearer(adminTok),
      payload: { enabled: true, reason: 'integração validada pelo time de segurança' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ toolId: 'tool:send-email', enabled: true, effect: 'external-commitment', authorization: 'gate' });

    const cat = await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(adminTok) });
    const items = cat.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.toolId === 'tool:send-email')).toMatchObject({ enabled: true });
  });

  it('motivo OBRIGATÓRIO nas duas direções — 400 sem reason (ligar e desligar)', async () => {
    for (const enabled of [true, false]) {
      const res = await app.inject({
        method: 'PATCH', url: '/v1/tools/tool:send-email', headers: bearer(adminTok),
        payload: { enabled },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('422 EXPLÍCITO ao enviar effect/authorization/requiresGate — nunca aceitar e descartar', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tools/tool:send-email', headers: bearer(adminTok),
      payload: { enabled: true, reason: 'x', authorization: 'automatica' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('authorization');
    // e a authorization REAL não mudou (D31 — o contrato é imutável)
    const cat = await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(adminTok) });
    const items = cat.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.toolId === 'tool:send-email')).toMatchObject({ authorization: 'gate' });
  });

  it("D31: ligar tool 'proibida' → 422 (invariante da plataforma, não decisão de tenant)", async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tools/tool:apagar-tudo', headers: bearer(adminTok),
      payload: { enabled: true, reason: 'preciso mesmo assim' },
    });
    expect(res.statusCode).toBe(422);
    const cat = await app.inject({ method: 'GET', url: '/v1/tools', headers: bearer(adminTok) });
    const items = cat.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.toolId === 'tool:apagar-tudo')).toMatchObject({ enabled: false, authorization: 'proibida' });
  });

  it('404 honesto para toolId inexistente', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tools/tool:fantasma', headers: bearer(adminTok),
      payload: { enabled: true, reason: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
