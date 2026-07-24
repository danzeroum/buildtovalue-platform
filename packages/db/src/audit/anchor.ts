import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { canonicalJson } from './canonical.js';
import { recordTenantAuditEventTx } from './tenantAudit.js';

/**
 * Ancoragem periódica de digest (AG-2.4, D35). O job assíncrono ancora intervalos
 * JÁ FECHADOS das trilhas append-only — SEM tocar o caminho de escrita.
 *
 * Marca d'água por SNAPSHOT (não heurística de tempo): ancora só linhas com
 * `xid < pg_snapshot_xmin(pg_current_snapshot())`. Abaixo dessa marca toda
 * transação está DECIDIDA → o intervalo em espaço-de-xid é fechado por construção
 * (nenhuma linha chega tarde). Uma âncora por intervalo, encadeada à anterior
 * (`prev_anchor_digest`) — a cadeia é de ÂNCORAS, não de linhas.
 */

export type Trail = 'tenant' | 'instance';

const GENESIS_XID = '0'; // xids reais começam em 3; '0' cobre tudo desde o início
const GENESIS_PREV = 'genesis';

export interface AnchorResult {
  ok: boolean;
  /** motivo quando nada foi ancorado nesta passada. */
  skipped?: 'locked' | 'empty';
  anchorId?: number;
  fromXid?: string;
  toXid?: string;
  rowCount?: number;
  digest?: string;
}

export interface AnchorMismatch {
  anchorId: number;
  fromXid: string;
  toXid: string;
  minCreatedAt: string | null;
  maxCreatedAt: string | null;
  reason: 'digest' | 'chain' | 'row-count';
}

export interface VerifyAnchorsResult {
  ok: boolean;
  trail: Trail;
  anchorCount: number;
  /** intervalos que divergem — APONTAM a adulteração (aceite ADENDO-03 §3). */
  mismatches: AnchorMismatch[];
}

export interface AnchorLag {
  trail: Trail;
  /** linhas commitadas ainda não cobertas por nenhuma âncora. */
  unanchoredRows: number;
  /** fronteira ancorada (max to_xid) — null se nunca ancorou. */
  frontierXid: string | null;
  frontierTime: string | null;
  lastAnchorAt: string | null;
}

const TABLE: Record<Trail, string> = {
  tenant: 'tenant_audit_events',
  instance: 'history_events',
};

/** Projeção IMUTÁVEL de uma linha para o digest (colunas append-only por trilha). */
function projectRow(trail: Trail, r: Record<string, unknown>): Record<string, unknown> {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
  if (trail === 'tenant') {
    return {
      id: String(r.id),
      xid: String(r.xid),
      actorType: r.actor_type ?? null,
      actorId: r.actor_id ?? null,
      requestId: r.request_id ?? null,
      eventType: r.event_type,
      resourceType: r.resource_type,
      resourceId: r.resource_id ?? null,
      motivo: r.motivo ?? null,
      payload: r.payload ?? null,
      anchorRef: r.anchor_ref ?? null,
      createdAt: iso(r.created_at),
    };
  }
  return {
    id: String(r.id),
    xid: String(r.xid),
    instanceId: r.instance_id,
    seq: String(r.seq),
    kind: r.kind,
    payload: r.payload ?? null,
    agentIo: r.agent_io ?? null,
    engineVersion: r.engine_version,
    occurredAt: iso(r.occurred_at),
  };
}

/** Digest encadeado do intervalo: sha256(prev || canonical(linhas projetadas)). */
function chainDigest(prevDigest: string | null, rows: Array<Record<string, unknown>>): string {
  const base = (prevDigest ?? GENESIS_PREV) + '\n' + canonicalJson(rows);
  return 'sha256:' + createHash('sha256').update(base, 'utf8').digest('hex');
}

