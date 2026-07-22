import type { TransactionSql } from '../client.js';

/**
 * Eventos de AUDITORIA do host na história (reveal/patch/reatribuição):
 * seq determinístico na faixa RESERVADA da revision vigente
 * (base + 90000..99999 — aritmética completa em pendencias.md §2.9). O
 * FOR UPDATE na instância serializa o MAX+1; UNIQUE(instance_id, seq) é o
 * guarda-corpo físico; estourar a faixa é ERRO alto, nunca overflow.
 */
export async function insertAuditEvent(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const [instance] = await tx`
    SELECT revision, engine_version FROM instances WHERE id = ${instanceId} FOR UPDATE`;
  if (!instance) throw new Error(`instância ${instanceId} não existe`);
  const base = (instance.revision as number) * 100_000 + 90_000;
  const ceiling = (instance.revision as number) * 100_000 + 100_000;
  const [next] = await tx`
    SELECT COALESCE(MAX(seq), ${base - 1}) + 1 AS seq
    FROM history_events
    WHERE instance_id = ${instanceId} AND seq >= ${base} AND seq < ${ceiling}`;
  if (Number(next.seq) >= ceiling) {
    throw new Error(
      `faixa de auditoria esgotada na instância ${instanceId} (revision ${String(instance.revision)}: ${ceiling - base} eventos) — investigar loop de auditoria`,
    );
  }
  await tx`INSERT INTO history_events
      (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
    VALUES (${tenantId}, ${instanceId}, ${next.seq as number}, ${kind},
            ${tx.json(payload as never)}, ${String(instance.engine_version)},
            ${`host:audit:${instanceId}:${next.seq}`})`;
}
