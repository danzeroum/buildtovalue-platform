import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

const instanceResponseSchema = z.object({
  id: z.string().uuid(),
  definitionRef: z.string(),
  status: z.enum(['active', 'completed', 'cancelled', 'incident']),
  revision: z.number().int(),
  businessKey: z.string().nullable(),
});

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
 * Rotas do WALKING SKELETON (F1.8): start/consulta de instância e o contrato
 * público de jobs (D22 — o handler conclui por AQUI, nunca dentro de tx).
 * Fencing D12: token velho/estado errado = 409 problem+json.
 */
export function registerRuntimeRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return; // testes de auth puros não injetam runtime

  app.post(
    '/v1/instances',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:start')],
      schema: {
        tags: ['instances'],
        summary: 'Cria e inicia uma instância de processo',
        security: [{ bearerAuth: [] }],
        body: z.object({
          definitionRef: z.string().optional().describe('Default: skeleton@1'),
          businessKey: z.string().max(200).optional(),
          variables: z.record(z.string(), z.unknown()).optional(),
        }),
        response: { 201: instanceResponseSchema, 422: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.createAndStart(req.auth!.tenantId, req.body);
      if (!outcome.ok) {
        return problem(reply, 422, PROBLEM_TYPES.validation, 'Não foi possível iniciar a instância', String(req.id), outcome.message);
      }
      reply.status(201);
      return {
        id: outcome.instance.id,
        definitionRef: outcome.instance.definition_ref,
        status: outcome.instance.status as 'active',
        revision: outcome.instance.revision,
        businessKey: outcome.instance.business_key,
      };
    },
  );

  app.get(
    '/v1/instances/:id',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:read')],
      schema: {
        tags: ['instances'],
        summary: 'Consulta uma instância',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: instanceResponseSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      const row = await runtime.get(req.auth!.tenantId, req.params.id);
      if (!row) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      return {
        id: row.id,
        definitionRef: row.definition_ref,
        status: row.status as 'active',
        revision: row.revision,
        businessKey: row.business_key,
      };
    },
  );

  const jobConclusionBody = z.object({ lockToken: z.string().uuid() });

  app.post(
    '/v1/jobs/:id/complete',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['jobs'],
        summary: 'Conclui um job com o lock_token vigente (fencing D12)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: jobConclusionBody,
        response: { 200: instanceResponseSchema, 404: problemSchema, 409: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.completeJob(req.auth!.tenantId, req.params.id, req.body.lockToken, new Date().toISOString());
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Job não encontrado', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Conclusão recusada', String(req.id), outcome.message);
      }
      return {
        id: outcome.instance.id,
        definitionRef: outcome.instance.definition_ref,
        status: outcome.instance.status as 'active',
        revision: outcome.instance.revision,
        businessKey: outcome.instance.business_key,
      };
    },
  );

  app.post(
    '/v1/jobs/:id/fail',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['jobs'],
        summary: 'Falha um job com o lock_token vigente; retries esgotados viram incidente',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: jobConclusionBody.extend({ error: z.string().max(2000) }),
        response: {
          200: z.object({ status: z.enum(['available', 'failed']) }),
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.failJob(req.auth!.tenantId, req.params.id, req.body.lockToken, req.body.error, new Date().toISOString());
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Job não encontrado', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Falha recusada', String(req.id), outcome.message);
      }
      return { status: outcome.status };
    },
  );
}
