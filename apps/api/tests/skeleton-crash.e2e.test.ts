import { hashPassword, signAccessToken } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
  lockJobs,
  outboxDepth,
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
 * WALKING SKELETON — E2E + CRASH TEST (F1.8, evidência central do aceite):
 *
 *   start → serviceTask(noop) → end, com o ENGINE PUBLICADO pinado exato
 *   (@buildtovalue/engine@1.1.0-next.1 via npm — D5), 100 instâncias,
 *   worker morto nas DUAS janelas críticas, re-dispatch idempotente e
 *   ZERO efeito duplicado.
 *
 * Janela A (a variante da triagem): kill DEPOIS do commit do avanço e ANTES
 * do dispatch — o efeito sobrevive na outbox e é despachado exatamente uma
 * vez na retomada. Janela B: kill NO MEIO do lote do dispatcher — rollback
 * total, re-dispatch sem duplicata (UNIQUE effect_key + UNIQUE wait_key).
 * Fencing D12: lease expirada re-tomada por outro worker; token velho = 409
 * pelo CONTRATO PÚBLICO (D22).
 */
const N = 100;

describe('walking skeleton — 100 instâncias com crash e fencing (F1.8)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestDatabase('skeleton');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('skel', 'Skeleton') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'admin@skel.test', ${await hashPassword('x')}, 'Admin', 'admin')`;
    });
    await migrator.end();

    sql = createDb(db.apiUrl, { max: 6 });
    // config de teste (rate limit alto: o e2e faz ~350 requisições — o limite
    // de produção tem teste próprio); repositórios REAIS abaixo.
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
      { sub: 'admin', tenantId: tenant, role: 'admin' },
      { secret: deps.config.JWT_SECRET, accessTtlSeconds: 900 },
    ));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  it(`${N} instâncias completam com kill nas duas janelas e zero efeito duplicado`, async () => {
    const auth = { authorization: `Bearer ${token}` };
    const instanceIds: string[] = [];

    // -------- fase 1: start via API (avanço COMMITADO, dispatcher "morto")
    for (let i = 0; i < N; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/instances',
        headers: auth,
        payload: { businessKey: `bk-${i}` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('active');
      expect(body.revision).toBe(1); // StartInstance aplicado
      instanceIds.push(body.id);
    }
    // JANELA A: o worker morreu ANTES de qualquer dispatch. Os efeitos
    // (EmitHistory + CreateJob por instância) SOBREVIVEM na outbox.
    expect(await outboxDepth(sql, tenant)).toBe(N * 2);

    // -------- fase 2: retomada com re-dispatch idempotente (JANELA B no meio)
    let crashes = 0;
    let batches = 0;
    for (;;) {
      batches += 1;
      const injectCrash = batches % 4 === 2; // kill determinístico em lotes 2,6,10…
      try {
        const result = await dispatchOutboxOnce(sql, tenant, {
          batch: 10,
          onCrash: injectCrash
            ? (_row, index) => {
                if (index === 5) throw new Error('kill -9 no meio do lote');
              }
            : undefined,
        });
        if (result.processed === 0) break;
      } catch {
        crashes += 1; // worker morreu; o próximo loop é o "worker novo"
      }
      if (batches > 200) throw new Error('dispatch não convergiu');
    }
    expect(crashes).toBeGreaterThanOrEqual(2); // as mortes ACONTECERAM
    expect(await outboxDepth(sql, tenant)).toBe(0); // fila drenada
    const jobs = await withTenant(sql, tenant, (tx) => tx`SELECT id, status FROM jobs`);
    expect(jobs.length).toBe(N); // ZERO job duplicado sob re-dispatch

    // -------- fase 3: fencing D12 num job sacrificado, pelo CONTRATO público
    const [victim] = await lockJobs(sql, tenant, 'worker-a', { leaseMs: 60, limit: 1 });
    const staleToken = victim.lock_token!;
    await new Promise((r) => setTimeout(r, 90)); // worker A "morre"; lease expira
    const relocked = await lockJobs(sql, tenant, 'worker-b', { leaseMs: 30_000, limit: 50 });
    const victimAgain = relocked.find((j) => j.id === victim.id)!;
    expect(victimAgain.lock_token).not.toBe(staleToken);

    const late = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${victim.id}/complete`,
      headers: auth,
      payload: { lockToken: staleToken },
    });
    expect(late.statusCode).toBe(409); // token velho: recusado (fencing)
    expect(late.json().type).toContain('/problems/conflict');

    // -------- fase 4: conclui TODOS os jobs pelo contrato (handler fora de tx)
    const locked = new Map(relocked.map((j) => [j.id, j.lock_token!]));
    for (;;) {
      const more = await lockJobs(sql, tenant, 'worker-b', { leaseMs: 30_000, limit: 50 });
      if (more.length === 0) break;
      for (const job of more) locked.set(job.id, job.lock_token!);
    }
    expect(locked.size).toBe(N);
    for (const [jobId, lockToken] of locked) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/complete`,
        headers: auth,
        payload: { lockToken },
      });
      expect(res.statusCode).toBe(200);
    }
    // conclusão em dobro é recusada (exatamente-uma-vez no contrato)
    const [anyJob] = [...locked.entries()][0];
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${anyJob}/complete`,
      headers: auth,
      payload: { lockToken: locked.get(anyJob)! },
    });
    expect(replay.statusCode).toBe(409);

    // -------- fase 5: drena os efeitos terminais e verifica o mundo final
    for (;;) {
      const result = await dispatchOutboxOnce(sql, tenant, { batch: 50 });
      if (result.processed === 0) break;
    }
    expect(await outboxDepth(sql, tenant)).toBe(0);

    const finals = await withTenant(
      sql,
      tenant,
      (tx) => tx`SELECT status, revision FROM instances`,
    );
    expect(finals.length).toBe(N);
    for (const row of finals) {
      expect(row.status).toBe('completed');
      expect(row.revision).toBe(2); // StartInstance + JobCompleted — nada além
    }
    const jobStatuses = await withTenant(sql, tenant, (tx) => tx`SELECT status FROM jobs`);
    expect(jobStatuses.length).toBe(N);
    expect(jobStatuses.every((j) => j.status === 'completed')).toBe(true);

    // consulta pública confere (GET /v1/instances/:id)
    const sample = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceIds[0]}`,
      headers: auth,
    });
    expect(sample.json()).toMatchObject({ status: 'completed', revision: 2 });
  }, 120_000);
});
