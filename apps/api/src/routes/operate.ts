import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

function problem(
  reply: FastifyReply,
  status: number,
  type: string,
  title: string,
  requestId: string,
  detail?: string,
) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...(detail ? { detail } : {}) });
}

/**
 * Operate (shape §6b/§7): timers somente-leitura e incidentes com
 * retry/resolution AUDITADOS (ator + motivo na história da instância).
 */
export function registerOperateRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return;

  app.get(
    '/v1/timers',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:read')],
      schema: {
        tags: ['timers'],
        summary: 'Timers (cursor; status/instanceId) — somente leitura na v1',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          status: z.enum(['armed', 'fired', 'cancelled']).optional(),
          instanceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                instanceId: z.string().uuid(),
                elementId: z.string(),
                fireAt: z.string(),
                status: z.string(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const page = await runtime.operate.timers(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((t) => ({
          id: t.id,
          instanceId: t.instance_id,
          elementId: t.element_id,
          fireAt: String(t.fire_at),
          status: t.status,
          createdAt: String(t.created_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/incidents',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:read')],
      schema: {
        tags: ['incidents'],
        summary: 'Incidentes (cursor; status/kind/instanceId)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          status: z.enum(['open', 'retried', 'resolved']).optional(),
          kind: z.string().optional(),
          instanceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                instanceId: z.string().uuid(),
                kind: z.string(),
                message: z.string(),
                status: z.string(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const page = await runtime.operate.incidents(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((i) => ({
          id: i.id,
          instanceId: i.instance_id,
          kind: i.kind,
          message: i.message,
          status: i.status,
          createdAt: String(i.created_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    '/v1/incidents/:id/retry',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['incidents'],
        summary: 'Re-tenta a causa: jobs failed voltam a available com retries restaurados (auditado)',
        description:
          'Re-arma jobs `failed` da instância (retries restaurados) e marca o incidente `retried`. ' +
          'LIMITAÇÃO v1 (ERRATA §7 do contrato): efeito em DEAD-LETTER ' +
          "(`kind = 'effectDispatchFailed'`) NÃO é re-enfileirável — a outbox é fila efêmera e o " +
          'payload não é persistido no incidente. Nesse caso a rota responde 409 problem+json ' +
          'apontando /resolution (sem falso sucesso). Re-enfileiramento com payload persistido ' +
          'exige coluna nova em incidents (migração da AG-2).',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ rearmedJobs: z.number().int() }),
          404: problemSchema,
          409: problemSchema.describe('Incidente não re-tentável (ex.: dead-letter) — use /resolution'),
        },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.operate.retryIncident(req.auth!.tenantId, req.params.id, req.auth!.sub);
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Incidente não encontrado', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Retry recusado', String(req.id), outcome.message);
      }
      return { rearmedJobs: outcome.rearmedJobs };
    },
  );

  app.post(
    '/v1/incidents/:id/resolution',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['incidents'],
        summary: 'Resolve manualmente com motivo obrigatório (auditado)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().min(1).max(500) }),
        response: { 200: z.object({ status: z.literal('resolved') }), 404: problemSchema, 409: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.operate.resolveIncident(req.auth!.tenantId, req.params.id, {
        reason: req.body.reason,
        actor: req.auth!.sub,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Incidente não encontrado', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Resolução recusada', String(req.id), outcome.message);
      }
      return { status: 'resolved' as const };
    },
  );
}
