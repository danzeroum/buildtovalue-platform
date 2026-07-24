import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { recordTenantAuditEventTx, type ActorType, type AuditActor } from '../audit/tenantAudit.js';
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
  /** AG-3.2: câmbio USD→BRL por tenant (env → config). null → default do sistema. */
  fxUsdBrl: number | null;
  killSwitch: boolean;
  /** AG-3.2 (NÍVEL 2, razão reservada): quem/quando/por quê do último toggle. A
   *  `killSwitchReason` só deve ser PROJETADA pela rota admin — a rota ampla usa
   *  `getKillSwitchState`, que nem a seleciona. */
  killSwitchBy: string | null;
  killSwitchAt: string | null;
  killSwitchReason: string | null;
  updatedAt: string;
}

/** FATO do kill-switch (NÍVEL 1, amplo) — para o banner da Operação inteira.
 *  Nunca carrega a razão (reservada ao admin). */
export interface KillSwitchState {
  state: 'active' | 'paused';
  by: { type: ActorType; id: string } | null;
  since: string | null;
}

export interface AiConfigInput {
  provider: string;
  baseUrl?: string | null;
  model: string;
  keyRef: string;
  budgetCents?: number | null;
  fxUsdBrl?: number | null;
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

/**
 * Config COMPLETA do tenant (inclui a RAZÃO do kill-switch — nível 2). Serve à
 * rota admin (`ai:read-config`) e ao worker (que ignora os campos de razão). A
 * reserva da razão é imposta na PROJEÇÃO DA ROTA (a rota só a devolve a quem tem
 * `ai:configure`); a rota AMPLA nem chama esta função — usa `getKillSwitchState`.
 * NUNCA devolve a chave: `key_ref` é o PONTEIRO secret://, jamais o segredo.
 */
export async function getTenantAiConfig(sql: Sql, tenantId: string): Promise<TenantAiConfig | null> {
  const rows = await withTenant(
    sql,
    tenantId,
    (tx) => tx`SELECT provider, base_url, model, key_ref, budget_cents, fx_usd_brl,
                      kill_switch, kill_switch_by, kill_switch_at, kill_switch_reason, updated_at
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
        fxUsdBrl: r.fx_usd_brl != null ? Number(r.fx_usd_brl) : null,
        killSwitch: r.kill_switch as boolean,
        killSwitchBy: (r.kill_switch_by as string | null) ?? null,
        killSwitchAt: r.kill_switch_at != null ? String(r.kill_switch_at) : null,
        killSwitchReason: (r.kill_switch_reason as string | null) ?? null,
        updatedAt: String(r.updated_at),
      }
    : null;
}

/**
 * FATO do kill-switch para o banner AMPLO (nível 1). Projeta SÓ estado + ator +
 * quando — **nunca seleciona `kill_switch_reason`** (a reserva vive na projeção
 * SQL, não só na coluna). Sem config = agentes não pausados (`active`).
 */
export async function getKillSwitchState(sql: Sql, tenantId: string): Promise<KillSwitchState> {
  const rows = await withTenant(
    sql,
    tenantId,
    (tx) => tx`SELECT kill_switch, kill_switch_by, kill_switch_at
               FROM tenant_ai_config WHERE tenant_id = ${tenantId}`,
  );
  const r = rows[0];
  const paused = r ? (r.kill_switch as boolean) : false;
  if (!paused) return { state: 'active', by: null, since: null };
  const by = (r!.kill_switch_by as string | null) ?? null;
  return {
    state: 'paused',
    // toggle via API é sempre ator humano (admin); a trilha guarda o envelope completo.
    by: by ? { type: 'user', id: by } : null,
    since: r!.kill_switch_at != null ? String(r!.kill_switch_at) : null,
  };
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
  const fxUsdBrl = input.fxUsdBrl ?? null;
  // NÃO toca as colunas de estado do kill-switch — configurar ≠ acionar (mantém
  // o freio de segurança independente da edição da config).
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      INSERT INTO tenant_ai_config (tenant_id, provider, base_url, model, key_ref, budget_cents, fx_usd_brl)
      VALUES (${tenantId}, ${input.provider}, ${baseUrl}, ${input.model}, ${input.keyRef}, ${input.budgetCents ?? null}, ${fxUsdBrl})
      ON CONFLICT (tenant_id) DO UPDATE SET
        provider = EXCLUDED.provider, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
        key_ref = EXCLUDED.key_ref, budget_cents = EXCLUDED.budget_cents,
        fx_usd_brl = EXCLUDED.fx_usd_brl, updated_at = now()`;
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'config.ai.updated',
      resourceType: 'ai_config',
      resourceId: tenantId,
      // NUNCA registra a chave/segredo — só o que é seguro para o auditor.
      payload: { provider: input.provider, model: input.model, baseUrl, fxUsdBrl },
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
    // grava o "último estado" denormalizado (quem/quando/por quê) p/ o banner ler
    // O(1); a trilha (tenant_audit_events, abaixo) continua a fonte de verdade.
    const res = await tx`
      UPDATE tenant_ai_config
      SET kill_switch = ${killed}, kill_switch_reason = ${motivo},
          kill_switch_by = ${actor.id}, kill_switch_at = now(), updated_at = now()
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
