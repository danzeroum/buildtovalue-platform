import type { Sql, TransactionSql } from '../client.js';
import { isEncryptedField, type FieldCipher } from '../crypto/fieldCipher.js';
import { withTenant } from '../tenancy.js';
import { classificationsFor, type DataClassification } from './definitions.js';
import { classificationsForRef } from '../registry/store.js';

/**
 * Variáveis pelo CONTRATO público (shape §4, ADENDO §3): `sensitive` SEMPRE
 * mascarada na listagem (o valor NUNCA entra no payload); revelação é ação
 * auditada com motivo OBRIGATÓRIO (decisão 10.c); edição de operador cifra
 * na escrita (D20) e audita.
 */
export interface VariableView {
  name: string;
  classification: DataClassification;
  /** ausente quando masked. */
  value?: unknown;
  masked?: true;
  updatedAt: string;
}

/**
 * Eventos de AUDITORIA do host na história: seq determinístico na faixa
 * reservada da revision vigente (base + 90000..99999 — o engine emite
 * dezenas de efeitos por avanço, nunca chega perto). O FOR UPDATE na
 * instância serializa o MAX+1; UNIQUE(instance_id, seq) é o guarda-corpo.
 */
async function insertAuditEvent(
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
    // GUARDA EXPLÍCITA (triagem 22/07): estourar a faixa de auditoria da
    // revision (10.000 eventos sem avanço do engine) é anomalia operacional
    // — erro alto, NUNCA overflow silencioso invadindo a revision seguinte.
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

/** Lista com máscara: sensitive nunca sai em claro (nem cifrada). */
export async function listVariables(
  sql: Sql,
  tenantId: string,
  instanceId: string,
): Promise<VariableView[]> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT name, value, classification, updated_at
      FROM variables WHERE instance_id = ${instanceId} ORDER BY name`;
    return rows.map((row) => {
      const classification = row.classification as DataClassification;
      if (classification === 'sensitive') {
        return { name: row.name as string, classification, masked: true as const, updatedAt: String(row.updated_at) };
      }
      return {
        name: row.name as string,
        classification,
        value: row.value as unknown,
        updatedAt: String(row.updated_at),
      };
    });
  });
}

export type RevealOutcome =
  | { ok: true; name: string; value: unknown }
  | { ok: false; reason: 'notFound' | 'notSensitive'; message: string };

/**
 * Revelação AUDITADA de UMA variável sensitive (POST .../reveal, decisão
 * 10.c): decifra em memória, grava o evento de auditoria (quem/quando/qual/
 * motivo — NUNCA o valor) na MESMA transação da leitura.
 */
export async function revealVariable(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  name: string,
  context: { actor: string; reason: string; cipher: FieldCipher },
): Promise<RevealOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`
      SELECT value, classification FROM variables
      WHERE instance_id = ${instanceId} AND name = ${name}`;
    if (!row) {
      return { ok: false, reason: 'notFound', message: `variável '${name}' não existe na instância` };
    }
    if (row.classification !== 'sensitive') {
      return {
        ok: false,
        reason: 'notSensitive',
        message: `variável '${name}' é '${String(row.classification)}' — reveal é só para sensitive (as demais já saem na listagem)`,
      };
    }
    const value = isEncryptedField(row.value)
      ? await context.cipher.decrypt(row.value)
      : (row.value as unknown);
    await insertAuditEvent(tx, tenantId, instanceId, 'sensitiveRevealed', {
      name,
      actor: context.actor,
      reason: context.reason,
    });
    return { ok: true, name, value };
  });
}

export type PatchOutcome =
  | { ok: true; updated: string[] }
  | { ok: false; reason: 'notFound'; message: string };

/**
 * Edição de variáveis pelo OPERADOR (PATCH, shape §4): classificação vem da
 * linha existente OU da declaração da definição; sensitive cifra na escrita
 * (sem KeyProvider a tx ABORTA — D20). Evento de auditoria com NOMES apenas.
 */
export async function patchVariables(
  sql: Sql,
  tenantId: string,
  instanceId: string,
  set: Record<string, unknown>,
  context: { actor: string; cipher?: FieldCipher },
): Promise<PatchOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [instance] = await tx`
      SELECT definition_ref FROM instances WHERE id = ${instanceId} FOR UPDATE`;
    if (!instance) {
      return { ok: false, reason: 'notFound', message: `instância ${instanceId} não existe` };
    }
    const embedded = classificationsFor(String(instance.definition_ref));
    const declared =
      Object.keys(embedded).length > 0
        ? embedded
        : await classificationsForRef(sql, tenantId, String(instance.definition_ref));
    const names = Object.keys(set);
    for (const [name, value] of Object.entries(set)) {
      const [existing] = await tx`
        SELECT classification FROM variables
        WHERE instance_id = ${instanceId} AND name = ${name}`;
      const classification: DataClassification =
        (existing?.classification as DataClassification | undefined) ?? declared[name] ?? 'none';
      let stored = value;
      if (classification === 'sensitive') {
        if (!context.cipher) {
          throw new Error(
            `variável '${name}' é sensitive e não há KeyProvider configurado (D20) — recusando gravar em claro`,
          );
        }
        stored = await context.cipher.encrypt(value);
      }
      await tx`INSERT INTO variables (tenant_id, instance_id, name, value, classification)
        VALUES (${tenantId}, ${instanceId}, ${name}, ${tx.json(stored as never)}, ${classification})
        ON CONFLICT (instance_id, name)
        DO UPDATE SET value = EXCLUDED.value, classification = EXCLUDED.classification,
                      updated_at = now()`;
    }
    await insertAuditEvent(tx, tenantId, instanceId, 'variablesUpdated', {
      names, // NOMES apenas — valores nunca entram na história (ADR-0002)
      actor: context.actor,
    });
    return { ok: true, updated: names };
  });
}
