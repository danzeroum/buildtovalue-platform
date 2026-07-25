import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

/**
 * AG-3.4 (P5 — catálogo de tools por tenant, shape `ag3-4-shape-proposta-p5-tools.md`).
 * `effect`/`authorization` vêm SEMPRE ao vivo de `tool_definitions` (imutável) —
 * o operador só liga/desliga `enabled`. D31 fica ORTOGONAL: `enabled:true` numa
 * tool `proibida` nunca é aceito (422); `enabled` nunca rebaixa `authorization`.
 */

/** Campos que só existem no `ToolContract` (imutável) — nunca aceitos aqui;
 * enviá-los é 422 EXPLÍCITO (nunca aceitar e silenciosamente descartar). */
const CONTRACT_ONLY_FIELDS = ['effect', 'authorization', 'requiresGate'] as const;

const toolItemSchema = z.object({
  toolId: z.string(),
  ref: z.string(),
  name: z.string(),
  capability: z.string(),
  effect: z.string(),
  authorization: z.string(),
  dataScope: z.string(),
  enabled: z.boolean(),
  requiresGate: z.boolean(),
});

function problem(reply: import('fastify').FastifyReply, status: number, type: string, title: string, requestId: string, detail?: string) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...(detail ? { detail } : {}) });
}

export function registerToolRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return; // testes de auth puros não injetam runtime

  // ── LER o catálogo — admin + auditor (evidência de superfície de risco) ─────
  app.get(
    '/v1/tools',
    {
      preHandler: [app.authenticate, app.requirePermission('tools:read')],
      schema: {
        tags: ['tools'],
        summary: 'Catálogo de tools do tenant — enabled honesto (sem linha = false), requiresGate computado ao vivo',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ items: z.array(toolItemSchema) }), 403: problemSchema },
      },
    },
    async (req) => ({ items: await runtime.tools.list(req.auth!.tenantId) }),
  );

  // ── LIGAR/DESLIGAR — admin, motivo obrigatório nas duas direções, auditado ──
  app.patch(
    '/v1/tools/:toolId',
    {
      preHandler: [app.authenticate, app.requirePermission('tools:configure')],
      schema: {
        tags: ['tools'],
        summary: 'Liga/desliga uma tool para o tenant (único campo editável; effect/authorization nunca aceitos aqui)',
        security: [{ bearerAuth: [] }],
        params: z.object({ toolId: z.string() }),
        body: z
          .object({
            enabled: z.boolean(),
            reason: z.string().trim().min(1, 'motivo é obrigatório (ligar e desligar)'),
          })
          .passthrough(),
        response: {
          200: toolItemSchema,
          403: problemSchema,
          404: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const bodySent = req.body as Record<string, unknown>;
      const contractFieldsSent = CONTRACT_ONLY_FIELDS.filter((f) => f in bodySent);
      if (contractFieldsSent.length > 0) {
        return problem(
          reply,
          422,
          PROBLEM_TYPES.validation,
          'campos do contrato não são editáveis aqui',
          String(req.id),
          `esses campos vêm do ToolContract (imutável), não são editáveis aqui: ${contractFieldsSent.join(', ')}`,
        );
      }
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      const outcome = await runtime.tools.setEnabled(
        req.auth!.tenantId,
        req.params.toolId,
        req.body.enabled,
        actor,
        req.body.reason,
      );
      if (!outcome.ok) {
        if (outcome.code === 'TOOL_NOT_FOUND') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, `tool '${req.params.toolId}' não encontrada`, String(req.id));
        }
        return problem(
          reply,
          422,
          PROBLEM_TYPES.validation,
          'tool proibida não pode ser habilitada',
          String(req.id),
          `a autorização da tool '${req.params.toolId}' é 'proibida' — invariante da plataforma (D31), não é decisão de tenant`,
        );
      }
      return outcome.tool;
    },
  );
}
