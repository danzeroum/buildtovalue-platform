import { hashPassword } from '@platform/auth';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { fakeDeps, type FakeState } from '../src/testing/fakes.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

async function seed(state: FakeState): Promise<void> {
  state.tenants.push({ id: TENANT_ID, slug: 'acme', name: 'ACME' });
  state.users.push({
    id: USER_ID,
    tenant_id: TENANT_ID,
    email: 'ana@acme.test',
    password_hash: await hashPassword('senha-forte-1'),
    display_name: 'Ana',
    role: 'analyst',
  });
}

describe('API /v1 (esqueleto F1)', () => {
  let app: FastifyInstance;
  let deps: ReturnType<typeof fakeDeps>;

  beforeAll(async () => {
    deps = fakeDeps();
    await seed(deps.state);
    app = await buildApp(deps);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health e /ready respondem', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.json()).toEqual({ status: 'ready', db: true });
  });

  it('/metrics expõe Prometheus', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http_requests_total');
  });

  it('rota inexistente responde problem+json 404 com requestId', async () => {
    const res = await app.inject({ method: 'GET', url: '/nada' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.type).toContain('/problems/not-found');
    expect(body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.requestId);
  });

  it('X-Request-Id do cliente é honrado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-do-cliente' },
    });
    expect(res.headers['x-request-id']).toBe('req-do-cliente');
  });

  it('validação zod → 400 problem+json nomeando o campo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'acme', email: 'não-é-email', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.type).toContain('/problems/validation');
    expect(body.detail).toContain('email');
  });

  it('login com credenciais corretas devolve par de tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'acme', email: 'ana@acme.test', password: 'senha-forte-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toMatch(new RegExp(`^${TENANT_ID}\\.`));
    expect(body.user).toMatchObject({ displayName: 'Ana', role: 'analyst' });
  });

  it('senha errada e tenant inexistente respondem 401 idênticos (sem enumeração)', async () => {
    const wrongPass = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'acme', email: 'ana@acme.test', password: 'errada!' },
    });
    const wrongTenant = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'nao-existe', email: 'ana@acme.test', password: 'senha-forte-1' },
    });
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongTenant.statusCode).toBe(401);
    expect(wrongPass.json().title).toBe(wrongTenant.json().title);
  });

  it('refresh rotaciona: o novo par funciona, o token usado morre', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'acme', email: 'ana@acme.test', password: 'senha-forte-1' },
    });
    const { refreshToken } = login.json();

    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().refreshToken).not.toBe(refreshToken);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('/v1/me exige Bearer e devolve o usuário do token', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.headers['content-type']).toContain('application/problem+json');

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'acme', email: 'ana@acme.test', password: 'senha-forte-1' },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: USER_ID, tenantId: TENANT_ID, role: 'analyst' });
  });

  it('token adulterado → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('OpenAPI é servido com as rotas /v1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/auth/login', '/v1/auth/refresh', '/v1/me']),
    );
  });
});

describe('rate limit por chave (config baixa)', () => {
  it('excedente responde 429 problem+json', async () => {
    const deps = fakeDeps({ RATE_LIMIT_MAX: 2 });
    await seed(deps.state);
    const app = await buildApp(deps);
    await app.ready();
    try {
      const results: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'GET', url: '/ready' });
        results.push(res.statusCode);
      }
      expect(results).toEqual([200, 200, 429]);
      const last = await app.inject({ method: 'GET', url: '/ready' });
      expect(last.json().type).toContain('/problems/rate-limited');
    } finally {
      await app.close();
    }
  });
});
