import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, currentToken, currentUser, refresh, storedRefreshToken } from '../src/session.js';

/**
 * Rotação single-use torna refreshes paralelos fatais (o 2º apresentaria um
 * token já revogado). O contrato: 401s concorrentes compartilham UMA chamada
 * de rede, e o refresh token persistido é sempre o mais recente.
 */
const payload = (n: number) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresInSeconds: 900,
  user: { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'operator' },
});

beforeEach(() => {
  clearSession();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('session.refresh — single-flight + rotação', () => {
  it('sem refresh token guardado: retorna false sem tocar a rede', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await refresh()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes concorrentes disparam UMA requisição e ambos veem o novo token', async () => {
    sessionStorage.setItem('btv.refresh', 'refresh-0');
    let resolveFetch!: (v: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((res) => (resolveFetch = res)),
    );

    const a = refresh();
    const b = refresh();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // single-flight

    resolveFetch(new Response(JSON.stringify(payload(1)), { status: 200 }));
    expect(await Promise.all([a, b])).toEqual([true, true]);

    expect(currentToken()).toBe('access-1');
    expect(storedRefreshToken()).toBe('refresh-1'); // rotacionado e persistido
    expect(currentUser()?.displayName).toBe('Ana');
  });

  it('refresh rejeitado pelo servidor limpa a sessão', async () => {
    sessionStorage.setItem('btv.refresh', 'refresh-stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    expect(await refresh()).toBe(false);
    expect(currentToken()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
  });
});
