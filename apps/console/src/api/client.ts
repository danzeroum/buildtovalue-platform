import createClient, { type Middleware } from 'openapi-fetch';
import { clearSession, currentToken, refresh } from '../session.js';
import type { paths } from './generated/schema.js';

/**
 * SDK tipado do console (F1.5 → F3): gerado do OpenAPI da API. Um endpoint só
 * entra no console DEPOIS de estável no OpenAPI — este client não compila se a
 * rota não existir no contrato.
 *
 * Middleware de auth (F3.1): anexa `Authorization: Bearer <accessToken>` em
 * toda requisição; em 401 (`/problems/unauthorized`) faz refresh single-flight
 * e re-tenta UMA vez; 403 (`/problems/forbidden`) é negação de RBAC — NUNCA
 * dispara refresh nem retry.
 */
export const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = currentToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
  async onResponse({ request, response }) {
    if (response.status !== 401) return response;
    // não re-tentar o próprio refresh nem o login
    if (request.url.includes('/v1/auth/')) return response;
    const renewed = await refresh();
    if (!renewed) {
      clearSession();
      return response;
    }
    const retry = new Request(request, {
      headers: new Headers(request.headers),
    });
    retry.headers.set('Authorization', `Bearer ${currentToken()!}`);
    return fetch(retry);
  },
};

export const api = createClient<paths>({ baseUrl: '/' });
api.use(authMiddleware);

/** Extrai a mensagem humana de um corpo problem+json (ou um fallback). */
export function problemMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const p = body as { detail?: string; title?: string };
    return p.detail ?? p.title ?? fallback;
  }
  return fallback;
}
