import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import { DECISION_MAX_LENGTH } from '@platform/db';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

const taskSummarySchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  elementId: z.string(),
  formRef: z.string(),
  assignee: z.string().nullable(),
  candidateRoles: z.array(z.string()),
  status: z.string(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  // D31: gate de tool (userTask btvGate). A Tasklist comum já o EXCLUI no
  // servidor; o campo serve ao Operate/superfície de gate (drill-down).
  isGate: z.boolean(),
});

function problem(
  reply: FastifyReply,
  status: number,
  type: string,
  title: string,
  requestId: string,
  extra?: Record<string, unknown>,
) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...extra });
}

function summarize(row: {
  id: string;
  instance_id: string;
  element_id: string;
  form_ref: string;
  assignee: string | null;
  candidate_roles: string[];
  status: string;
  claimed_at: string | null;
  created_at: string;
  is_gate: boolean;
}) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    elementId: row.element_id,
    formRef: row.form_ref,
    assignee: row.assignee,
    candidateRoles: row.candidate_roles,
    status: row.status,
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    createdAt: String(row.created_at),
    isGate: row.is_gate,
  };
}

/**
 * User tasks (shape §6): claim persistente D21 com token ROTACIONADO
 * (decisão 10.b), 409 com holder para a UI ("com {user} desde {since}" —
 * ADENDO §2.2), completion validada no servidor com o form PINADO, e
 * reatribuição por operador (D24) auditada. Papel alheio: FILTRADO na
 * lista (10.d), 403 com mensagem de papel no acesso direto INTRA-tenant;
 * cross-tenant = 404 (RLS + convenção §0).
 */
