import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { recordTenantAuditEventTx, type AuditActor } from './tenantAudit.js';

/**
 * Export de auditoria + verificação de integridade (AG-2.3, D36/D35).
 * Shape aprovado em `docs/handoff/proposta-ag2-3-export.md` (triagem A–D do dono).
 *
 * Princípio-mãe: **evidência nunca é conteúdo**. O export carrega METADADOS de
 * procedência (ator, tipo de evento, recurso, motivo, momento, âncora), NUNCA o
 * `payload` cru nem `agent_io` — o ledger e as trilhas já não têm conteúdo
 * pessoal (aceite nomeado, §01 do dossiê) e o export não reabre essa porta.
 *
 * O problema central (§2.14.2): o envelope de ator vive em DUAS formas físicas —
 * COLUNAS em `tenant_audit_events` (governança, sem instância) e JSONB em
 * `history_events.payload->'actor'` (por instância; evento puro do engine não tem
 * ator). `normalizeActor` é UMA função com duas entradas → uma saída lógica.
 */

/** Forma física de origem de um registro. */
export type AuditSource = 'instance' | 'tenant';

export interface NormalizedActor {
  type: 'user' | 'system' | 'agent';
  id: string;
  requestId: string | null;
}

/**
 * Registro normalizado — a unidade do export. Forma ÚNICA para as duas trilhas.
 * `payload` cru NÃO entra: só estes metadados de procedência.
 */
export interface AuditExportRecord {
  source: AuditSource;
  at: string; // ISO UTC
  /** `null` = **ato do motor, sem ator** [A]: o engine avançou o token por
   * mecânica determinística (D6), sem humano/sistema/agente nomeado. Não se
   * inventa `{system,engine}` — `null` é honesto. */
  actor: NormalizedActor | null;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  motivo: string | null;
  /** ordem determinística intra-instância; `null` na trilha de tenant. */
  seq: number | null;
  anchorRef: string | null;
}

export interface AuditExportFilters {
  from?: string;
  to?: string;
  actorType?: 'user' | 'system' | 'agent';
  actorId?: string;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  source?: AuditSource | 'both';
}

/** Nível de garantia declarado pelo próprio recibo [B]. */
export type Assurance = 'self-recorded';

export interface AuditReceipt {
  digest: string; // sha256:<hex> sobre a sequência canônica de registros
  algorithm: 'sha256';
  count: number;
  filters: AuditExportFilters;
  anchorRef: string;
  /** [B] o recibo DECLARA seu próprio nível de garantia — não deixa inferir. */
  assurance: Assurance;
  assuranceNote: string;
  generatedAt: string;
  generatedBy: NormalizedActor;
}

export interface AuditExportResult {
  records: AuditExportRecord[];
  receipt: AuditReceipt;
}

export interface AuditVerifyResult {
  matches: boolean;
  expectedDigest: string;
  actualDigest: string;
  count: number;
  anchorRef: string;
}

/**
 * META-eventos da PRÓPRIA auditoria: NÃO entram no snapshot de export. São a
 * auditoria-da-auditoria — imutáveis na trilha e consultáveis à parte —, mas
 * incluí-los tornaria o digest não-reproduzível (o próprio ato de exportar grava
 * um evento que mudaria o resultado do export). Excluí-los é o que torna o
 * "mesma consulta → mesmo digest" verdadeiro. O `audit.export`/`audit.verify`
 * seguem gravados e auditáveis; só não fazem parte do conjunto de negócio.
 */
export const META_EVENT_TYPES = ['audit.export', 'audit.verify'] as const;

const ASSURANCE_NOTE =
  'Digest e âncora gravados pela própria plataforma no evento audit.export; ' +
  'ainda não há notarização externa/WAL imutável (infra do Gate de Piloto).';

/**
 * Normaliza o ator das DUAS formas físicas numa saída lógica única.
 * - `tenant`: dos campos-coluna (sempre presente — schema NOT NULL).
 * - `instance`: de `payload.actor` (pode faltar → `null`, "ato do motor").
 */
export function normalizeActor(
  source: AuditSource,
  raw: {
    actorType?: string | null;
    actorId?: string | null;
    requestId?: string | null;
    payloadActor?: { type?: string; id?: string; requestId?: string } | null;
  },
): NormalizedActor | null {
  if (source === 'tenant') {
    if (!raw.actorType || !raw.actorId) return null;
    return {
      type: raw.actorType as NormalizedActor['type'],
      id: raw.actorId,
      requestId: raw.requestId ?? null,
    };
  }
  const a = raw.payloadActor;
  if (!a || !a.type || !a.id) return null; // evento puro do engine → sem ator
  return { type: a.type as NormalizedActor['type'], id: a.id, requestId: a.requestId ?? null };
}

