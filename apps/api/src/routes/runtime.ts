import { createHash } from 'node:crypto';
import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';
import { instanceHistoryToXES } from '../xes.js';

const instanceResponseSchema = z.object({
  id: z.string().uuid(),
  definitionRef: z.string(),
  status: z.enum(['active', 'completed', 'cancelled', 'incident']),
  revision: z.number().int(),
  businessKey: z.string().nullable(),
});

const instanceDetailSchema = instanceResponseSchema.extend({
  /** Posição atual dos tokens (drill-down do Operate — shape §3). */
  currentElements: z.array(z.string()),
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
      const tenantId = req.auth!.tenantId;
      // Idempotency-Key (convenção §0): replay devolve a resposta ORIGINAL;
      // mesma chave com corpo diferente = 409 (uso incorreto do cliente).
      const idempotencyKey = req.headers['idempotency-key'];
      const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        const hit = await runtime.idempotency.get(tenantId, idempotencyKey);
        if (hit) {
          if (hit.request_hash !== requestHash) {
            return problem(reply, 409, PROBLEM_TYPES.conflict, 'Idempotency-Key reutilizada com corpo diferente', String(req.id));
          }
          // só respostas 201 são gravadas (falha não conta como consumo)
          reply.header('idempotency-replayed', 'true');
          reply.status(201);
          return hit.response as z.infer<typeof instanceResponseSchema>;
        }
      }
      const outcome = await runtime.createAndStart(tenantId, req.body);
      if (!outcome.ok) {
        return problem(reply, 422, PROBLEM_TYPES.validation, 'Não foi possível iniciar a instância', String(req.id), outcome.message);
      }
      const responseBody = {
        id: outcome.instance.id,
        definitionRef: outcome.instance.definition_ref,
        status: outcome.instance.status as 'active',
        revision: outcome.instance.revision,
        businessKey: outcome.instance.business_key,
      };
      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        await runtime.idempotency.put(tenantId, idempotencyKey, requestHash, 201, responseBody);
        // corrida: se outra requisição venceu, o replay é DELA
        const winner = await runtime.idempotency.get(tenantId, idempotencyKey);
        if (winner && winner.request_hash === requestHash && winner.response) {
          reply.status(201);
          return winner.response as z.infer<typeof instanceResponseSchema>;
        }
      }
      reply.status(201);
      return responseBody;
    },
  );

  app.get(
    '/v1/instances',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:read')],
      schema: {
        tags: ['instances'],
        summary: 'Lista instâncias (cursor; filtros do Operate)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          status: z.enum(['active', 'completed', 'cancelled', 'incident']).optional(),
          definitionRef: z.string().optional(),
          businessKey: z.string().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(instanceResponseSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const page = await runtime.list(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          definitionRef: row.definition_ref,
          status: row.status as 'active',
          revision: row.revision,
          businessKey: row.business_key,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/instances/:id/history',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:read')],
      schema: {
        tags: ['instances'],
        summary: 'História da instância ordenada por seq (cursor = seq)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                seq: z.number(),
                kind: z.string(),
                payload: z.record(z.string(), z.unknown()),
                engineVersion: z.string(),
                occurredAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const row = await runtime.get(req.auth!.tenantId, req.params.id);
      if (!row) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      const page = await runtime.history(req.auth!.tenantId, req.params.id, req.query);
      return {
        items: page.items.map((event) => ({
          seq: Number(event.seq),
          kind: event.kind,
          payload: (event.payload ?? {}) as Record<string, unknown>,
          engineVersion: event.engine_version,
          occurredAt: String(event.occurred_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/instances/:id/export',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:read')],
      schema: {
        tags: ['instances'],
        summary: 'Export XES 2.0 da história (mineração de processos)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ format: z.literal('xes').default('xes') }),
        response: { 200: z.string(), 404: problemSchema },
      },
    },
    async (req, reply) => {
      const row = await runtime.get(req.auth!.tenantId, req.params.id);
      if (!row) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      let cursor: string | undefined;
      const all: { seq: number; kind: string; payload: unknown; occurred_at: string }[] = [];
      for (;;) {
        const page = await runtime.history(req.auth!.tenantId, req.params.id, { cursor, limit: 100 });
        all.push(
          ...page.items.map((e) => ({
            seq: Number(e.seq),
            kind: e.kind,
            payload: e.payload,
            occurred_at: String(e.occurred_at),
          })),
        );
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      reply.header('content-type', 'application/xml; charset=utf-8');
      return instanceHistoryToXES(
        { id: row.id, businessKey: row.business_key, definitionRef: row.definition_ref },
        all,
      );
    },
  );

  app.get(
    '/v1/instances/:id',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:read')],
      schema: {
        tags: ['instances'],
        summary: 'Consulta uma instância (com a posição atual dos tokens)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: instanceDetailSchema, 404: problemSchema },
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
        // drill-down do Operate (shape §3): elementos com token vivo
        currentElements: [...new Set(row.state.tokens.map((t) => t.elementId))],
      };
    },
  );

  // ---- variables (shape §4, ADENDO §3) -----------------------------------
  const variableViewSchema = z.object({
    name: z.string(),
    classification: z.enum(['none', 'personal', 'sensitive']),
    value: z.unknown().optional(),
    masked: z.literal(true).optional(),
    updatedAt: z.string(),
  });

  app.get(
    '/v1/instances/:id/variables',
    {
      preHandler: [app.authenticate, app.requirePermission('instances:read')],
      schema: {
        tags: ['variables'],
        summary: 'Variáveis da instância — sensitive SEMPRE mascarada',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ items: z.array(variableViewSchema) }), 404: problemSchema },
      },
    },
    async (req, reply) => {
      const instance = await runtime.get(req.auth!.tenantId, req.params.id);
      if (!instance) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      return { items: await runtime.variables.list(req.auth!.tenantId, req.params.id) };
    },
  );

  app.post(
    '/v1/instances/:id/variables/:name/reveal',
    {
      preHandler: [app.authenticate, app.requirePermission('variables:reveal-sensitive')],
      schema: {
        tags: ['variables'],
        summary: 'Revela UMA variável sensitive — motivo obrigatório, auditado (LGPD art. 37)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid(), name: z.string().min(1) }),
        body: z.object({
          reason: z.string().min(1).max(500).describe('Motivo da revelação — vai para a auditoria'),
        }),
        response: {
          200: z.object({ name: z.string(), value: z.unknown() }),
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const instance = await runtime.get(req.auth!.tenantId, req.params.id);
      if (!instance) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      const outcome = await runtime.variables.reveal(req.auth!.tenantId, req.params.id, req.params.name, {
        actor: req.auth!.sub,
        reason: req.body.reason,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Variável não encontrada', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Revelação recusada', String(req.id), outcome.message);
      }
      return { name: outcome.name, value: outcome.value };
    },
  );

  app.patch(
    '/v1/instances/:id/variables',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['variables'],
        summary: 'Edição de variáveis pelo operador — sensitive cifrada na escrita, auditado',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          set: z.record(z.string().min(1), z.unknown()),
        }),
        response: {
          200: z.object({ updated: z.array(z.string()) }),
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.variables.patch(req.auth!.tenantId, req.params.id, req.body.set, {
        actor: req.auth!.sub,
      });
      if (!outcome.ok) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
      }
      return { updated: outcome.updated };
    },
  );

  // Sub-recurso de cancelamento (plano §6 + ADENDO-01 §2.3): motivo
  // OBRIGATÓRIO, que flui para history_events (payload do instanceCancelled
  // emitido pelo engine) — fecha o ciclo de auditoria do parecer.
  app.post(
    '/v1/instances/:id/cancellation',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['instances'],
        summary: 'Cancela uma instância com motivo obrigatório — fecha TODAS as esperas',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          reason: z.string().min(1).max(500).describe('Motivo do cancelamento — vai para o histórico'),
        }),
        response: { 200: instanceResponseSchema, 404: problemSchema, 409: problemSchema },
      },
    },
    async (req, reply) => {
      const outcome = await runtime.cancel(req.auth!.tenantId, req.params.id, req.body.reason);
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Instância não encontrada', String(req.id));
        }
        // alreadyClosed/invalidTransition/stateTooOld: estado não permite
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Cancelamento recusado', String(req.id), outcome.message);
      }
      return {
        id: outcome.instance.id,
        definitionRef: outcome.instance.definition_ref,
        status: outcome.instance.status as 'cancelled',
        revision: outcome.instance.revision,
        businessKey: outcome.instance.business_key,
      };
    },
  );

  // ---- jobs (shape §5): sub-recursos SUBSTANTIVOS + aliases deprecados ----
  const jobConclusionBody = z.object({ lockToken: z.string().uuid() });
  const completionBody = jobConclusionBody.extend({
    result: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Variáveis produzidas pelo handler; o host persiste (D13)'),
  });
  const failureBody = jobConclusionBody.extend({ error: z.string().max(2000) });

  // MESMO handler para rota nova e alias — equivalência byte-idêntica
  // garantida por construção (e testada); aliases somem na F4.
  const completionHandler = async (
    req: { auth?: { tenantId: string }; params: { id: string }; body: z.infer<typeof completionBody>; id: unknown },
    reply: FastifyReply,
  ) => {
    const outcome = await runtime.completeJob(req.auth!.tenantId, req.params.id, req.body.lockToken, new Date().toISOString(), req.body.result);
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
  };
  const failureHandler = async (
    req: { auth?: { tenantId: string }; params: { id: string }; body: z.infer<typeof failureBody>; id: unknown },
    reply: FastifyReply,
  ) => {
    const outcome = await runtime.failJob(req.auth!.tenantId, req.params.id, req.body.lockToken, req.body.error, new Date().toISOString());
    if (!outcome.ok) {
      if (outcome.reason === 'notFound') {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Job não encontrado', String(req.id));
      }
      return problem(reply, 409, PROBLEM_TYPES.conflict, 'Falha recusada', String(req.id), outcome.message);
    }
    return { status: outcome.status };
  };

  for (const { path, deprecated } of [
    { path: '/v1/jobs/:id/completion', deprecated: false },
    { path: '/v1/jobs/:id/complete', deprecated: true },
  ]) {
    app.post(
      path,
      {
        preHandler: [app.authenticate, app.requirePermission('operate:act')],
        schema: {
          tags: ['jobs'],
          summary: deprecated
            ? 'DEPRECADO — use /completion (alias removido na F4)'
            : 'Conclui um job com o lock_token vigente (fencing D12)',
          ...(deprecated ? { deprecated: true } : {}),
          security: [{ bearerAuth: [] }],
          params: z.object({ id: z.string().uuid() }),
          body: completionBody,
          response: { 200: instanceResponseSchema, 404: problemSchema, 409: problemSchema },
        },
      },
      completionHandler,
    );
  }

  for (const { path, deprecated } of [
    { path: '/v1/jobs/:id/failure', deprecated: false },
    { path: '/v1/jobs/:id/fail', deprecated: true },
  ]) {
    app.post(
      path,
      {
        preHandler: [app.authenticate, app.requirePermission('operate:act')],
        schema: {
          tags: ['jobs'],
          summary: deprecated
            ? 'DEPRECADO — use /failure (alias removido na F4)'
            : 'Falha um job com o lock_token vigente; retries esgotados viram incidente',
          ...(deprecated ? { deprecated: true } : {}),
          security: [{ bearerAuth: [] }],
          params: z.object({ id: z.string().uuid() }),
          body: failureBody,
          response: {
            200: z.object({ status: z.enum(['available', 'failed']) }),
            404: problemSchema,
            409: problemSchema,
          },
        },
      },
      failureHandler,
    );
  }

  // PARADA HONESTA (ADENDO-02 §5): estaciona o job de agente sem incidente nem
  // avanço. `reason` = a voz da parada (budget/kill-switch). Distinta de /failure
  // — parada honesta é âmbar/retomável, não card vermelho.
  const honestStopBody = jobConclusionBody.extend({
    reason: z.string().max(2000),
    kind: z.enum(['budget', 'kill-switch']),
  });
  app.post(
    '/v1/jobs/:id/honest-stop',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['jobs'],
        summary: 'Parada honesta de um job (budget/kill-switch) — estaciona sem incidente (§5)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: honestStopBody,
        response: {
          200: z.object({ status: z.literal('paused') }),
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (
      req: { auth?: { tenantId: string }; params: { id: string }; body: z.infer<typeof honestStopBody>; id: unknown },
      reply: FastifyReply,
    ) => {
      const outcome = await runtime.pauseJob(req.auth!.tenantId, req.params.id, req.body.lockToken, req.body.reason, req.body.kind);
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          return problem(reply, 404, PROBLEM_TYPES.notFound, 'Job não encontrado', String(req.id));
        }
        return problem(reply, 409, PROBLEM_TYPES.conflict, 'Parada honesta recusada', String(req.id), outcome.message);
      }
      return { status: outcome.status };
    },
  );

  // RETOMADA EXPLÍCITA (§5.2, budget): o operador manda retomar os jobs pausados
  // por orçamento (após elevar o teto). Kill-switch retoma sozinho ao reativar.
  app.post(
    '/v1/agents/resume',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['agents'],
        summary: 'Retoma jobs de agente em parada honesta de budget (ação explícita do operador, §5.2)',
        security: [{ bearerAuth: [] }],
        body: z.object({ pauseKind: z.literal('budget'), motivo: z.string().max(2000) }),
        response: { 200: z.object({ resumed: z.number() }), 404: problemSchema },
      },
    },
    async (
      req: { auth?: { tenantId: string; sub?: string }; body: { pauseKind: 'budget'; motivo: string }; id: unknown },
      _reply: FastifyReply,
    ) => {
      const result = await runtime.resumeAgentJobs(
        req.auth!.tenantId,
        req.body.pauseKind,
        { type: 'user', id: req.auth!.sub ?? 'operator', requestId: String(req.id) },
        req.body.motivo,
      );
      return { resumed: result.resumed };
    },
  );

  app.post(
    '/v1/jobs/locks',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:act')],
      schema: {
        tags: ['jobs'],
        summary: 'Lock em lote (lease + lock_token de fencing — D12/D22)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          workerId: z.string().min(1).max(120),
          types: z.array(z.string().min(1)).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
          leaseMs: z.coerce.number().int().min(1_000).max(300_000).optional(),
        }),
        response: {
          200: z.object({
            jobs: z.array(
              z.object({
                id: z.string().uuid(),
                instanceId: z.string().uuid(),
                type: z.string(),
                payload: z.record(z.string(), z.unknown()),
                lockToken: z.string().uuid(),
                retriesLeft: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const rows = await runtime.jobs.lock(req.auth!.tenantId, req.body.workerId, {
        types: req.body.types,
        limit: req.body.limit,
        leaseMs: req.body.leaseMs,
      });
      return {
        jobs: rows.map((job) => ({
          id: job.id,
          instanceId: job.instance_id,
          type: job.type,
          payload: job.payload,
          lockToken: job.lock_token!,
          retriesLeft: job.retries_left,
        })),
      };
    },
  );

  app.get(
    '/v1/jobs',
    {
      preHandler: [app.authenticate, app.requirePermission('operate:read')],
      schema: {
        tags: ['jobs'],
        summary: 'Lista jobs (cursor; filtros status/type/instanceId — Operate)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          status: z.enum(['available', 'locked', 'completed', 'failed', 'cancelled']).optional(),
          type: z.string().optional(),
          instanceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                instanceId: z.string().uuid(),
                type: z.string(),
                status: z.string(),
                retriesLeft: z.number().int(),
                error: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const page = await runtime.jobs.list(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((job) => ({
          id: job.id,
          instanceId: job.instance_id,
          type: job.type,
          status: job.status,
          retriesLeft: job.retries_left,
          error: job.error,
          createdAt: String(job.created_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