async function fetchRowsTx(
  tx: TransactionSql,
  trail: Trail,
  fromXid: string,
  toXid: string,
): Promise<{ projected: Array<Record<string, unknown>>; minAt: Date | null; maxAt: Date | null }> {
  const tsCol = trail === 'tenant' ? 'created_at' : 'occurred_at';
  const rows =
    trail === 'tenant'
      ? await tx`
          SELECT id, xid, actor_type, actor_id, request_id, event_type, resource_type,
                 resource_id, motivo, payload, anchor_ref, created_at
          FROM tenant_audit_events
          WHERE xid >= ${fromXid}::xid8 AND xid < ${toXid}::xid8
          ORDER BY xid, id`
      : await tx`
          SELECT id, xid, instance_id, seq, kind, payload, agent_io, engine_version, occurred_at
          FROM history_events
          WHERE xid >= ${fromXid}::xid8 AND xid < ${toXid}::xid8
          ORDER BY xid, id`;
  const projected = rows.map((r) => projectRow(trail, r as Record<string, unknown>));
  const times = rows
    .map((r) => (r as Record<string, unknown>)[tsCol])
    .filter((v): v is Date => v instanceof Date);
  const minAt = times.length ? times.reduce((a, b) => (a < b ? a : b)) : null;
  const maxAt = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
  return { projected, minAt, maxAt };
}

/**
 * Ancora UMA passada de uma trilha para um tenant. Single-flight por advisory
 * xact lock (outro worker na mesma trilha/tenant apenas pula). Grava a âncora e
 * um evento de auditoria `audit.anchor.created` (que, por ter xid >= marca, cai
 * num intervalo POSTERIOR — nunca no que ele ancora).
 */
