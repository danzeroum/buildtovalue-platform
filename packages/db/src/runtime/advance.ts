import {
  STATE_SCHEMA_VERSION,
  type EngineEvent,
  type InstanceState,
} from '@buildtovalue/engine';
import type { Sql, TransactionSql } from '../client.js';
import { isEncryptedField, type FieldCipher } from '../crypto/fieldCipher.js';
import { withTenant } from '../tenancy.js';
import { effectKey } from './effectKey.js';
import {
  classificationsFor,
  engineFor,
  SKELETON_DEFINITION_REF,
  type DataClassification,
} from './definitions.js';
import { classificationsForRef, engineForRef } from '../registry/store.js';
import { insertEffects, OUTBOX_CHANNEL, type OutboxEffect } from './outbox.js';

export interface InstanceRow {
  id: string;
  definition_ref: string;
  engine_version: string;
  state_schema_version: number;
  state: InstanceState;
  revision: number;
  status: string;
  business_key: string | null;
}

export type AdvanceOutcome =
  | { ok: true; instance: InstanceRow }
  | {
      ok: false;
      reason:
        | 'notFound'
        | 'unknownDefinition'
        | 'staleWait'
        | 'alreadyClosed'
        | 'invalidTransition'
        | 'revisionConflict'
        | 'stateTooOld';
      message: string;
    };

/** Migração PURA de um formato de estado para o seguinte (D14). */
export type StateMigration = (state: InstanceState) => InstanceState;

/**
 * Registro de migrações encadeadas: versão N → função que produz N+1.
 * v1 é o formato vigente; quando nascer o v2, a migração 1→2 entra AQUI e
 * `STATE_SCHEMA_VERSION` do engine sobe junto. Versões anteriores à mais
 * antiga migrável são "antigas demais" → incidente pedindo intervenção
 * (nunca avanço sobre estado que não entendemos).
 */
export const STATE_MIGRATIONS: ReadonlyMap<number, StateMigration> = new Map();

export type MigrationOutcome =
  | { ok: true; state: InstanceState }
  | { ok: false; kind: 'tooOld' | 'tooNew'; message: string };

/**
 * StateMigrator (D14/F2.1): encadeia migrações puras até o formato vigente.
 * - `tooNew`: estado gravado por engine mais novo que o desta build — defeito
 *   de DEPLOY; o chamador aborta com alerta crítico (nunca vira incidente de
 *   processo).
 * - `tooOld`: não existe cadeia a partir da versão gravada — incidente.
 */
export function runStateMigrations(
  state: InstanceState,
  migrations: ReadonlyMap<number, StateMigration> = STATE_MIGRATIONS,
  target: number = STATE_SCHEMA_VERSION,
): MigrationOutcome {
  if (state.stateSchemaVersion > target) {
    return {
      ok: false,
      kind: 'tooNew',
      message: `state_schema_version ${state.stateSchemaVersion} > suportado ${target} — engine da plataforma desatualizado`,
    };
  }
  let current = state;
  while (current.stateSchemaVersion < target) {
    const step = migrations.get(current.stateSchemaVersion);
    if (!step) {
      return {
        ok: false,
        kind: 'tooOld',
        message: `state_schema_version ${state.stateSchemaVersion} antiga demais (mínimo migrável não a alcança; vigente ${target}) — intervenção necessária`,
      };
    }
    const next = step(current);
    if (next.stateSchemaVersion !== current.stateSchemaVersion + 1) {
      throw new Error(
        `migração de estado ${current.stateSchemaVersion} produziu versão ${next.stateSchemaVersion} (esperado ${current.stateSchemaVersion + 1})`,
      );
    }
    current = next;
  }
  return { ok: true, state: current };
}

/**
 * Visão imutável das variáveis persistidas (D13) — lida NA MESMA tx.
 * Campos `sensitive` cifrados em repouso são decifrados SÓ em memória para
 * o engine avaliar condições; nunca voltam em claro para log ou história.
 */
async function loadVariables(
  tx: TransactionSql,
  instanceId: string,
  cipher?: FieldCipher,
): Promise<Record<string, unknown>> {
  const rows = await tx`SELECT name, value FROM variables WHERE instance_id = ${instanceId}`;
  const vars: Record<string, unknown> = {};
  for (const row of rows) {
    const value = row.value as unknown;
    vars[row.name as string] =
      cipher && isEncryptedField(value) ? await cipher.decrypt(value) : value;
  }
  return vars;
}

