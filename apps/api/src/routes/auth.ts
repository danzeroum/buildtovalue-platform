import {
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  PROBLEM_TYPES,
  problemSchema,
  refreshRequestSchema,
} from '@platform/api-contracts';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from '@platform/auth';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';

/**
 * /v1/auth — login (tenant slug + email + senha), refresh com rotação, /v1/me.
 * Refresh token é OPACO prefixado pelo tenantId (`${tenantId}.${segredo}`):
 * o prefixo resolve o contexto de RLS no refresh; o hash do valor COMPLETO é
 * o que vive no banco.
 */
export function registerAuthRoutes(rawApp: FastifyInstance, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const jwtOptions = {
    secret: deps.config.JWT_SECRET,
    accessTtlSeconds: deps.config.JWT_ACCESS_TTL_SECONDS,
  };

  app.post(
    '/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Autentica um usuário e emite access + refresh tokens',
        body: loginRequestSchema,
        response: { 200: loginResponseSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      const { tenant, email, password } = req.body;
      const invalid = () =>
        reply
          .status(401)
          .header('content-type', 'application/problem+json; charset=utf-8')
          .send({
            type: PROBLEM_TYPES.unauthorized,
            title: 'Credenciais inválidas',
            status: 401,
            requestId: String(req.id),
          });

      const tenantRow = await deps.users.findTenantBySlug(tenant);
      // Tenant inexistente responde IGUAL a credencial errada (sem enumeração).
      if (!tenantRow) return invalid();
      const user = await deps.users.findByEmail(tenantRow.id, email);
      if (!user || !(await verifyPassword(password, user.password_hash))) return invalid();

      const pair = await signAccessToken(
        { sub: user.id, tenantId: user.tenant_id, role: user.role },
        jwtOptions,
      );
      const { token, hash: _hash } = generateRefreshToken();
      const refreshToken = `${user.tenant_id}.${token}`;
      const expiresAt = new Date(Date.now() + deps.config.JWT_REFRESH_TTL_SECONDS * 1000);
      await deps.refreshTokens.create(
        user.tenant_id,
        user.id,
        hashRefreshToken(refreshToken),
        expiresAt,
      );
      return {
        accessToken: pair.accessToken,
        refreshToken,
        expiresInSeconds: pair.expiresInSeconds,
        user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role },
      };
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Troca um refresh token válido por um novo par (rotação)',
        body: refreshRequestSchema,
        response: { 200: loginResponseSchema, 401: problemSchema },
      },
    },
    async (req, reply) => {
      const invalid = () =>
        reply
          .status(401)
          .header('content-type', 'application/problem+json; charset=utf-8')
          .send({
            type: PROBLEM_TYPES.unauthorized,
            title: 'Refresh token inválido',
            status: 401,
            requestId: String(req.id),
          });

      const { refreshToken } = req.body;
      const dot = refreshToken.indexOf('.');
      if (dot <= 0) return invalid();
      const tenantId = refreshToken.slice(0, dot);
      const row = await deps.refreshTokens
        .findByHash(tenantId, hashRefreshToken(refreshToken))
        .catch(() => undefined);
      if (!row || row.revoked_at !== null || row.expires_at.getTime() < Date.now()) {
        return invalid();
      }
      const user = await deps.users.findById(tenantId, row.user_id);
      if (!user) return invalid();

      // Rotação: o token usado morre; um novo nasce.
      await deps.refreshTokens.revoke(tenantId, row.id);
      const pair = await signAccessToken(
        { sub: user.id, tenantId, role: user.role },
        jwtOptions,
      );
      const { token } = generateRefreshToken();
      const nextRefresh = `${tenantId}.${token}`;
      await deps.refreshTokens.create(
        tenantId,
        user.id,
        hashRefreshToken(nextRefresh),
        new Date(Date.now() + deps.config.JWT_REFRESH_TTL_SECONDS * 1000),
      );
      return {
        accessToken: pair.accessToken,
        refreshToken: nextRefresh,
        expiresInSeconds: pair.expiresInSeconds,
        user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role },
      };
    },
  );

  app.get(
    '/v1/me',
    {
      preHandler: [app.authenticate, app.requirePermission('me:read')],
      schema: {
        tags: ['auth'],
        summary: 'Dados do usuário autenticado',
        security: [{ bearerAuth: [] }],
        response: { 200: meResponseSchema, 401: problemSchema },
      },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const user = await deps.users.findById(auth.tenantId, auth.sub);
      if (!user) {
        return reply
          .status(401)
          .header('content-type', 'application/problem+json; charset=utf-8')
          .send({
            type: PROBLEM_TYPES.unauthorized,
            title: 'Usuário não encontrado',
            status: 401,
            requestId: String(req.id),
          });
      }
      return {
        id: user.id,
        tenantId: user.tenant_id,
        displayName: user.display_name,
        email: user.email,
        role: user.role,
      };
    },
  );
}
