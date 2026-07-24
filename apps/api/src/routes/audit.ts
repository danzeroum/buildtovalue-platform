import {
  auditExportQuerySchema,
  auditExportResponseSchema,
  auditVerifyRequestSchema,
  auditVerifyResponseSchema,
  problemSchema,
} from '@platform/api-contracts';
import { recordsToCsv, type AuditExportFilters, type NormalizedActor } from '@platform/db';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

/** 200 do export: JSON canônico (objeto) OU o CSV achatado (string bruta). */
const exportOkSchema = z.union([auditExportResponseSchema, z.string()]);

/**
 * Rotas de AUDITORIA (AG-2.3, D36/D35). Export normalizado das DUAS trilhas +
 * verificação de integridade. Permissão `audit:export` — concedida a `admin` e
 * ao papel novo `auditor` (só leitura, zero escrita). Ambas as rotas são
 * AUDITADAS na própria trilha de tenant (o auditor é auditado); o evento de
 * export carrega digest + intervalo + filtros [C].
 *
 * Princípio-mãe honrado no contrato: o export carrega SÓ metadados de
 * procedência — nunca `payload`/`agent_io` cru. "Evidência nunca é conteúdo."
 */
export function registerAuditRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return; // testes de auth puros não injetam runtime

  const generatedByOf = (sub: string, requestId: string): NormalizedActor => ({
    type: 'user',
    id: sub,
    requestId,
  });

  app.get(
    '/v1/audit/export',
    {
      preHandler: [app.authenticate, app.requirePermission('audit:export')],
      schema: {
        tags: ['audit'],
        summary: 'Exporta a trilha de auditoria normalizada + recibo com digest',
        description:
          'Normaliza as duas trilhas físicas (tenant + instância) numa forma única. ' +
          'JSON leva o recibo no corpo; CSV, no header X-Audit-Receipt. A própria ' +
          'chamada é auditada carregando digest+intervalo+filtros.',
        security: [{ bearerAuth: [] }],
        querystring: auditExportQuerySchema,
        response: { 200: exportOkSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const filters: AuditExportFilters = {
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.actorType ? { actorType: q.actorType } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.eventType ? { eventType: q.eventType } : {}),
        ...(q.resourceType ? { resourceType: q.resourceType } : {}),
        ...(q.resourceId ? { resourceId: q.resourceId } : {}),
        source: q.source,
      };
      const { records, receipt } = await runtime.audit.export(
        req.auth!.tenantId,
        filters,
        generatedByOf(req.auth!.sub, String(req.id)),
      );

      if (q.format === 'csv') {
        // O digest referenciado é SEMPRE o do JSON canônico — o formato de
        // visualização não muda a prova. O recibo viaja no header. Enviado como
        // Buffer: o Fastify passa Buffers sem serializador (o schema 200 é o JSON).
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('X-Audit-Receipt', JSON.stringify(receipt));
        return recordsToCsv(records);
      }
      return { receipt, records };
    },
  );

  app.post(
    '/v1/audit/verify',
    {
      preHandler: [app.authenticate, app.requirePermission('audit:export')],
      schema: {
        tags: ['audit'],
        summary: 'Verifica a integridade de um export (recompõe o digest)',
        description:
          're-executa a mesma consulta normalizada, recomputa o digest e compara. ' +
          'matches:false é resultado honesto (a trilha mudou), não erro — 200.',
        security: [{ bearerAuth: [] }],
        body: auditVerifyRequestSchema,
        response: { 200: auditVerifyResponseSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req) => {
      return runtime.audit.verify(
        req.auth!.tenantId,
        { expectedDigest: req.body.expectedDigest, filters: req.body.filters as AuditExportFilters },
        generatedByOf(req.auth!.sub, String(req.id)),
      );
    },
  );
}
