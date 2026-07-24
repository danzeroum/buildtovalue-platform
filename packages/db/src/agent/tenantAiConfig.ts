import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { recordTenantAuditEventTx, type AuditActor } from '../audit/tenantAudit.js';
import { resumeAgentJobsTx } from './resume.js';
import { assertBaseUrl } from './providerGuards.js';

/** Provedores que o adaptador openai-compatible atende (base_url + model). */
export const OPENAI_COMPATIBLE = 'openai-compatible';

/**
 * Inteligência do tenant (ADENDO-02 D29). O segredo do provider vive SÓ como
 * referência a secret manager (`secret://…`) — jamais em claro (CHECK no banco
 * + guarda em código). Toda mudança e o kill-switch são AUDITADOS via a trilha
 * de tenant (D33), com a chave NUNCA no evento.
 *
 * kill-switch = interrupção do Art. 14 do EU AI Act. A semântica completa
 * (ADENDO-02 §5.2): em-execução faz parada honesta (no AgentRunner, AG-2.2);
 * gates humanos seguem; **novos jobs `agent` não lockam enquanto pausado**
 * (imposto aqui, no lockJobs); reativação também auditada.
 */
export interface TenantAiConfig {
  provider: string;
  /** Base URL do provedor — presente p/ openai-compatible, null p/ anthropic nativo. */
  baseUrl: string | null;
  model: string;
  keyRef: string;
  budgetCents: number | null;
  killSwitch: boolean;
}

export interface AiConfigInput {
  provider: string;
  baseUrl?: string | null;
  model: string;
  keyRef: string;
  budgetCents?: number | null;
}

export function assertSecretRef(keyRef: string): void {
  if (!keyRef.startsWith('secret://')) {
    throw new Error('key_ref deve ser uma referência a secret manager (secret://…), nunca a chave em claro (D29)');
  }
}

/**
 * Validação de provider × base_url NA ESCRITA (decisão do dono: validar no
 * upsert, não só no uso). `openai-compatible` EXIGE base_url https; `anthropic`
 * nativo IGNORA base_url (host fixo no adaptador) — nada de default silencioso.
 * Devolve a base_url normalizada a gravar (null para anthropic).
 */
export function normalizeProviderBaseUrl(provider: string, baseUrl: string | null | undefined): string | null {
  if (provider === OPENAI_COMPATIBLE) {
    return assertBaseUrl(baseUrl); // lança se ausente/malformada/não-https
  }
  return null; // anthropic (ou outro nativo): base_url não se aplica
}

export async function getTenantAiConfig(sql: Sql, tenantId: string): Promise<TenantAiConfig | null> {
  const rows = await withTenant(
    sql,
    tenantId,
    (tx) => tx`SELECT provider, base_url, model, key_ref, budget_cents, kill_switch
               FROM tenant_ai_config WHERE tenant_id = ${tenantId}`,
  );
  const r = rows[0];
  return r
    ? {
        provider: r.provider as string,
        baseUrl: (r.base_url as string | null) ?? null,
        model: r.model as string,
        keyRef: r.key_ref as string,
        budgetCents: (r.budget_cents as number | null) ?? null,
        killSwitch: r.kill_switch as boolean,
      }
    : null;
}

/** Cria/atualiza a config; auditado (sem a chave no evento). */
export async function upsertTenantAiConfig(
  sql: Sql,
  tenantId: string,
  input: AiConfigInput,
  actor: AuditActor,
): Promise<void> {
  assertSecretRef(input.keyRef);
  // Valida provider × base_url NA ESCRITA (openai-compatible exige https; anthropic ignora).
  const baseUrl = normalizeProviderBaseUrl(input.provider, input.baseUrl);
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      INSERT INTO tenant_ai_config (tenant_id, provider, base_url, model, key_ref, budget_cents)
      VALUES (${tenantId}, ${input.provider}, ${baseUrl}, ${input.model}, ${input.keyRef}, ${input.budgetCents ?? null})
      ON CONFLICT (tenant_id) DO UPDATE SET
        provider = EXCLUDED.provider, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
        key_ref = EXCLUDED.key_ref, budget_cents = EXCLUDED.budget_cents, updated_at = now()`;
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'config.ai.updated',
      resourceType: 'ai_config',
      resourceId: tenantId,
      // NUNCA registra a chave/segredo — só o que é seguro para o auditor.
      payload: { provider: input.provider, model: input.model, baseUrl },
    });
  });
}

/** Aciona/reativa o kill-switch — motivo OBRIGATÓRIO, auditado (§5.2). */
export async function setKillSwitch(
  sql: Sql,
  tenantId: string,
  killed: boolean,
  actor: AuditActor,
  motivo: string,
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    const res = await tx`
      UPDATE tenant_ai_config SET kill_switch = ${killed}, updated_at = now()
      WHERE tenant_id = ${tenantId}`;
    if (res.count === 0) {
      throw new Error('sem configuração de inteligência para este tenant');
    }
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'agent.killswitch.toggled',
      resourceType: 'ai_config',
      resourceId: tenantId,
      motivo,
      payload: { killed },
    });
    // §5.2: REATIVAR o kill-switch (→ false) devolve os agentes ao trabalho —
    // retoma AUTOMATICAMENTE os jobs pausados por kill-switch, na MESMA TX.
    if (!killed) {
      await resumeAgentJobsTx(tx, tenantId, 'kill-switch', actor, `kill-switch reativado: ${motivo}`);
    }
  });
}