export function registerUserTaskRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return;

  const viewerOf = (auth: { sub: string; role: string }) => ({
    sub: auth.sub,
    role: auth.role,
    seesAll: auth.role === 'admin' || auth.role === 'operator',
  });

  app.get(
    '/v1/user-tasks',
    {
      preHandler: [app.authenticate, app.requirePermission('tasks:read')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Tasklist (cursor; mine|role|unassigned; papel alheio é filtrado)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          status: z.enum(['open', 'completed', 'cancelled']).optional(),
          instanceId: z.string().uuid().optional(),
          filter: z.enum(['mine', 'role', 'unassigned']).optional(),
        }),
        response: {
          200: z.object({ items: z.array(taskSummarySchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const page = await runtime.userTasks.list(req.auth!.tenantId, viewerOf(req.auth!), req.query);
      return { items: page.items.map(summarize), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/v1/user-tasks/:id',
    {
      preHandler: [app.authenticate, app.requirePermission('tasks:read')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Detalhe com o formulário PINADO (formRef exato)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: taskSummarySchema.extend({
            payload: z.record(z.string(), z.unknown()),
            // etapa 6: se não-null, a conclusão EXIGE `decision` (roteamento
            // comparado por igualdade no gateway a jusante).
            decisionVar: z.string().nullable(),
            // valores EXATOS que roteiam (do gateway a jusante); o cliente
            // oferece escolha exata. null = texto livre (gateway não-derivável).
            decisionOptions: z.array(z.string()).nullable(),
          }),
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const task = await runtime.userTasks.get(req.auth!.tenantId, req.params.id, viewerOf(req.auth!));
      if (!task) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Task não encontrada', String(req.id));
      }
      if (!task.visible) {
        // 403 SÓ intra-tenant (ADENDO §2.2): a task existe no seu tenant,
        // mas pertence a outro papel — a mensagem diz qual.
        return problem(reply, 403, PROBLEM_TYPES.forbidden, 'Task de outro papel', String(req.id), {
          detail: `esta task é dos papéis [${task.candidate_roles.join(', ')}]`,
        });
      }
      return {
        ...summarize(task),
        payload: task.payload,
        decisionVar: task.decision_var,
        decisionOptions: task.decision_options,
      };
    },
  );

  app.post(
    '/v1/user-tasks/:id/claim',
    {
      preHandler: [app.authenticate, app.requirePermission('tasks:work')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Claim persistente (D21); re-claim rotaciona o token',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ claimToken: z.string().uuid() }),
          404: problemSchema,
          409: problemSchema.extend({
            holder: z.object({ user: z.string(), since: z.string() }).optional(),
          }),
        },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.userTasks.claim(req.auth!.tenantId, req.params.id, req.auth!.sub);
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Task não encontrada', String(req.id));
        }
        if (outcome.reason === 'held') {
          // a UI exibe "com {user} desde {since}" (ADENDO §2.2)
          return problem(reply, 409, PROBLEM_TYPES.conflict, 'Task já reivindicada', String(req.id), {
            detail: outcome.message,
            holder: outcome.holder,
          });
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Claim recusado', String(req.id), {
          detail: outcome.message,
        });
      }
      return { claimToken: outcome.claimToken };
    },
  );

  app.delete(
    '/v1/user-tasks/:id/claim',
    {
      preHandler: [app.authenticate, app.requirePermission('tasks:work')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Desfaz o PRÓPRIO claim (operador usa /assignment)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.userTasks.unclaim(req.auth!.tenantId, req.params.id, req.auth!.sub);
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Task não encontrada', String(req.id));
        }
        return problem(reply, 403, PROBLEM_TYPES.forbidden, 'Claim de outro usuário', String(req.id), {
          detail: outcome.message,
        });
      }
      reply.status(204);
      return null;
    },
  );

  app.post(
    '/v1/user-tasks/:id/completion',
    {
      preHandler: [app.authenticate, app.requirePermission('tasks:work')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Conclui com o claimToken VIGENTE; validação no servidor pelo form pinado',
        description:
          'Conclusão fenced (só o claimToken vigente conclui). `decision` (etapa 6): valor de ' +
          'ROTEAMENTO, exigido SSE o elemento declara `decisionVar` no BPMN (veja `decisionVar` no ' +
          'detalhe da task). O gateway a jusante o compara por IGUALDADE (semântica real do avaliador, ' +
          '§2.6). A decisão NUNCA é ignorada em silêncio: enviar `decision` sem `decisionVar` declarada, ' +
          'ou concluir sem `decision` quando declarada, respondem 422 (nunca aceitar-e-descartar). ' +
          'A decisão flui para `variables` (sob a decisionVar) E para `history_events` (quem decidiu o quê).',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          claimToken: z.string().uuid(),
          submission: z.record(z.string(), z.unknown()),
          // não-vazia + teto de comprimento; a obrigatoriedade/recusa semântica
          // (declarada×enviada) é decidida NO SERVIDOR contra o BPMN → 422.
          decision: z.string().min(1).max(DECISION_MAX_LENGTH).optional(),
        }),
        response: {
          200: z.object({ instanceStatus: z.string() }),
          404: problemSchema,
          409: problemSchema,
          422: problemSchema.extend({ errors: z.record(z.string(), z.array(z.string())).optional() }),
        },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.userTasks.complete(req.auth!.tenantId, req.params.id, {
        claimToken: req.body.claimToken,
        submission: req.body.submission,
        user: req.auth!.sub,
        ...(req.body.decision !== undefined ? { decision: req.body.decision } : {}),
      });
      if (!outcome.ok) {
        if ('errors' in outcome) {
          return problem(reply, 422, PROBLEM_TYPES.validation, 'Submissão inválida', String(req.id), {
            errors: outcome.errors,
          });
        }
        // etapa 6: a decisão mal-endereçada é 422 EXPLÍCITO (nunca silêncio).
        if (
          outcome.reason === 'decisionRequired' ||
          outcome.reason === 'decisionUnexpected' ||
          outcome.reason === 'decisionInvalid'
        ) {
          return problem(reply, 422, PROBLEM_TYPES.validation, 'Decisão inválida', String(req.id), {
            detail: outcome.message,
          });
        }
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Task não encontrada', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Conclusão recusada', String(req.id), {
          detail: outcome.message,
        });
      }
      return { instanceStatus: outcome.instanceStatus };
    },
  );

  app.post(
    '/v1/user-tasks/:id/assignment',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['user-tasks'],
        summary: 'Reatribuição por operador (D24) — invalida o claimToken vigente, auditada',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          assignee: z.string().min(1).max(120),
          reason: z.string().min(1).max(500),
        }),
        response: { 200: z.object({ assignee: z.string() }), 404: problemSchema, 409: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.userTasks.assign(req.auth!.tenantId, req.params.id, {
        assignee: req.body.assignee,
        reason: req.body.reason,
        actor: req.auth!.sub,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Task não encontrada', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Reatribuição recusada', String(req.id), {
          detail: outcome.message,
        });
      }
      return { assignee: req.body.assignee };
    },
  );
}
