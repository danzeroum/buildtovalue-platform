import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import type { BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

const lintIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  elementId: z.string().optional(),
  edgeId: z.string().optional(),
});

const processSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.number().int(),
  registryRef: z.string(),
  engineVersion: z.string(),
  createdAt: z.string(),
});

const formSummarySchema = z.object({
  id: z.string().uuid(),
  formId: z.string(),
  version: z.number().int(),
  ref: z.string(),
  createdAt: z.string(),
});

const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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

/**
 * Registries do MVP (F3.1, shape /v1 §1/§2/§2b — APROVADO 22/07):
 * deploy IMUTÁVEL com lint D19 no gate (erro = 422 + issues, nada gravado);
 * /lint sem deploy para o Studio/editor; GET por ref exato para a Tasklist.
 */
export function registerDefinitionRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const registry = deps.registry;
  if (!registry) return;

  // ---- process-definitions ------------------------------------------------
  app.post(
    '/v1/process-definitions',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:deploy')],
      schema: {
        tags: ['process-definitions'],
        summary: 'Deploy imutável de uma definição de processo (lint D19 no gate)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          name: z.string().min(1).max(120),
          diagram: z.record(z.string(), z.unknown()),
        }),
        response: {
          201: processSummarySchema.extend({ warnings: z.array(lintIssueSchema) }),
          422: problemSchema.extend({ issues: z.array(lintIssueSchema) }).partial({ issues: true }),
        },
      },
    },
    async (req, reply) => {
      const outcome = await registry.deployProcess(req.auth!.tenantId, {
        name: req.body.name,
        diagram: req.body.diagram as unknown as BpmnDiagram,
        createdBy: req.auth!.sub,
      });
      if (!outcome.ok) {
        return problem(reply, 422, PROBLEM_TYPES.validation, 'Definição rejeitada pelo lint D19', String(req.id), {
          issues: outcome.issues,
        });
      }
      reply.status(201);
      return {
        id: outcome.definition.id,
        name: outcome.definition.name,
        version: outcome.definition.version,
        registryRef: outcome.definition.registry_ref,
        engineVersion: outcome.definition.engine_version,
        createdAt: String(outcome.definition.created_at),
        warnings: outcome.warnings,
      };
    },
  );

  app.post(
    '/v1/process-definitions/lint',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:deploy')],
      schema: {
        tags: ['process-definitions'],
        summary: 'Lint D19 sem deploy (mesmo motor do gate)',
        security: [{ bearerAuth: [] }],
        body: z.object({ diagram: z.record(z.string(), z.unknown()) }),
        response: { 200: z.object({ issues: z.array(lintIssueSchema) }) },
      },
    },
    async (req) => ({
      issues: registry.lintProcess(req.body.diagram as unknown as BpmnDiagram),
    }),
  );

  app.get(
    '/v1/process-definitions',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:read')],
      schema: {
        tags: ['process-definitions'],
        summary: 'Lista definições (cursor)',
        security: [{ bearerAuth: [] }],
        querystring: pageQuerySchema.extend({ name: z.string().optional() }),
        response: {
          200: z.object({
            items: z.array(processSummarySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const page = await registry.listProcesses(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((d) => ({
          id: d.id,
          name: d.name,
          version: d.version,
          registryRef: d.registry_ref,
          engineVersion: d.engine_version,
          createdAt: String(d.created_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/process-definitions/:idOrRef',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:read')],
      schema: {
        tags: ['process-definitions'],
        summary: 'Detalhe por id ou registry_ref (name@version), com diagrama',
        security: [{ bearerAuth: [] }],
        params: z.object({ idOrRef: z.string() }),
        response: {
          200: processSummarySchema.extend({ diagram: z.record(z.string(), z.unknown()) }),
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const row = await registry.getProcess(req.auth!.tenantId, req.params.idOrRef);
      if (!row) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Definição não encontrada', String(req.id));
      }
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        registryRef: row.registry_ref,
        engineVersion: row.engine_version,
        createdAt: String(row.created_at),
        diagram: row.diagram as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- form-definitions ---------------------------------------------------
  app.post(
    '/v1/form-definitions',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:deploy')],
      schema: {
        tags: ['form-definitions'],
        summary: 'Deploy imutável de um formulário (validateSchema é o gate: value reservada + dataClassification obrigatório)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          formId: z.string().min(1).max(120),
          schema: z.record(z.string(), z.unknown()),
        }),
        response: {
          201: formSummarySchema,
          422: problemSchema.extend({ issues: z.array(z.record(z.string(), z.unknown())) }).partial({ issues: true }),
        },
      },
    },
    async (req, reply) => {
      const outcome = await registry.deployForm(req.auth!.tenantId, {
        formId: req.body.formId,
        schema: req.body.schema as unknown as FormSchema,
        createdBy: req.auth!.sub,
      });
      if (!outcome.ok) {
        return problem(reply, 422, PROBLEM_TYPES.validation, 'Formulário rejeitado pelo lint', String(req.id), {
          issues: outcome.issues as unknown as Record<string, unknown>[],
        });
      }
      reply.status(201);
      return {
        id: outcome.form.id,
        formId: outcome.form.form_id,
        version: outcome.form.version,
        ref: outcome.form.ref,
        createdAt: String(outcome.form.created_at),
      };
    },
  );

  app.post(
    '/v1/form-definitions/lint',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:deploy')],
      schema: {
        tags: ['form-definitions'],
        summary: 'Lint de schema de formulário sem deploy',
        security: [{ bearerAuth: [] }],
        body: z.object({ schema: z.record(z.string(), z.unknown()) }),
        response: { 200: z.object({ issues: z.array(z.record(z.string(), z.unknown())) }) },
      },
    },
    async (req) => ({
      issues: registry.lintForm(req.body.schema as unknown as FormSchema) as unknown as Record<
        string,
        unknown
      >[],
    }),
  );

  app.get(
    '/v1/form-definitions',
    {
      preHandler: [app.authenticate, app.requirePermission('definitions:read')],
      schema: {
        tags: ['form-definitions'],
        summary: 'Lista formulários (cursor)',
        security: [{ bearerAuth: [] }],
        querystring: pageQuerySchema.extend({ formId: z.string().optional() }),
        response: {
          200: z.object({ items: z.array(formSummarySchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const page = await registry.listForms(req.auth!.tenantId, req.query);
      return {
        items: page.items.map((f) => ({
          id: f.id,
          formId: f.form_id,
          version: f.version,
          ref: f.ref,
          createdAt: String(f.created_at),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/form-definitions/:ref',
    {
      // tasks:read de propósito (shape §2b): a TASKLIST renderiza o
      // formulário pinado pelo ref exato formId@versão.
      preHandler: [app.authenticate, app.requirePermission('tasks:read')],
      schema: {
        tags: ['form-definitions'],
        summary: 'Formulário por ref exato (formId@versão) — o que a Tasklist renderiza',
        security: [{ bearerAuth: [] }],
        params: z.object({ ref: z.string() }),
        response: {
          200: formSummarySchema.extend({ schema: z.record(z.string(), z.unknown()) }),
          404: problemSchema,
        },
      },
    },
    async (req, reply) => {
      const row = await registry.getFormByRef(req.auth!.tenantId, req.params.ref);
      if (!row) {
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Formulário não encontrado', String(req.id));
      }
      return {
        id: row.id,
        formId: row.form_id,
        version: row.version,
        ref: row.ref,
        createdAt: String(row.created_at),
        schema: row.schema as unknown as Record<string, unknown>,
      };
    },
  );
}