/** Serialização canônica: chaves ordenadas, compacta, determinística. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Digest determinístico da sequência canônica de registros. */
export function computeDigest(records: AuditExportRecord[]): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(records), 'utf8').digest('hex');
}

/** Âncora v1 [B]: auto-referência recuperável = digest + intervalo. */
function anchorOf(digest: string, from: string | null, to: string): string {
  return `${digest};from=${from ?? ''};to=${to}`;
}

/**
 * ORDEM TOTAL (determinística para o digest): por `at` asc; empate → `source`
 * (`instance` antes de `tenant`); empate → a chave física estável (seq na
 * instância; id na trilha de tenant).
 */
function compareOrdered(a: OrderedRecord, b: OrderedRecord): number {
  if (a.record.at !== b.record.at) return a.record.at < b.record.at ? -1 : 1;
  if (a.record.source !== b.record.source) return a.record.source === 'instance' ? -1 : 1;
  if (a.tiebreak !== b.tiebreak) return a.tiebreak < b.tiebreak ? -1 : 1;
  return 0;
}

interface OrderedRecord {
  record: AuditExportRecord;
  /** chave física estável por origem: `instance:<seq>` / `tenant:<id>`. */
  tiebreak: string;
}

/** Consulta AMBAS as trilhas com os filtros, normaliza, e ordena por ordem total. */
async function queryRecordsTx(
  tx: TransactionSql,
  filters: AuditExportFilters,
  effectiveTo: string,
): Promise<AuditExportRecord[]> {
  const from = filters.from ?? null;
  const source = filters.source ?? 'both';
  const ordered: OrderedRecord[] = [];

  if (source === 'tenant' || source === 'both') {
    const rows = await tx<
      Array<{
        id: string;
        actor_type: string;
        actor_id: string;
        request_id: string | null;
        event_type: string;
        resource_type: string;
        resource_id: string | null;
        motivo: string | null;
        anchor_ref: string | null;
        created_at: Date;
      }>
    >`
      SELECT id, actor_type, actor_id, request_id, event_type, resource_type,
             resource_id, motivo, anchor_ref, created_at
      FROM tenant_audit_events
      WHERE event_type <> ALL (${[...META_EVENT_TYPES]}::text[])
        ${from ? tx`AND created_at >= ${from}` : tx``}
        AND created_at <= ${effectiveTo}
        ${filters.actorType ? tx`AND actor_type = ${filters.actorType}` : tx``}
        ${filters.actorId ? tx`AND actor_id = ${filters.actorId}` : tx``}
        ${filters.eventType ? tx`AND event_type = ${filters.eventType}` : tx``}
        ${filters.resourceType ? tx`AND resource_type = ${filters.resourceType}` : tx``}
        ${filters.resourceId ? tx`AND resource_id = ${filters.resourceId}` : tx``}
      ORDER BY created_at, id`;
    for (const r of rows) {
      ordered.push({
        tiebreak: `tenant:${String(r.id).padStart(20, '0')}`,
        record: {
          source: 'tenant',
          at: r.created_at.toISOString(),
          actor: normalizeActor('tenant', {
            actorType: r.actor_type,
            actorId: r.actor_id,
            requestId: r.request_id,
          }),
          eventType: r.event_type,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          motivo: r.motivo,
          seq: null,
          anchorRef: r.anchor_ref,
        },
      });
    }
  }

  // A trilha de instância só casa `resourceType = 'instance'` (é o seu recurso).
  const instanceResourceOk = !filters.resourceType || filters.resourceType === 'instance';
  if ((source === 'instance' || source === 'both') && instanceResourceOk) {
    const rows = await tx<
      Array<{
        id: string;
        instance_id: string;
        seq: string | number;
        kind: string;
        payload: { actor?: { type?: string; id?: string; requestId?: string }; motivo?: string };
        occurred_at: Date;
      }>
    >`
      SELECT id, instance_id, seq, kind, payload, occurred_at
      FROM history_events
      WHERE occurred_at <= ${effectiveTo}
        ${from ? tx`AND occurred_at >= ${from}` : tx``}
        ${filters.actorType ? tx`AND payload->'actor'->>'type' = ${filters.actorType}` : tx``}
        ${filters.actorId ? tx`AND payload->'actor'->>'id' = ${filters.actorId}` : tx``}
        ${filters.eventType ? tx`AND kind = ${filters.eventType}` : tx``}
        ${filters.resourceId ? tx`AND instance_id::text = ${filters.resourceId}` : tx``}
      ORDER BY occurred_at, seq`;
    for (const r of rows) {
      const seqNum = Number(r.seq);
      ordered.push({
        tiebreak: `instance:${String(seqNum).padStart(20, '0')}`,
        record: {
          source: 'instance',
          at: r.occurred_at.toISOString(),
          actor: normalizeActor('instance', { payloadActor: r.payload?.actor ?? null }),
          eventType: r.kind,
          resourceType: 'instance',
          resourceId: r.instance_id,
          motivo: r.payload?.motivo ?? null,
          seq: seqNum,
          anchorRef: null,
        },
      });
    }
  }

  ordered.sort(compareOrdered);
  return ordered.map((o) => o.record);
}

