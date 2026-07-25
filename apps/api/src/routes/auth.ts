import {
  dateFormatSchema,
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
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps } from '../app.js';

function problem(reply: FastifyReply, status: number, type: string, title: string, requestId: string, detail?: string) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...(detail ? { detail } : {}) });
}

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
      // AG-3.5: conta desativada não loga — mesma mensagem honesta que barra o
      // request autenticado (authenticate), aqui na porta de entrada.
      if (!user.active) {
        return problem(reply, 401, PROBLEM_TYPES.unauthorized, 'Conta desativada', String(req.id));
      }

      const { token, hash: _hash } = generateRefreshToken();
      const refreshToken = `${user.tenant_id}.${token}`;
      const expiresAt = new Date(Date.now() + deps.config.JWT_REFRESH_TTL_SECONDS * 1000);
      // sid (AG-3.5): o id desta linha vira o claim que identifica a sessão no
      // access token — o revoke-all de troca de senha preserva ESTA sem o
      // cliente reenviar o refresh token.
      const sid = await deps.refreshTokens.create(
        user.tenant_id,
        user.id,
        hashRefreshToken(refreshToken),
        expiresAt,
      );
      const pair = await signAccessToken(
        { sub: user.id, tenantId: user.tenant_id, role: user.role, sid },
        jwtOptions,
      );
      return {
        accessToken: pair.accessToken,
        refreshToken,
        expiresInSeconds: pair.expiresInSeconds,
        user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role },
        mustChangePassword: user.must_change_password,
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
      if (!user.active) {
        return problem(reply, 401, PROBLEM_TYPES.unauthorized, 'Conta desativada', String(req.id));
      }

      // Rotação: o token usado morre; um novo nasce.
      await deps.refreshTokens.revoke(tenantId, row.id);
      const { token } = generateRefreshToken();
      const nextRefresh = `${tenantId}.${token}`;
      const sid = await deps.refreshTokens.create(
        tenantId,
        user.id,
        hashRefreshToken(nextRefresh),
        new Date(Date.now() + deps.config.JWT_REFRESH_TTL_SECONDS * 1000),
      );
      const pair = await signAccessToken(
        { sub: user.id, tenantId, role: user.role, sid },
        jwtOptions,
      );
      return {
        accessToken: pair.accessToken,
        refreshToken: nextRefresh,
        expiresInSeconds: pair.expiresInSeconds,
        user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role },
        mustChangePassword: user.must_change_password,
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
        mustChangePassword: user.must_change_password,
        timezone: user.timezone,
        dateFormat: user.date_format,
      };
    },
  );

  // ── A5 · trocar a própria senha — universal (me:write), revoke-all preservando
  // a sessão do PRÓPRIO request (sid do access token, nunca reenviado pelo
  // cliente) ────────────────────────────────────────────────────────────────
  app.patch(
    '/v1/me/password',
    {
      preHandler: [app.authenticate, app.requirePermission('me:write')],
      schema: {
        tags: ['auth'],
        summary: 'Troca a própria senha (funciona com senha temporária); encerra as outras sessões',
        security: [{ bearerAuth: [] }],
        body: z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(8, 'a nova senha precisa de pelo menos 8 caracteres'),
        }),
        response: { 200: z.object({ ok: z.literal(true) }), 401: problemSchema, 403: problemSchema },
      },
    },
    async (req, reply) => {
      if (!deps.runtime) throw new Error('runtime ausente');
      const auth = req.auth!;
      const outcome = await deps.runtime.admin.changeOwnPassword(auth.tenantId, auth.sub, {
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
        sid: auth.sid,
      });
      if (!outcome.ok) {
        return problem(reply, 403, PROBLEM_TYPES.forbidden, 'Senha atual incorreta', String(req.id));
      }
      return { ok: true as const };
    },
  );

  // ── A5 · preferências (fuso horário + formato de data) — universal ─────────
  app.patch(
    '/v1/me/preferences',
    {
      preHandler: [app.authenticate, app.requirePermission('me:write')],
      schema: {
        tags: ['auth'],
        summary: 'Atualiza fuso horário e formato de data do usuário autenticado',
        security: [{ bearerAuth: [] }],
        body: z.object({ timezone: z.string().min(1), dateFormat: dateFormatSchema }),
        response: { 200: z.object({ ok: z.literal(true) }), 401: problemSchema },
      },
    },
    async (req) => {
      if (!deps.runtime) throw new Error('runtime ausente');
      const auth = req.auth!;
      await deps.runtime.admin.updatePreferences(auth.tenantId, auth.sub, {
        timezone: req.body.timezone,
        dateFormat: req.body.dateFormat,
      });
      return { ok: true as const };
    },
  );
}
