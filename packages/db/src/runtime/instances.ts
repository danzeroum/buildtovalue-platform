import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import type { InstanceRow } from './advance.js';

export interface InstancePage {
  items: InstanceRow[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}
// NB: nas comparações, o parâmetro do cursor entra como ::text::timestamptz
// de propósito — o describe do driver tipa o placeholder como TEXT e a
// string vai crua; sem isso o postgres.js serializa via Date e PERDE os
// microssegundos (páginas repetiriam a linha de fronteira).
function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = raw.lastIndexOf('|');
  if (at <= 0) return undefined;
  return { createdAt: raw.slice(0, at), id: raw.slice(at + 1) };
}

/** GET /v1/instances (shape §3): cursor opaco + filtros do Operate. */
export async function listInstances(
  sql: Sql,
  tenantId: string,
  options: {
    cursor?: string;
    limit?: number;
    status?: string;
    definitionRef?: string;
    businessKey?: string;
  } = {},
): Promise<InstancePage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, definition_ref, engine_version, state_schema_version,
             state, revision, status, business_key,
             created_at::text AS created_at_cursor
      FROM instances
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.definitionRef ?? null}::text IS NULL OR definition_ref = ${options.definitionRef ?? null})
        AND (${options.businessKey ?? null}::text IS NULL OR business_key = ${options.businessKey ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as InstanceRow[];
    const nextCursor =
      rows.length > limit
        ? encodeCursor(String(rows[limit - 1].created_at_cursor), String(rows[limit - 1].id))
        : null;
    return { items, nextCursor };
  });
}

export interface HistoryEventRow {
  seq: number;
  kind: string;
  payload: unknown;
  engine_version: string;
  occurred_at: string;
}

export interface HistoryPage {
  items: HistoryEventRow[];
  nextCursor: string | null;
}

/** GET /v1/instances/{id}/history (shape §3): ordenado por seq, cursor = seq. */
export async function listInstanceHistory(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const afterSeq = options.cursor ? Number(options.cursor) : -1;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT seq, kind, payload, engine_version, occurred_at
      FROM history_events
      WHERE instance_id = ${instanceId} AND seq > ${Number.isFinite(afterSeq) ? afterSeq : -1}
      ORDER BY seq
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as HistoryEventRow[];
    const nextCursor = rows.length > limit ? String(items[items.length - 1].seq) : null;
    return { items, nextCursor };
  });
}
