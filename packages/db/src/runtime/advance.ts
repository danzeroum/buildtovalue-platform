import {
  STATE_SCHEMA_VERSION,
  type EngineEvent,
  type InstanceState,
} from '@buildtovalue/engine';
import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { effectKey } from './effectKey.js';
import { engineFor, SKELETON_DEFINITION_REF } from './definitions.js';
import { insertEffects, type OutboxEffect } from './outbox.js';

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
      reason: 'notFound' | 'unknownDefinition' | 'staleWait' | 'alreadyClosed' | 'invalidTransition' | 'revisionConflict';
      message: string;
    };

/**
 * StateMigrator — stub v1 (D14/F2.1): um único formato vigente. Formato mais
 * NOVO que o suportado = defeito de deploy (erro); migrações puras encadeadas
 * chegam quando existir um v2.
 */
function migrateState(state: InstanceState): InstanceState {
  if (state.stateSchemaVersion > STATE_SCHEMA_VERSION) {
    throw new Error(
      `state_schema_version ${state.stateSchemaVersion} > suportado ${STATE_SCHEMA_VERSION} — engine da plataforma desatualizado`,
    );
  }
  return state;
}

/**
 * SERVIÇO DE AVANÇO (F1.8 → base do F2.1): carrega a instância FOR UPDATE,
 * migra estado (stub), chama o engine PUBLICADO, e — na MESMA transação —
 * grava o novo estado com REVISION OTIMISTA e insere os efeitos na outbox
 * com effect_key determinística (D11). Rejeição de negócio do engine vira
 * retorno tipado (API responde 409/422); exceção interna aborta a tx.
 */
export async function advanceInstance(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  event: EngineEvent,
): Promise<AdvanceOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<InstanceRow[]>`
      SELECT id, definition_ref, engine_version, state_schema_version,
             state, revision, status, business_key
      FROM instances WHERE id = ${instanceId} FOR UPDATE`;
    const row = rows[0];
    if (!row) return { ok: false, reason: 'notFound', message: `instância ${instanceId} não existe` };
    const engine = engineFor(row.definition_ref);
    if (!engine) {
      return { ok: false, reason: 'unknownDefinition', message: `definição ${row.definition_ref} desconhecida` };
    }
    const state = migrateState(row.state);
    const result = engine.advance(state, event);
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
        revision = ${nextRevision},
        status = ${result.state.status},
        updated_at = now()
      WHERE id = ${instanceId} AND revision = ${row.revision}`;
    if (updated.count !== 1) {
      // FOR UPDATE torna isto quase impossível; se ocorrer, aborta sem efeito.
      return { ok: false, reason: 'revisionConflict', message: 'revision mudou sob a transação' };
    }
    await insertEffects(
      tx,
      tenantId,
      instanceId,
      result.effects.map((effect, index) => ({
        effectKey: effectKey(instanceId, nextRevision, index, effect.type),
        effect: effect as unknown as OutboxEffect,
      })),
    );
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
): Promise<AdvanceOutcome> {
  const definitionRef = options.definitionRef ?? SKELETON_DEFINITION_REF;
  const engine = engineFor(definitionRef);
  if (!engine) {
    return { ok: false, reason: 'unknownDefinition', message: `definição ${definitionRef} desconhecida` };
  }
  const initial = engine.initialState({ registryRef: definitionRef, bpmnVersion: '1' });
  const instanceId = await withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`
      INSERT INTO instances (tenant_id, definition_ref, engine_version,
        state_schema_version, state, status, business_key)
      VALUES (${tenantId}, ${definitionRef}, ${initial.engineVersion},
        ${initial.stateSchemaVersion}, ${tx.json(initial as never)}, 'active',
        ${options.businessKey ?? null})
      RETURNING id`;
    return row.id as string;
  });
  return advanceInstance(sql, tenantId, instanceId, {
    type: 'StartInstance',
    now,
    instanceId,
    variables: options.variables ?? {},
    ...(options.businessKey !== undefined ? { businessKey: options.businessKey } : {}),
  });
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