export async function anchorTrailOnce(
  sql: Sql,
  tenantId: string,
  trail: Trail,
  opts: {
    /** Override da marca d'água (SÓ testes determinísticos — `pg_snapshot_xmin` é
     * global ao cluster, então suítes paralelas o tornam não-determinístico; a
     * PRODUÇÃO nunca passa isto e usa sempre o snapshot real). */
    watermark?: string;
  } = {},
): Promise<AnchorResult> {
  return withTenant(sql, tenantId, async (tx) => {
    const lockKey = `audit-anchor:${tenantId}:${trail}`;
    const [{ locked }] = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})::bigint) AS locked`;
    if (!locked) return { ok: true, skipped: 'locked' };

    const [{ watermark }] =
      opts.watermark !== undefined
        ? [{ watermark: opts.watermark }]
        : await tx<{ watermark: string }[]>`
            SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS watermark`;
    const [head] = await tx<{ to_xid: string; digest: string }[]>`
      SELECT to_xid::text AS to_xid, digest FROM audit_anchors
      WHERE trail = ${trail} ORDER BY to_xid DESC LIMIT 1`;
    const fromXid = head?.to_xid ?? GENESIS_XID;
    const prevDigest = head?.digest ?? null;

    const { projected, minAt, maxAt } = await fetchRowsTx(tx, trail, fromXid, watermark);
    if (projected.length === 0) return { ok: true, skipped: 'empty' };

    const digest = chainDigest(prevDigest, projected);
    const [anchor] = await tx<{ id: number }[]>`
      INSERT INTO audit_anchors
        (tenant_id, trail, from_xid, to_xid, min_created_at, max_created_at,
         row_count, algorithm, digest, prev_anchor_digest)
      VALUES (${tenantId}, ${trail}, ${fromXid}::xid8, ${watermark}::xid8,
              ${minAt}, ${maxAt}, ${projected.length}, 'sha256', ${digest}, ${prevDigest})
      RETURNING id`;

    // O auditor é auditado: a âncora vira evento (metadados, nunca conteúdo).
    await recordTenantAuditEventTx(tx, tenantId, { type: 'system', id: 'anchor-job' }, {
      eventType: 'audit.anchor.created',
      resourceType: 'audit_anchor',
      resourceId: String(anchor.id),
      payload: { trail, fromXid, toXid: watermark, rowCount: projected.length, digest },
      anchorRef: digest,
    });

    return {
      ok: true,
      anchorId: anchor.id,
      fromXid,
      toXid: watermark,
      rowCount: projected.length,
      digest,
    };
  });
}

/**
 * Verifica a integridade da cadeia de âncoras: recomputa o digest de CADA
 * intervalo e a ligação `prev`. Divergência APONTA o `[from_xid, to_xid)` (e os
 * limites de tempo) — adulterar uma linha faz a verificação falhar no intervalo
 * dela (aceite ADENDO-03 §3).
 */
export async function verifyAnchors(
  sql: Sql,
  tenantId: string,
  trail: Trail,
): Promise<VerifyAnchorsResult> {
  return withTenant(sql, tenantId, async (tx) => {
    const anchors = await tx<
      Array<{
        id: number;
        from_xid: string;
        to_xid: string;
        min_created_at: Date | null;
        max_created_at: Date | null;
        row_count: number;
        digest: string;
        prev_anchor_digest: string | null;
      }>
    >`
      SELECT id, from_xid::text AS from_xid, to_xid::text AS to_xid,
             min_created_at, max_created_at, row_count, digest, prev_anchor_digest
      FROM audit_anchors WHERE trail = ${trail} ORDER BY from_xid`;

    const mismatches: AnchorMismatch[] = [];
    let expectedPrev: string | null = null;
    for (const a of anchors) {
      const { projected } = await fetchRowsTx(tx, trail, a.from_xid, a.to_xid);
      const recomputed = chainDigest(a.prev_anchor_digest, projected);
      const loc = {
        anchorId: a.id,
        fromXid: a.from_xid,
        toXid: a.to_xid,
        minCreatedAt: a.min_created_at ? a.min_created_at.toISOString() : null,
        maxCreatedAt: a.max_created_at ? a.max_created_at.toISOString() : null,
      };
      if ((a.prev_anchor_digest ?? null) !== expectedPrev) {
        mismatches.push({ ...loc, reason: 'chain' });
      } else if (projected.length !== a.row_count) {
        mismatches.push({ ...loc, reason: 'row-count' });
      } else if (recomputed !== a.digest) {
        mismatches.push({ ...loc, reason: 'digest' });
      }
      expectedPrev = a.digest;
    }
    return { ok: mismatches.length === 0, trail, anchorCount: anchors.length, mismatches };
  });
}

/** Backlog de ancoragem por trilha — alimenta a métrica de anchor-lag do worker. */
export async function anchorLag(sql: Sql, tenantId: string, trail: Trail): Promise<AnchorLag> {
  return withTenant(sql, tenantId, async (tx) => {
    const [head] = await tx<{ to_xid: string; max_created_at: Date | null; created_at: Date }[]>`
      SELECT to_xid::text AS to_xid, max_created_at, created_at FROM audit_anchors
      WHERE trail = ${trail} ORDER BY to_xid DESC LIMIT 1`;
    const frontier = head?.to_xid ?? GENESIS_XID;
    const table = TABLE[trail];
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${tx(table)} WHERE xid >= ${frontier}::xid8`;
    return {
      trail,
      unanchoredRows: n,
      frontierXid: head?.to_xid ?? null,
      frontierTime: head?.max_created_at ? head.max_created_at.toISOString() : null,
      lastAnchorAt: head?.created_at ? head.created_at.toISOString() : null,
    };
  });
}

/** Fronteira ancorada de uma trilha — consumida pelo recibo do export (§ cobertura). */
export async function anchorFrontier(
  tx: TransactionSql,
  trail: Trail,
): Promise<{ throughXid: string | null; throughTime: string | null }> {
  const [head] = await tx<{ to_xid: string; max_created_at: Date | null }[]>`
    SELECT to_xid::text AS to_xid, max_created_at FROM audit_anchors
    WHERE trail = ${trail} ORDER BY to_xid DESC LIMIT 1`;
  return {
    throughXid: head?.to_xid ?? null,
    throughTime: head?.max_created_at ? head.max_created_at.toISOString() : null,
  };
}
