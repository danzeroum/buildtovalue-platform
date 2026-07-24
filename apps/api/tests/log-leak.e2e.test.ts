import { Writable } from 'node:stream';
import { hashPassword } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  dispatchOutboxOnce,
  effectKey,
  insertEffects,
  withTenant,
} from '@platform/db';
import { createLogger } from '@platform/observability';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/tests/helpers.js';
import { createHandlerRegistry } from '../../worker/src/handlers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * LEAK-FAIL DE LOG — Gate de Piloto 8.4 (redaction personal/sensitive em log,
 * COM TESTE AUTOMATIZADO por TODOS os caminhos: api · dispatcher · worker/handlers).
 *
 * Diferente do teste de unidade da redaction (`packages/observability` prova que
 * os CAMINHOS whitelistados são redigidos), este dirige DADOS SENSÍVEIS por
 * FLUXOS REAIS e FALHA se um valor pessoal/sensível aparecer em CLARO na saída
 * estruturada — a acidez do "ledger sem conteúdo pessoal" da F2, agora sobre LOG.
 *
 * Os três serviços compartilham o MESMO `createLogger` (mesma REDACT_PATHS): o
 * risco real não é a config, é um CALL-SITE extrair PII do container redigido e
 * logá-la sob chave não-redigida. (Foi o caso do `send-email`, corrigido junto.)
 */

// Sentinelas: se QUALQUER uma aparecer em claro num log, o teste falha.
const LEAK = {
  password: 'senha-NUNCA-em-log-9x7z',
  cpf: '111.222.333-44',
  email: 'vitima@leak.test',
  biz: 'segredo-de-negocio-42',
  webhookSecret: 'hmac-secret-NUNCA-logar',
  url: 'https://interno.secreto.example/rota-privada',
};

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

/** ACIDEZ: nenhuma sentinela em claro; e a redaction ESTÁ ativa (não é ausência
 * por log desligado) — a marca [REDACTED] tem de aparecer no controle positivo. */
function expectNoLeak(lines: string[], values: string[]): void {
  const out = lines.join('');
  for (const v of values) {
    expect(out, `valor sensível vazou em log: ${v}`).not.toContain(v);
  }
}

describe('leak-fail de log (Gate 8.4) — sensível nunca em claro', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('log_leak');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('leak', 'Leak') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'ana@leak.test', ${await hashPassword(LEAK.password)}, 'Ana', 'admin')`;
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = inst.id as string;
    });
    await migrator.end();
    sql = createDb(db.apiUrl, { max: 4 });
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  it('API: login/authed/start com dados sensíveis não vazam no log de request', async () => {
    const { lines, stream } = capture();
    // NODE_ENV != test → o request-logging do fastify LIGA; logger real (redaction real).
    const deps = fakeDeps({ NODE_ENV: 'development', LOG_LEVEL: 'info', RATE_LIMIT_MAX: 100_000 });
    const app: ZodApp = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime: createRuntime(sql),
      logger: createLogger({ service: 'api', destination: stream, level: 'info' }),
      dbReady: async () => true,
    });
    await app.ready();
    try {
      // login: senha no CORPO (o request-logging loga req/res, nunca o corpo)
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { tenant: 'leak', email: 'ana@leak.test', password: LEAK.password },
      });
      expect(login.statusCode).toBe(200);
      const token = login.json().accessToken as string;

      // request autenticado: Authorization é caminho redigido
      await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });

      // start de instância com VARIÁVEIS sensíveis (variables é redigido por inteiro)
      await app.inject({
        method: 'POST',
        url: '/v1/instances',
        headers: { authorization: `Bearer ${token}` },
        payload: { definitionRef: 'skeleton@1', variables: { cpf: LEAK.cpf, email: LEAK.email } },
      });

      expect(lines.length, 'request-logging precisa estar ligado (senão o teste é vazio)').toBeGreaterThan(0);
      expectNoLeak(lines, [LEAK.password, LEAK.cpf, LEAK.email, token]);
    } finally {
      await app.close();
    }
  });

  it('DISPATCHER: efeito com payload sensível — só o TIPO do efeito vai ao log', async () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'worker', destination: stream, level: 'debug' });
    // dreno efeitos que outros testes deixaram na outbox (determinismo do count)
    await dispatchOutboxOnce(sql, tenant);
    // efeito CreateJob carregando PII no payload (destinatário, cpf, segredo)
    const key = effectKey(instanceId, 7, 0, 'CreateJob');
    await withTenant(sql, tenant, (tx) =>
      insertEffects(tx, tenant, instanceId, [
        {
          effectKey: key,
          effect: {
            type: 'CreateJob',
            jobType: 'noop',
            waitKey: 'wk-leak-disp',
            payload: { to: LEAK.email, cpf: LEAK.cpf, secret: LEAK.webhookSecret },
          } as never,
        },
      ]),
    );
    // dispatcher REAL + os DOIS logs que o worker emite (onInfo + resultado)
    const dispatched = await dispatchOutboxOnce(sql, tenant, {
      onInfo: (row) => logger.debug({ effect: row.effect.type }, 'efeito informativo'),
    });
    logger.info({ tenantId: tenant, ...dispatched }, 'outbox despachada');
    expect(dispatched.processed).toBe(1);
    expectNoLeak(lines, [LEAK.email, LEAK.cpf, LEAK.webhookSecret]);
  });

  it('WORKER/HANDLERS: send-email/http-call/webhook não vazam PII do payload', async () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'worker', destination: stream, level: 'debug' });
    // o worker liga o `log` do registry ao logger real (main.ts:46)
    const registry = createHandlerRegistry({
      log: (message, fields) => logger.info(fields ?? {}, message),
      // http-call/webhook não saem de verdade; só provamos que não LOGAM o alvo
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    const base = { instanceId: 'i1', tenantId: tenant };
    // send-email: ANTES logava `to` (o e-mail) em claro — agora `hasRecipient`
    await registry.run({ ...base, jobId: 'j1', type: 'send-email', payload: { to: LEAK.email, cpf: LEAK.cpf } });
    // http-call: URL secreta + corpo com PII
    await registry.run({ ...base, jobId: 'j2', type: 'http-call', payload: { url: LEAK.url, body: { cpf: LEAK.cpf } } });
    // webhook: URL + data com e-mail + secret HMAC
    await registry.run({
      ...base,
      jobId: 'j3',
      type: 'webhook',
      payload: { url: LEAK.url, data: { email: LEAK.email }, secret: LEAK.webhookSecret },
    });
    expectNoLeak(lines, [LEAK.email, LEAK.cpf, LEAK.webhookSecret, LEAK.url]);
    // o send-email registra a INTENÇÃO sem o dado (sinal de ops, não PII)
    expect(lines.join('')).toContain('hasRecipient');
  });

  it('CONTROLE POSITIVO: a redaction está ATIVA (marca [REDACTED], não silêncio)', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'test', destination: stream, level: 'info' });
    logger.info(
      { password: LEAK.password, user: { email: LEAK.email }, submission: { cpf: LEAK.cpf } },
      'controle',
    );
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expectNoLeak(lines, [LEAK.password, LEAK.email, LEAK.cpf]);
  });
});
