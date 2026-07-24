import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRegistry,
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
 * AG-2.3 — export de auditoria pela PORTA REAL (rota /v1). Prova o contrato do
 * shape aprovado: o papel `auditor` EXPORTA (JSON no corpo, CSV no header), a
 * verificação casa/diverge honestamente, e — [D] — o auditor NÃO ESCREVE NADA
 * (403 em toda rota de escrita: separação de deveres).
 */
describe('audit export/verify via /v1 + auditor não escreve nada (D)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let instanceId: string;
  let auditorToken: string;
  let adminToken: string;
  let jwtSecret: string;

  beforeAll(async () => {
    db = await createTestDatabase('audit_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('aud', 'Aud') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'aud@aud.test', ${await hashPassword('x')}, 'Aud', 'auditor')`;
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'proc@1', '1.1.0', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = inst.id as string;
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
        VALUES (${tenant}, ${instanceId}, 700010, 'agent:acao',
                ${tx.json({ actor: { type: 'agent', id: 'ag:1', requestId: 'r1' } })}, '1.1.0', ${'k1:' + instanceId})`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    jwtSecret = deps.config.JWT_SECRET;
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql),
      registry: createRegistry(sql, 'test'),
      dbReady: async () => true,
    });
    await app.ready();
    ({ accessToken: auditorToken } = await signAccessToken(
      { sub: 'aud', tenantId: tenant, role: 'auditor' },
      { secret: jwtSecret, accessTtlSeconds: 900 },
    ));
    ({ accessToken: adminToken } = await signAccessToken(
      { sub: 'admin', tenantId: tenant, role: 'admin' },
      { secret: jwtSecret, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it('auditor exporta em JSON: recibo no CORPO + registros', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit/export', headers: bearer(auditorToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receipt.assurance).toBe('self-recorded');
    expect(body.receipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.some((r: { eventType: string }) => r.eventType === 'agent:acao')).toBe(true);
  });

  it('auditor exporta em CSV: recibo no HEADER X-Audit-Receipt, corpo verbatim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?format=csv',
      headers: bearer(auditorToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    // corpo é CSV cru (não JSON com aspas): começa pelo header de colunas
    expect(res.body.startsWith('source,at,actor_type,actor_id,actor_request_id')).toBe(true);
    // o recibo viaja no header, parseável
    const receipt = JSON.parse(String(res.headers['x-audit-receipt']));
    expect(receipt.digest).toMatch(/^sha256:/);
  });

  it('verify casa (matches:true) e diverge (matches:false) — 200 nos dois', async () => {
    const exp = await app.inject({ method: 'GET', url: '/v1/audit/export', headers: bearer(auditorToken) });
    const { receipt } = exp.json();

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/audit/verify',
      headers: bearer(auditorToken),
      payload: { expectedDigest: receipt.digest, filters: receipt.filters },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().matches).toBe(true);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/audit/verify',
      headers: bearer(auditorToken),
      payload: { expectedDigest: 'sha256:' + '0'.repeat(64), filters: receipt.filters },
    });
    expect(bad.statusCode).toBe(200); // honesto, não erro
    expect(bad.json().matches).toBe(false);
  });

  it('admin também exporta (audit:export concedida a admin)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit/export', headers: bearer(adminToken) });
    expect(res.statusCode).toBe(200);
  });

  it('[D] auditor NÃO ESCREVE NADA — 403 em toda rota de escrita', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111'; // v4 válido (passa params.uuid)
    // Corpos VÁLIDOS de propósito: a validação de schema roda ANTES do preHandler;
    // com corpo válido, o 403 é a NEGAÇÃO DE PERMISSÃO honesta (não um 400 de forma).
    const writes: Array<{ method: 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'POST', url: '/v1/instances', payload: { definitionRef: 'proc@1' } },
      { method: 'POST', url: `/v1/instances/${uuid}/cancellation`, payload: { reason: 'motivo' } },
      { method: 'POST', url: '/v1/process-definitions', payload: { name: 'p', diagram: {} } },
      { method: 'POST', url: '/v1/form-definitions', payload: { formId: 'f', schema: {} } },
      { method: 'PATCH', url: `/v1/instances/${uuid}/variables`, payload: { set: { a: 1 } } },
      { method: 'POST', url: `/v1/instances/${uuid}/variables/x/reveal`, payload: { reason: 'motivo' } },
      { method: 'POST', url: `/v1/user-tasks/${uuid}/claim` },
      { method: 'POST', url: `/v1/user-tasks/${uuid}/completion`, payload: { claimToken: uuid, submission: {} } },
      { method: 'POST', url: `/v1/user-tasks/${uuid}/assignment`, payload: { assignee: 'x', reason: 'y' } },
      { method: 'POST', url: `/v1/incidents/${uuid}/retry` },
      { method: 'POST', url: `/v1/incidents/${uuid}/resolution`, payload: { reason: 'y' } },
      { method: 'POST', url: '/v1/agents/resume', payload: { pauseKind: 'budget', motivo: 'x' } },
      {
        method: 'POST',
        url: '/v1/agents/reproposta',
        payload: { instanceId: uuid, elementId: 'Gate_1', motivo: 'x' },
      },
    ];
    for (const w of writes) {
      const res = await app.inject({
        method: w.method,
        url: w.url,
        headers: bearer(auditorToken),
        payload: w.payload ?? {}, // corpo válido/vazio; rotas sem schema de body ignoram
      });
      expect(res.statusCode, `${w.method} ${w.url} deveria ser 403 para auditor`).toBe(403);
    }
  });

  it('sem audit:export (ex.: operator) → 403 no export', async () => {
    const { accessToken: opTok } = await signAccessToken(
      { sub: 'op', tenantId: tenant, role: 'operator' },
      { secret: jwtSecret, accessTtlSeconds: 900 },
    );
    const res = await app.inject({ method: 'GET', url: '/v1/audit/export', headers: bearer(opTok) });
    expect(res.statusCode).toBe(403);
  });
});
