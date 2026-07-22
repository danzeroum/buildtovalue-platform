import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';

/**
 * Efeito serializado na outbox — a forma estrutural do catálogo do ADR-0001.
 * O tipo COMPLETO vem de @buildtovalue/engine (versão publicada pinada, D5)
 * no ponto de wiring; o dispatcher só discrimina `type` + campos usados.
 */
export interface OutboxEffect {
  type: string;
  waitKey?: string;
  elementId?: string;
  jobType?: string;
  payload?: Record<string, unknown>;
  kind?: string;
  message?: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  effect: OutboxEffect;
  effect_key: string;
}

/** Insere efeitos na MESMA transação do estado (D11); dedupe por effect_key. */
export async function insertEffects(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  effects: Array<{ effectKey: string; effect: OutboxEffect }>,
): Promise<void> {
  for (const { effectKey: key, effect } of effects) {
    await tx`INSERT INTO outbox (tenant_id, instance_id, effect, effect_key)
      VALUES (${tenantId}, ${instanceId}, ${tx.json(effect as never)}, ${key})
      ON CONFLICT (effect_key) DO NOTHING`;
  }
}

export interface DispatchResult {
  processed: number;
}

/**
 * UM passo do dispatcher (F1.8): consome a outbox com FOR UPDATE SKIP LOCKED
 * — O(1) amortizado por item — e aplica cada efeito DENTRO da mesma
 * transação em que a linha é removida (fila efêmera: linha despachada é
 * DELETADA). Crash em qualquer ponto = rollback = re-dispatch idempotente
 * (CreateJob deduplica por UNIQUE(wait_key); os demais são idempotentes por
 * natureza no skeleton). `onCrash` é a agulha do CRASH TEST: injetada no
 * meio do processamento, simula o kill do worker.
 */
export async function dispatchOutboxOnce(
  sql: Sql,
  tenantId: string,
  options: {
    batch?: number;
    /** hook de teste: lançar aqui simula o worker morrendo no meio. */
    onCrash?: (row: OutboxRow, index: number) => void;
    /** efeitos sem tratador dedicado (EmitHistory etc.) — log do worker. */
    onInfo?: (row: OutboxRow) => void;
  } = {},
): Promise<DispatchResult> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<OutboxRow[]>`
      SELECT id, tenant_id, instance_id, effect, effect_key
      FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${options.batch ?? 10}`;
    let index = 0;
    for (const row of rows) {
      options.onCrash?.(row, index);
      index += 1;
      const effect = row.effect;
      if (effect.type === 'CreateJob') {
        await tx`INSERT INTO jobs (tenant_id, instance_id, wait_key, type, payload)
          VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.waitKey!},
                  ${effect.jobType ?? 'noop'}, ${tx.json((effect.payload ?? {}) as never)})
          ON CONFLICT (wait_key) DO NOTHING`;
      } else {
        // CompleteInstance/EmitHistory/RaiseIncident/Close*/Cancel*: no
        // skeleton não há tabelas-alvo além de jobs (chegam na F2) — o
        // estado da instância já foi atualizado na tx do advance.
        options.onInfo?.(row);
      }
      await tx`DELETE FROM outbox WHERE id = ${row.id}`;
    }
    return { processed: rows.length };
  });
}

/** Profundidade atual da fila (métrica 9.2 + asserção dos testes). */
export async function outboxDepth(sql: Sql, tenantId: string): Promise<number> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`SELECT count(*)::int AS depth FROM outbox`;
    return row.depth as number;
  });
}
