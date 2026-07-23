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
  payload?: unknown;
  formRef?: string;
  candidates?: string[];
  fireAt?: string;
  kind?: string;
  message?: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  effect: OutboxEffect;
  effect_key: string;
  revision: number;
  effect_index: number;
  engine_version: string;
}

/**
 * Insere efeitos na MESMA transação do estado (D11); dedupe por effect_key.
 * revision/effect_index/engine_version são os metadados do avanço que os
 * produziu — a história deriva `seq` deles, deterministicamente (G-DAD-2).
 */
export async function insertEffects(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  effects: Array<{ effectKey: string; effect: OutboxEffect; index?: number }>,
  meta: { revision?: number; engineVersion?: string } = {},
): Promise<void> {
  let position = 0;
  for (const { effectKey: key, effect, index } of effects) {
    await tx`INSERT INTO outbox
        (tenant_id, instance_id, effect, effect_key, revision, effect_index, engine_version)
      VALUES (${tenantId}, ${instanceId}, ${tx.json(effect as never)}, ${key},
        ${meta.revision ?? 0}, ${index ?? position}, ${meta.engineVersion ?? ''})
      ON CONFLICT (effect_key) DO NOTHING`;
    position += 1;
  }
}

/**
 * seq da história: monotônico POR INSTÂNCIA (com lacunas), derivado de
 * (revision, effect_index) — determinístico sob re-dispatch, então o crash
 * do worker reproduz o MESMO seq e a UNIQUE(effect_key) deduplica. O engine
 * emite um punhado de efeitos por avanço (run-to-quiescence sobre diagrama
 * finito); 100000 por revision é folga de ordens de magnitude.
 */
export function historySeq(revision: number, effectIndex: number): number {
  return revision * 100_000 + effectIndex;
}

/** Canal do pg_notify emitido no COMMIT do avanço (payload = tenant_id). */
export const OUTBOX_CHANNEL = 'btv_outbox';

export interface DispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Backoff exponencial (segundos) por tentativa, teto de 60s. */
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 60);
}

/**
 * UM passo do dispatcher (F2.2): consome a outbox com FOR UPDATE SKIP LOCKED
 * — O(1) amortizado por item: cada linha é visitada uma vez por passada e o
 * índice outbox_ready_idx entrega só as prontas — e aplica cada efeito
 * DENTRO da mesma transação em que a linha é removida (fila efêmera: linha
 * despachada é DELETADA). Crash em qualquer ponto = rollback = re-dispatch
 * idempotente: cada tratador tem uma âncora de dedupe (UNIQUE wait_key em
 * jobs/timers/user_tasks; UNIQUE effect_key em history_events/incidents;
 * UPDATEs condicionados a estado). `onCrash` é a agulha do CRASH TEST.
 *
 * Efeito que FALHA ao aplicar (defeito de dado, não crash): SAVEPOINT por
 * linha isola a falha — as demais linhas do lote seguem; a linha ganha
 * backoff exponencial (2^n s, teto 60s) e, esgotadas as tentativas,
 * DEAD-LETTER: vira incidente (kind 'effectDispatchFailed', dedupe por
 * effect_key) e sai da fila.
 */