/**
 * Upsert de variáveis (host, D13) com a costura LGPD (F2.6): classificação
 * declarada pela definição; `sensitive` SÓ persiste cifrada pelo FieldCipher
 * (D20) — sem KeyProvider configurado, a transação ABORTA em vez de gravar
 * em claro (fail-fast; nunca plaintext silencioso).
 */
async function upsertVariables(
  tx: TransactionSql,
  tenantId: string,
  instanceId: string,
  values: Record<string, unknown>,
  classifications: Record<string, DataClassification>,
  cipher?: FieldCipher,
): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    const classification = classifications[name] ?? 'none';
    let stored = value;
    if (classification === 'sensitive') {
      if (!cipher) {
        throw new Error(
          `variável '${name}' é sensitive e não há KeyProvider configurado (D20) — recusando gravar em claro`,
        );
      }
      stored = await cipher.encrypt(value);
    }
    await tx`INSERT INTO variables (tenant_id, instance_id, name, value, classification)
      VALUES (${tenantId}, ${instanceId}, ${name}, ${tx.json(stored as never)}, ${classification})
      ON CONFLICT (instance_id, name)
      DO UPDATE SET value = EXCLUDED.value, classification = EXCLUDED.classification,
                    updated_at = now()`;
  }
}

/**
 * SERVIÇO DE AVANÇO (F2.1): carrega a instância FOR UPDATE, roda o
 * StateMigrator (encadeado; antiga demais → INCIDENTE na mesma tx), carrega
 * as variáveis persistidas (D13), chama o engine PUBLICADO e — na MESMA
 * transação — grava o novo estado com REVISION OTIMISTA, persiste variáveis
 * novas (result/submission), insere os efeitos na outbox com effect_key
 * determinística (D11) e executa `onApplied` (âncora transacional de quem
 * dirige o evento — ex.: varredura de timers marcando 'fired'). Rejeição de
 * negócio vira retorno tipado; exceção interna aborta a tx.
 *
 * Big-O do caminho: O(1) queries por avanço + O(efeitos) inserts; o retry de
 * revisão não existe — FOR UPDATE serializa por instância.
 */
