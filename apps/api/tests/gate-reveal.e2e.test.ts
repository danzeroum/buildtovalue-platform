import { signAccessToken } from '@platform/auth';
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
 * AG-3.1 (PII do gate na API): o world-delta do gate SAI MASCARADO no detalhe da
 * tarefa (os VALORES sensíveis nunca vão ao cliente); revelar é rota própria,
 * AUDITADA + RBAC. Sem a permissão de revelar → 403 (o gancho do "aprovador sem
 * permissão → escalar": não aprovar às cegas).
 */
const PII_TO = 'ana-secreta@titular.test';
const PII_CORPO = 'conteudo-sensivel-999';

const WORLD_DELTA = {
  tool: 'tool:send-email@2.0.1',
  capability: 'enviar e-mail ao cliente',
  effect: 'external-commitment',
  authorization: 'gate',
  dataScope: 'pessoal',
  evidenceRequired: 'cópia enviada',
  params: { to: [PII_TO], corpo: PII_CORPO },
  processConsequence: null,
  paramsClassification: 'sensitive',
};

describe('gate world-delta na API — máscara no detalhe + reveal auditado/RBAC (AG-3.1)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string; // admin — tem variables:reveal-sensitive
  let tokenBusiness: string; // business — NÃO tem
  let gateTaskId: string;

  beforeAll(async () => {
    db = await createTestDatabase('gate_reveal_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [a] = await migrator`INSERT INTO tenants (slug, name) VALUES ('gr', 'GateReveal') RETURNING id`;
    tenant = a.id as string;
    // instância + tarefa de GATE com world-delta SENSÍVEL (inserção direta — o fio
    // de construção já é provado em gate-pii.test.ts; aqui prova-se a rota).
    await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      const [task] = await tx`
        INSERT INTO user_tasks (tenant_id, instance_id, element_id, wait_key, form_ref, candidate_roles, payload, is_gate)
        VALUES (${tenant}, ${inst.id}, 'gate', ${`w:${inst.id}:gate`}, '', '{}', ${tx.json(WORLD_DELTA as never)}, true)
        RETURNING id`;
      gateTaskId = task.id as string;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 4 });
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql, undefined, { keyProvider: createEnvKeyProvider('segredo-gate-e2e-ok') }),
      dbReady: async () => true,
    });
    await app.ready();
    const jwt = { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 };
    ({ accessToken: token } = await signAccessToken({ sub: 'aprovador', tenantId: tenant, role: 'admin' }, jwt));
    ({ accessToken: tokenBusiness } = await signAccessToken({ sub: 'biz', tenantId: tenant, role: 'business' }, jwt));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  it('GET detalhe: params sensíveis MASCARADOS (valor não sai); nomes+flag saem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/user-tasks/${gateTaskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paramsMasked).toBe(true);
    expect(body.paramsFields.sort()).toEqual(['corpo', 'to']); // nomes (estrutura)
    expect(body.payload.params).toEqual({}); // VALORES fora
    // dimensões não-PII seguem em claro
    expect(body.payload).toMatchObject({ tool: 'tool:send-email@2.0.1', effect: 'external-commitment' });
    // o PII NÃO aparece em lugar nenhum do corpo
    expect(res.body).not.toContain(PII_TO);
    expect(res.body).not.toContain(PII_CORPO);
  });

  it('reveal SEM reason → 400 (zod); COM reason → revela e AUDITA nomes (não o conteúdo)', async () => {
    const semReason = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${gateTaskId}/gate/reveal`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(semReason.statusCode).toBe(400);

    const revealed = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${gateTaskId}/gate/reveal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'preciso conferir os destinatários antes de aprovar' },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().params).toEqual({ to: [PII_TO], corpo: PII_CORPO });

    // auditoria: nomes SIM, conteúdo NUNCA
    const [ev] = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE kind = 'gateWorldDeltaRevealed'`);
    expect(ev.payload).toMatchObject({ gateId: 'gate', actor: 'aprovador', fields: ['to', 'corpo'] });
    expect(JSON.stringify(ev.payload)).not.toContain(PII_TO);
  });

  it('reveal SEM permissão (business) → 403 — o gancho do "escalar, não aprovar às cegas"', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/user-tasks/${gateTaskId}/gate/reveal`,
      headers: { authorization: `Bearer ${tokenBusiness}` },
      payload: { reason: 'quero ver' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
