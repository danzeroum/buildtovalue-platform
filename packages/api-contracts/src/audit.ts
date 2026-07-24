import { z } from 'zod';

/**
 * Contrato do export de auditoria (AG-2.3, D36/D35). Shape aprovado em
 * `docs/handoff/proposta-ag2-3-export.md` (triagem A–D). Metadados de
 * procedência SÓ — nunca `payload` cru ("evidência nunca é conteúdo").
 */

const actorTypeSchema = z.enum(['user', 'system', 'agent']);
const sourceSchema = z.enum(['instance', 'tenant']);

/** Ator normalizado; `null` = "ato do motor, sem ator" [A]. */
export const normalizedActorSchema = z.object({
  type: actorTypeSchema,
  id: z.string(),
  requestId: z.string().nullable(),
});
export type NormalizedActorDto = z.infer<typeof normalizedActorSchema>;

/** Um registro do export (forma única das DUAS trilhas). */
export const auditRecordSchema = z.object({
  source: sourceSchema,
  at: z.string(),
  actor: normalizedActorSchema.nullable(),
  eventType: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  motivo: z.string().nullable(),
  seq: z.number().int().nullable(),
  anchorRef: z.string().nullable(),
});
export type AuditRecordDto = z.infer<typeof auditRecordSchema>;

/** Filtros do export (querystring do GET /v1/audit/export). */
export const auditExportQuerySchema = z.object({
  from: z.string().datetime().optional().describe('início do intervalo (ISO UTC)'),
  to: z.string().datetime().optional().describe('fim do intervalo (ISO); default = agora'),
  actorType: actorTypeSchema.optional(),
  actorId: z.string().optional(),
  eventType: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  source: z.enum(['instance', 'tenant', 'both']).default('both'),
  format: z.enum(['json', 'csv']).default('json'),
});
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

/** Os filtros como gravados no recibo (o `to` já pinado no momento do snapshot). */
export const auditFiltersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  actorType: actorTypeSchema.optional(),
  actorId: z.string().optional(),
  eventType: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  source: z.enum(['instance', 'tenant', 'both']).optional(),
});

/** Recibo: prova de que "este conjunto, com estes filtros, tem este digest". */
export const auditReceiptSchema = z.object({
  digest: z.string(),
  algorithm: z.literal('sha256'),
  count: z.number().int(),
  filters: auditFiltersSchema,
  anchorRef: z.string(),
  /** [B] o recibo declara o PRÓPRIO nível de garantia. */
  assurance: z.literal('self-recorded'),
  assuranceNote: z.string(),
  generatedAt: z.string(),
  generatedBy: normalizedActorSchema,
});
export type AuditReceiptDto = z.infer<typeof auditReceiptSchema>;

/** Resposta do export em JSON: recibo no CORPO + registros [C]. */
export const auditExportResponseSchema = z.object({
  receipt: auditReceiptSchema,
  records: z.array(auditRecordSchema),
});
export type AuditExportResponse = z.infer<typeof auditExportResponseSchema>;

/** Body do POST /v1/audit/verify: o recibo (ou o mínimo digest+filtros). */
export const auditVerifyRequestSchema = z.object({
  expectedDigest: z.string(),
  filters: auditFiltersSchema,
});
export type AuditVerifyRequest = z.infer<typeof auditVerifyRequestSchema>;

export const auditVerifyResponseSchema = z.object({
  matches: z.boolean(),
  expectedDigest: z.string(),
  actualDigest: z.string(),
  count: z.number().int(),
  anchorRef: z.string(),
});
export type AuditVerifyResponse = z.infer<typeof auditVerifyResponseSchema>;
