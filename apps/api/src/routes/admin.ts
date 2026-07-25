import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

/**
 * AG-3.5 (ADENDO-04 §5, shape `ag3-5-shape-proposta-admin-basica.md`). A4 —
 * gestão de membros do tenant: mudar papel, desativar/reativar, redefinir senha.
 * Todas exigem `members:manage` (admin do tenant) e motivo obrigatório — a mesma
 * disciplina do kill-switch/tools. O lockout do último admin é invariante sobre
 * o RESULTADO da operação (nunca zero admins ativos), não sobre quem pediu.
 */

const roleSchema = z.enum(['admin', 'analyst', 'business', 'operator', 'auditor']);

const memberSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  active: z.boolean(),
  disabledAt: z.string().nullable(),
  mustChangePassword: z.boolean(),
});

function problem(reply: FastifyReply, status: number, type: string, title: string, requestId: string, detail?: string) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...(detail ? { detail } : {}) });
}

function lastAdminProblem(reply: FastifyReply, requestId: string) {
  return problem(
    reply,
    422,
    PROBLEM_TYPES.validation,
    'não é possível remover o último admin do tenant',
    requestId,
    'esta operação deixaria o tenant sem nenhum administrador ativo',
  );
}

export function registerAdminRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return; // testes de auth puros não injetam runtime

  app.get(
    '/v1/admin/members',
    {
      preHandler: [app.authenticate, app.requirePermission('members:read')],
      schema: {
        tags: ['admin'],
        summary: 'Lista os membros do tenant',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ items: z.array(memberSchema) }), 403: problemSchema },
      },
    },
    async (req) => ({ items: await runtime.admin.listMembers(req.auth!.tenantId) }),
  );

  app.patch(
    '/v1/admin/members/:id/role',
    {
      preHandler: [app.authenticate, app.requirePermission('members:manage')],
      schema: {
        tags: ['admin'],
        summary: 'Muda o papel de um membro (motivo obrigatório)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ role: roleSchema, reason: z.string().trim().min(1, 'motivo é obrigatório') }),
        response: { 200: memberSchema, 403: problemSchema, 404: problemSchema, 422: problemSchema },
      },
    },
    async (req, reply) => {
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      const outcome = await runtime.admin.updateMemberRole(
        req.auth!.tenantId,
        req.params.id,
        req.body.role,
        actor,
        req.body.reason,
      );
      if (!outcome.ok) {
        if (outcome.code === 'NOT_FOUND') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'membro não encontrado', String(req.id));
        }
        return lastAdminProblem(reply, String(req.id));
      }
      return outcome.member;
    },
  );

  app.patch(
    '/v1/admin/members/:id/active',
    {
      preHandler: [app.authenticate, app.requirePermission('members:manage')],
      schema: {
        tags: ['admin'],
        summary: 'Desativa/reativa o acesso de um membro (motivo obrigatório)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ active: z.boolean(), reason: z.string().trim().min(1, 'motivo é obrigatório') }),
        response: { 200: memberSchema, 403: problemSchema, 404: problemSchema, 422: problemSchema },
      },
    },
    async (req, reply) => {
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      const outcome = await runtime.admin.setMemberActive(
        req.auth!.tenantId,
        req.params.id,
        req.body.active,
        actor,
        req.body.reason,
      );
      if (!outcome.ok) {
        if (outcome.code === 'NOT_FOUND') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'membro não encontrado', String(req.id));
        }
        return lastAdminProblem(reply, String(req.id));
      }
      return outcome.member;
    },
  );

  app.post(
    '/v1/admin/members/:id/reset-password',
    {
      preHandler: [app.authenticate, app.requirePermission('members:manage')],
      schema: {
        tags: ['admin'],
        summary: 'Gera senha temporária (motivo obrigatório) — exibida UMA VEZ na resposta',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().trim().min(1, 'motivo é obrigatório') }),
        response: {
          200: z.object({ temporaryPassword: z.string() }),
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      const outcome = await runtime.admin.resetMemberPassword(
        req.auth!.tenantId,
        req.params.id,
        actor,
        req.body.reason,
      );
      if (!outcome.ok) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'membro não encontrado', String(req.id));
      }
      return { temporaryPassword: outcome.temporaryPassword };
    },
  );
}