/**
 * Export de auditoria. Fixa o snapshot em `now` (o `to` efetivo, gravado no
 * recibo — [C] a verificação re-roda ESTES filtros) e AUDITA a si mesmo: grava
 * o evento `audit.export` carregando **digest + intervalo + filtros + contagem**
 * (o auditor é auditado, a trilha é auto-suficiente).
 */
export async function exportAudit(
  sql: Sql,
  tenantId: string,
  filters: AuditExportFilters,
  generatedBy: NormalizedActor,
  now: string,
): Promise<AuditExportResult> {
  const effectiveTo = filters.to ?? now;
  const pinnedFilters: AuditExportFilters = { ...filters, to: effectiveTo };

  return withTenant(sql, tenantId, async (tx) => {
    const records = await queryRecordsTx(tx, pinnedFilters, effectiveTo);
    const digest = computeDigest(records);
    const anchorRef = anchorOf(digest, filters.from ?? null, effectiveTo);
    const receipt: AuditReceipt = {
      digest,
      algorithm: 'sha256',
      count: records.length,
      filters: pinnedFilters,
      anchorRef,
      assurance: 'self-recorded',
      assuranceNote: ASSURANCE_NOTE,
      generatedAt: now,
      generatedBy,
    };
    // [C] a auditoria do export carrega digest + intervalo + filtros.
    await recordTenantAuditEventTx(tx, tenantId, toAuditActor(generatedBy), {
      eventType: 'audit.export',
      resourceType: 'audit_export',
      payload: {
        digest,
        count: records.length,
        interval: { from: filters.from ?? null, to: effectiveTo },
        filters: pinnedFilters,
      },
      anchorRef,
    });
    return { records, receipt };
  });
}

/**
 * Verificação de integridade: re-executa a MESMA consulta normalizada (os
 * filtros pinados do recibo), recomputa o digest e compara. `matches:false` é
 * resultado HONESTO (a trilha mudou? o intervalo diverge?), não erro — 200. A
 * própria verificação fica na trilha (`audit.verify`).
 */
export async function verifyAudit(
  sql: Sql,
  tenantId: string,
  input: { expectedDigest: string; filters: AuditExportFilters },
  actor: NormalizedActor,
  now: string,
): Promise<AuditVerifyResult> {
  const effectiveTo = input.filters.to ?? now;
  return withTenant(sql, tenantId, async (tx) => {
    const records = await queryRecordsTx(tx, input.filters, effectiveTo);
    const actualDigest = computeDigest(records);
    const matches = actualDigest === input.expectedDigest;
    const anchorRef = anchorOf(actualDigest, input.filters.from ?? null, effectiveTo);
    await recordTenantAuditEventTx(tx, tenantId, toAuditActor(actor), {
      eventType: 'audit.verify',
      resourceType: 'audit_export',
      payload: {
        matches,
        expectedDigest: input.expectedDigest,
        actualDigest,
        count: records.length,
        filters: input.filters,
      },
      anchorRef,
    });
    return {
      matches,
      expectedDigest: input.expectedDigest,
      actualDigest,
      count: records.length,
      anchorRef,
    };
  });
}

/** Achata os registros para CSV (o `actor` vira três colunas). */
export function recordsToCsv(records: AuditExportRecord[]): string {
  const header = [
    'source',
    'at',
    'actor_type',
    'actor_id',
    'actor_request_id',
    'eventType',
    'resourceType',
    'resourceId',
    'motivo',
    'seq',
    'anchorRef',
  ];
  const escape = (v: string | number | null): string => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = records.map((r) =>
    [
      r.source,
      r.at,
      r.actor?.type ?? null,
      r.actor?.id ?? null,
      r.actor?.requestId ?? null,
      r.eventType,
      r.resourceType,
      r.resourceId,
      r.motivo,
      r.seq,
      r.anchorRef,
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function toAuditActor(a: NormalizedActor): AuditActor {
  return { type: a.type, id: a.id, ...(a.requestId ? { requestId: a.requestId } : {}) };
}
