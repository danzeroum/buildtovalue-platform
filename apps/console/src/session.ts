import type { components } from './api/generated/schema.js';

/**
 * Sessão do console (F3.1): o access token vive EM MEMÓRIA (nunca cookie —
 * a API é stateless nele); o refresh token é o segredo de vida longa e ROTA a
 * cada uso (single-use) — persistido no sessionStorage por aba, sobrescrito
 * em todo refresh. Sem token no localStorage por padrão (superfície menor).
 */
export type Role = 'admin' | 'analyst' | 'business' | 'operator';
export interface SessionUser {
  id: string;
  displayName: string;
  email: string;
  role: Role;
}

type LoginBody = components['schemas']['LoginRequest'] extends never
  ? { tenant: string; email: string; password: string }
  : { tenant: string; email: string; password: string };

interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: SessionUser;
}

const REFRESH_KEY = 'btv.refresh';

let accessToken: string | null = null;
let user: SessionUser | null = null;
let refreshInFlight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentToken(): string | null {
  return accessToken;
}
export function currentUser(): SessionUser | null {
  return user;
}
export function storedRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function apply(payload: AuthPayload): void {
  accessToken = payload.accessToken;
  user = payload.user;
  try {
    sessionStorage.setItem(REFRESH_KEY, payload.refreshToken);
  } catch {
    /* storage indisponível: sessão vive só na aba/memória */
  }
  notify();
}

export function clearSession(): void {
  accessToken = null;
  user = null;
  try {
    sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    /* noop */
  }
  notify();
}

/** POST /v1/auth/login. Lança com a mensagem do problem+json em falha. */
export async function login(body: LoginBody): Promise<void> {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new Error(problem.detail ?? problem.title ?? 'Falha no login');
  }
  apply((await res.json()) as AuthPayload);
}

/**
 * Refresh com SINGLE-FLIGHT: rotação torna refreshes paralelos fatais (o 2º
 * apresentaria um token já revogado), então 401s concorrentes compartilham
 * uma única chamada. Retorna true se renovou.
 */
export function refresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const token = storedRefreshToken();
  if (!token) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) {
        clearSession();
        return false;
      }
      apply((await res.json()) as AuthPayload);
      return true;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