export async function advanceInstance(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  event: EngineEvent,
  hooks: { onApplied?: (tx: TransactionSql) => Promise<void>; cipher?: FieldCipher } = {},
): Promise<AdvanceOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<InstanceRow[]>`
      SELECT id, definition_ref, engine_version, state_schema_version,
             state, revision, status, business_key
      FROM instances WHERE id = ${instanceId} FOR UPDATE`;
    const row = rows[0];
    if (!row) return { ok: false, reason: 'notFound', message: `instância ${instanceId} não existe` };
    // Embutidas (skeleton@1/example@1) primeiro; depois o REGISTRY (F3.1) —
    // cache por (tenant, ref), definições imutáveis nunca ficam stale.
    const engine =
      engineFor(row.definition_ref) ?? (await engineForRef(sql, tenantId, row.definition_ref));
    if (!engine) {
      return { ok: false, reason: 'unknownDefinition', message: `definição ${row.definition_ref} desconhecida` };
    }
    const migrated = runStateMigrations(row.state);
    if (!migrated.ok) {
      if (migrated.kind === 'tooNew') {
        // Defeito de deploy: aborta a tx com alerta crítico — NUNCA vira
        // incidente de processo (plano §F2.1).
        throw new Error(migrated.message);
      }
      // Antiga demais → instância em incidente pedindo intervenção, com
      // dedupe determinístico (re-tentativas não duplicam o incidente).
      await tx`UPDATE instances SET status = 'incident', updated_at = now()
        WHERE id = ${instanceId}`;
      await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key)
        VALUES (${tenantId}, ${instanceId}, 'stateSchemaTooOld', ${migrated.message},
                ${`host:state-schema:${instanceId}:${row.state.stateSchemaVersion}`})
        ON CONFLICT (effect_key) DO NOTHING`;
      return { ok: false, reason: 'stateTooOld', message: migrated.message };
    }
    const variables = await loadVariables(tx, instanceId, hooks.cipher);
    // O que o evento PRODUZ (result do job / submission da task) entra na
    // visão de variáveis do MESMO avanço: o gateway logo após a task decide
    // sobre o que ela acabou de submeter — e é isso que se persiste abaixo.
    const produced =
      event.type === 'JobCompleted'
        ? event.result
        : event.type === 'UserTaskCompleted'
          ? event.submission
          : undefined;
    const result = engine.advance(migrated.state, {
      ...event,
      variables: { ...variables, ...event.variables, ...produced },
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.rejection.kind as 'staleWait' | 'alreadyClosed' | 'invalidTransition',
        message: result.rejection.message,
      };
    }
    const nextRevision = row.revision + 1;
    const updated = await tx`
      UPDATE instances SET
        state = ${tx.json(result.state as never)},
        state_schema_version = ${result.state.stateSchemaVersion},
        revision = ${nextRevision},
        status = ${result.state.status},
        updated_at = now()
      WHERE id = ${instanceId} AND revision = ${row.revision}`;
    if (updated.count !== 1) {
      // FOR UPDATE torna isto quase impossível; se ocorrer, aborta sem efeito.
      return { ok: false, reason: 'revisionConflict', message: 'revision mudou sob a transação' };
    }
    // D13: o engine nunca devolve variáveis — quem escreve é o HOST, aqui,
    // a partir do que o EVENTO trouxe (result do job / submission da task).
    const embedded = classificationsFor(row.definition_ref);
    const classifications =
      Object.keys(embedded).length > 0
        ? embedded
        : await classificationsForRef(sql, tenantId, row.definition_ref);
    if (event.type === 'JobCompleted' && event.result) {
      await upsertVariables(tx, tenantId, instanceId, event.result as Record<string, unknown>, classifications, hooks.cipher);
    } else if (event.type === 'UserTaskCompleted') {
      await upsertVariables(tx, tenantId, instanceId, event.submission as Record<string, unknown>, classifications, hooks.cipher);
    }
    await insertEffects(
      tx,
      tenantId,
      instanceId,
      result.effects.map((effect, index) => ({
        effectKey: effectKey(instanceId, nextRevision, index, effect.type),
        effect: effect as unknown as OutboxEffect,
        index,
      })),
      { revision: nextRevision, engineVersion: result.state.engineVersion },
    );
    if (result.effects.length > 0) {
      // Acorda o dispatcher NO COMMIT (F2.2): pg_notify dentro da tx só é
      // entregue se ela commitar; payload = tenant com trabalho novo.
      await tx`SELECT pg_notify(${OUTBOX_CHANNEL}, ${tenantId})`;
    }
    await hooks.onApplied?.(tx);
    return {
      ok: true,
      instance: { ...row, state: result.state, revision: nextRevision, status: result.state.status },
    };
  });
}

/** Cria a instância (estado inicial do engine) e aplica StartInstance. */
export async function createAndStartInstance(
  sql: Sql,
  tenantId: string,
  options: { definitionRef?: string; businessKey?: string; variables?: Record<string, unknown> },
  now: string,
  cipher?: FieldCipher,
): Promise<AdvanceOutcome> {
  const definitionRef = options.definitionRef ?? SKELETON_DEFINITION_REF;
  const engine = engineFor(definitionRef) ?? (await engineForRef(sql, tenantId, definitionRef));
  if (!engine) {
    return { ok: false, reason: 'unknownDefinition', message: `definição ${definitionRef} desconhecida` };
  }
  const initial = engine.initialState({ registryRef: definitionRef, bpmnVersion: '1' });
  const embeddedClassifications = classificationsFor(definitionRef);
  const classifications =
    Object.keys(embeddedClassifications).length > 0
      ? embeddedClassifications
      : await classificationsForRef(sql, tenantId, definitionRef);
  const instanceId = await withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`
      INSERT INTO instances (tenant_id, definition_ref, engine_version,
        state_schema_version, state, status, business_key)
      VALUES (${tenantId}, ${definitionRef}, ${initial.engineVersion},
        ${initial.stateSchemaVersion}, ${tx.json(initial as never)}, 'active',
        ${options.businessKey ?? null})
      RETURNING id`;
    const id = row.id as string;
    // Variáveis iniciais persistem ANTES do StartInstance: o avanço as lê
    // da tabela para avaliar condições já no primeiro gateway (D13).
    if (options.variables && Object.keys(options.variables).length > 0) {
      await upsertVariables(
        tx,
        tenantId,
        id,
        options.variables,
        classifications,
        cipher,
      );
    }
    return id;
  });
  return advanceInstance(
    sql,
    tenantId,
    instanceId,
    {
      type: 'StartInstance',
      now,
      instanceId,
      variables: {},
      ...(options.businessKey !== undefined ? { businessKey: options.businessKey } : {}),
    },
    { cipher },
  );
}

/** Consulta de instância (GET /v1/instances/:id). */
export async function getInstance(
  sql: Sql,
  tenantId: string,
  instanceId: string,
): Promise<InstanceRow | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<InstanceRow[]>`
      SELECT id, definition_ref, engine_version, state_schema_version,
             state, revision, status, business_key
      FROM instances WHERE id = ${instanceId}`;
    return rows[0];
  });
}
