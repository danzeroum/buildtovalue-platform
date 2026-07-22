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
 * Leva 1 da F3.1+ (shape §0/§3): list com cursor+filtros, história por seq,
 * export XES, currentElements e Idempotency-Key com replay da resposta
 * original.
 */
describe('instances — list/history/export/Idempotency-Key (shape §3)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestDatabase('instances_api');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ix', 'Instances') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'op@ix.test', ${await hashPassword('x')}, 'Op', 'admin')`;
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
      { sub: 'op', tenantId: tenant, role: 'admin' },
      { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function start(businessKey: string, definitionRef?: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: auth(),
      payload: { businessKey, ...(definitionRef ? { definitionRef } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function drain(): Promise<void> {
    for (;;) {
      const result = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (result.processed === 0 && result.failed === 0) return;
    }
  }

  it('lista com cursor + filtros; detalhe expõe currentElements', async () => {
    const a = await start('lote-a');
    const b = await start('lote-b');
    const c = await start('lote-c', EXAMPLE_DEFINITION_REF);
    await drain();

    // paginação: limit 2 → nextCursor → resto
    const page1 = await app.inject({ method: 'GET', url: '/v1/instances?limit=2', headers: auth() });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/instances?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: auth(),
    });
    const ids = [...body1.items, ...page2.json().items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([a, b, c]));

    // filtros
    const byKey = await app.inject({
      method: 'GET',
      url: '/v1/instances?businessKey=lote-b',
      headers: auth(),
    });
    expect(byKey.json().items.map((i: { id: string }) => i.id)).toEqual([b]);
    const active = await app.inject({
      method: 'GET',
      url: `/v1/instances?status=active&definitionRef=${EXAMPLE_DEFINITION_REF}`,
      headers: auth(),
    });
    expect(active.json().items.map((i: { id: string }) => i.id)).toEqual([c]);

    // currentElements: example@1 parada na user task 'review'
    const detail = await app.inject({ method: 'GET', url: `/v1/instances/${c}`, headers: auth() });
    expect(detail.json().currentElements).toEqual(['review']);
  });

  it('história por seq (cursor) e export XES minerável', async () => {
    const id = await start('hist-1');
    await drain();
    const hist = await app.inject({
      method: 'GET',
      url: `/v1/instances/${id}/history?limit=2`,
      headers: auth(),
    });
    expect(hist.statusCode).toBe(200);
    const first = hist.json();
    expect(first.items.map((e: { kind: string }) => e.kind)).toContain('instanceStarted');
    const seqs: number[] = first.items.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

    const xes = await app.inject({
      method: 'GET',
      url: `/v1/instances/${id}/export?format=xes`,
      headers: auth(),
    });
    expect(xes.statusCode).toBe(200);
    expect(xes.headers['content-type']).toContain('application/xml');
    expect(xes.body).toContain('<log xes.version="2.0"');
    expect(xes.body).toContain('concept:name" value="hist-1"');
    expect(xes.body).toContain('value="instanceStarted"');
  });

  it('Idempotency-Key: replay devolve a resposta ORIGINAL; corpo diferente = 409', async () => {
    const headers = { ...auth(), 'idempotency-key': 'k-2026-001' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers,
      payload: { businessKey: 'idem-1' },
    });
    expect(first.statusCode).toBe(201);
    const id = first.json().id as string;

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers,
      payload: { businessKey: 'idem-1' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(id); // NÃO cria segunda instância
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const count = await withTenant(sql, tenant, (tx) =>
      tx`SELECT count(*)::int AS n FROM instances WHERE business_key = 'idem-1'`);
    expect(count[0].n).toBe(1);

    const misuse = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers,
      payload: { businessKey: 'OUTRO-corpo' },
    });
    expect(misuse.statusCode).toBe(409);
    expect(misuse.json().type).toContain('/problems/conflict');
  });
});