export async function dispatchOutboxOnce(
  sql: Sql,
  tenantId: string,
  options: {
    batch?: number;
    /** tentativas até dead-letter (default 5). */
    maxAttempts?: number;
    /** hook de teste: lançar aqui simula o worker morrendo no meio. */
    onCrash?: (row: OutboxRow, index: number) => void;
    /** efeitos sem escrita local (CompleteInstance) — log do worker. */
    onInfo?: (row: OutboxRow) => void;
  } = {},
): Promise<DispatchResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<(OutboxRow & { attempts: number })[]>`
      SELECT id, tenant_id, instance_id, effect, effect_key,
             revision, effect_index, engine_version, attempts
      FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${options.batch ?? 10}`;
    const result: DispatchResult = { processed: 0, failed: 0, deadLettered: 0 };
    let index = 0;
    for (const row of rows) {
      // onCrash fica FORA do savepoint de propósito: simula o processo
      // morrendo (rollback do lote inteiro), não um efeito defeituoso.
      options.onCrash?.(row, index);
      index += 1;
      try {
        await tx.savepoint(async (sp) => {
          await applyEffect(sp, row, options.onInfo);
          await sp`DELETE FROM outbox WHERE id = ${row.id}`;
        });
        result.processed += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= maxAttempts) {
          // D22 (AG-2.1): guarda o efeito no incidente para o /retry
          // re-enfileirar (fecha a ERRATA §7). Só metadados de efeito — nunca
          // conteúdo pessoal (o efeito é a intenção de despacho, não payload
          // de formulário).
          await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key, payload)
            VALUES (${row.tenant_id}, ${row.instance_id}, 'effectDispatchFailed',
                    ${`efeito ${row.effect.type} falhou ${attempts}x: ${message}`},
                    ${`host:dead-letter:${row.effect_key}`},
                    ${tx.json({
                      effect: row.effect,
                      effectKey: row.effect_key,
                      revision: row.revision,
                      effectIndex: row.effect_index,
                      engineVersion: row.engine_version,
                    } as never)})
            ON CONFLICT (effect_key) DO NOTHING`;
          await tx`DELETE FROM outbox WHERE id = ${row.id}`;
          result.deadLettered += 1;
        } else {
          await tx`UPDATE outbox SET
              attempts = ${attempts},
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds(attempts)})
            WHERE id = ${row.id}`;
          result.failed += 1;
        }
      }
    }
    return result;
  });
}

/** Aplica UM efeito nas tabelas do runtime (migrações 0002/0003). */
async function applyEffect(
  tx: TransactionSql,
  row: OutboxRow,
  onInfo?: (row: OutboxRow) => void,
): Promise<void> {
  const effect = row.effect;
  switch (effect.type) {
    case 'CreateJob': {
      // SUBSTITUIÇÃO DO PIN (AG-2.2 etapa 4): o engine emite `agent` com a ref
      // DECLARADA no payload; o host a troca pela EFETIVA, lida da tabela
      // OPERACIONAL `instance_agent_pins` (resolvida no start) — NUNCA da trilha
      // (auditoria ≠ execução, D13/D32). Grava as DUAS refs (auditor vê "declarou
      // @latest, rodou @1.2.0"). Pin ausente → incidente `agentPinMissing`; JAMAIS
      // resolver aqui (seria a resolução flutuante voltando pela porta dos fundos).
      if (effect.jobType === 'agent') {
        const payload = (effect.payload ?? {}) as { elementId?: unknown };
        const elementId = typeof payload.elementId === 'string' ? payload.elementId : undefined;
        const pinRows = elementId
          ? await tx<{ declared_ref: string; effective_ref: string }[]>`
              SELECT declared_ref, effective_ref FROM instance_agent_pins
              WHERE instance_id = ${row.instance_id} AND element_id = ${elementId}`
          : [];
        const pin = pinRows[0];
        if (!pin) {
          await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key)
            VALUES (${row.tenant_id}, ${row.instance_id}, 'agentPinMissing',
                    ${`agentTask '${elementId ?? '?'}' sem pin operacional — o start não resolveu (nunca resolver no despacho)`},
                    ${row.effect_key})
            ON CONFLICT (effect_key) DO NOTHING`;
          return;
        }
        const agentPayload = { elementId, declaredRef: pin.declared_ref, effectiveRef: pin.effective_ref };
        await tx`INSERT INTO jobs (tenant_id, instance_id, wait_key, type, payload)
          VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.waitKey!}, 'agent',
                  ${tx.json(agentPayload as never)})
          ON CONFLICT (wait_key) DO NOTHING`;
        return;
      }
      await tx`INSERT INTO jobs (tenant_id, instance_id, wait_key, type, payload)
        VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.waitKey!},
                ${effect.jobType ?? 'noop'}, ${tx.json((effect.payload ?? {}) as never)})
        ON CONFLICT (wait_key) DO NOTHING`;
      return;
    }
    case 'CancelJob':
      // Job cancelado não conclui: sai de available/locked; conclusão tardia
      // com token antigo cai no fencing (409). Terminais ficam como estão.
      await tx`UPDATE jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL
        WHERE wait_key = ${effect.waitKey!} AND status IN ('available','locked')`;
      return;
    case 'ScheduleTimer':
      await tx`INSERT INTO timers (tenant_id, instance_id, element_id, wait_key, fire_at)
        VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.elementId!},
                ${effect.waitKey!}, ${effect.fireAt!})
        ON CONFLICT (wait_key) DO NOTHING`;
      return;
    case 'CancelTimer':
      await tx`UPDATE timers SET status = 'cancelled'
        WHERE wait_key = ${effect.waitKey!} AND status = 'armed'`;
      return;
    case 'OpenUserTask':
      await tx`INSERT INTO user_tasks
          (tenant_id, instance_id, element_id, wait_key, form_ref, candidate_roles, payload)
        VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.elementId!},
                ${effect.waitKey!}, ${effect.formRef ?? ''},
                ${effect.candidates ?? []},
                ${tx.json((effect.payload ?? {}) as never)})
        ON CONFLICT (wait_key) DO NOTHING`;
      return;
    case 'CloseUserTask':
      // Fechamento pelo ENGINE (boundary interruptivo/cancelamento): a task
      // some da Tasklist. Conclusão pelo usuário marca 'completed' na rota.
      await tx`UPDATE user_tasks SET status = 'cancelled', completed_at = now()
        WHERE wait_key = ${effect.waitKey!} AND status = 'open'`;
      return;
    case 'EmitHistory':
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
        VALUES (${row.tenant_id}, ${row.instance_id},
                ${historySeq(row.revision, row.effect_index)},
                ${effect.kind!}, ${tx.json((effect.payload ?? {}) as never)},
                ${row.engine_version}, ${row.effect_key})
        ON CONFLICT (effect_key) DO NOTHING`;
      return;
    case 'RaiseIncident':
      await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key)
        VALUES (${row.tenant_id}, ${row.instance_id}, ${effect.kind!},
                ${effect.message ?? ''}, ${row.effect_key})
        ON CONFLICT (effect_key) DO NOTHING`;
      return;
    default:
      // CompleteInstance: o estado/status já foi gravado na tx do avanço; a
      // história vem do EmitHistory 'instanceCompleted'. Nada a escrever.
      onInfo?.(row);
  }
}

/** Profundidade atual da fila (métrica 9.2 + asserção dos testes). */
export async function outboxDepth(sql: Sql, tenantId: string): Promise<number> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`SELECT count(*)::int AS depth FROM outbox`;
    return row.depth as number;
  });
}
