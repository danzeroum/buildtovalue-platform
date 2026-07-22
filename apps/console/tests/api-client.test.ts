import { beforeEach, describe, expect, it, vi } from 'vitest';

// A sessão é dublê: o teste isola o MIDDLEWARE de auth (anexa Bearer; 401 faz
// refresh+retry uma vez; 403 nunca faz refresh). Exercitamos onRequest/
// onResponse direto — o construtor de URL do openapi-fetch exige URL absoluta,
// que só o fetch do navegador resolve a partir de baseUrl relativa; aqui o que
// importa é a REGRA, não a montagem da URL.
vi.mock('../src/session.js', () => ({
  currentToken: vi.fn(() => 'access-tok'),
  refresh: vi.fn(),
  clearSession: vi.fn(),
}));

import { authMiddleware } from '../src/api/client.js';
import { clearSession, currentToken, refresh } from '../src/session.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onRequest = (request: Request) => authMiddleware.onRequest!({ request } as any);
const onResponse = (request: Request, response: Response) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authMiddleware.onResponse!({ request, response } as any);

const url = 'http://api.local/v1/user-tasks';
const authUrl = 'http://api.local/v1/auth/refresh';

beforeEach(() => {
  vi.mocked(currentToken).mockReturnValue('access-tok');
  vi.mocked(refresh).mockResolvedValue(true);
  vi.mocked(clearSession).mockReset();
});

describe('authMiddleware', () => {
  it('onRequest anexa Authorization: Bearer', async () => {
    const req = new Request(url);
    const out = (await onRequest(req)) as Request;
    expect(out.headers.get('Authorization')).toBe('Bearer access-tok');
  });

  it('401 (não-auth): faz refresh e re-tenta UMA vez', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: true }));
    const out = (await onResponse(new Request(url), json(401, { type: '/problems/unauthorized' }))) as Response;

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // o retry
    expect(out.status).toBe(200);
  });

  it('403 (RBAC): NUNCA faz refresh nem retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = json(403, { type: '/problems/forbidden' });
    const out = await onResponse(new Request(url), res);

    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toBe(res);
  });

  it('401 em endpoint /v1/auth/ não dispara refresh (evita laço)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await onResponse(new Request(authUrl), json(401, {}));
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401 com refresh falho limpa a sessão e não re-tenta', async () => {
    vi.mocked(refresh).mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = json(401, {});
    const out = await onResponse(new Request(url), res);

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toBe(res);
  });
});
