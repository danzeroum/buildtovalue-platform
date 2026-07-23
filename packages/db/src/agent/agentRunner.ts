import type { Sql } from '../client.js';
import { getTenantAiConfig, type TenantAiConfig } from './tenantAiConfig.js';
import type { AiProvider } from './aiProvider.js';

/**
 * AgentRunner (AG-2.2 etapa 1). Handler do job `type:"agent"` — a materialização
 * do `agentTask` (ADENDO-02 D27/D29). Roda FORA de transação (D22), como todo
 * handler, e conclui pelo contrato público de jobs (o worker cuida disso).
 *
 * O INTERIOR é não-determinístico por design (D27): a chamada ao `AiProvider`
 * do tenant NÃO é reproduzível e NÃO entra no replay — só o RESULTADO (variáveis
 * que o host persiste) é determinístico. No CI o provider é o mock por fixtures
 * (custo zero, respostas fixas), então nenhuma corrida chama LLM real.
 *
 * `BlockedDecision`: sem config de inteligência, sem provider, ou erro do
 * provider → o runner NÃO finge que agiu — devolve um bloqueio com voz de
 * operador (o worker o transforma em falha → incidente). Parada honesta de
 * kill-switch em-execução e budget entram na etapa 2.
 */
export interface AgentJobPayload {
  /** prompt já materializado pelo avanço (variáveis interpoladas a montante). */
  prompt: string;
  /** nó do agentTask — nomeado no bloqueio/na trilha (voz de operador). */
  elementId?: string;
}

export type AgentBlock = 'no-config' | 'no-provider' | 'provider-error';

export type AgentRunOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; blocked: AgentBlock; message: string };

/**
 * Resolve o `AiProvider` a partir da config do tenant. No piloto constrói o
 * provider real (chave via `secret://`, nunca ecoada); nos testes injeta o
 * fixtureAiProvider. Devolver `null` = sem provider disponível (bloqueio honesto).
 */
export type ProviderResolver = (config: TenantAiConfig) => AiProvider | null;

export async function runAgentJob(
  sql: Sql,
  tenantId: string,
  payload: AgentJobPayload,
  resolveProvider: ProviderResolver,
): Promise<AgentRunOutcome> {
  const node = payload.elementId ? `'${payload.elementId}'` : 'agentTask';
  const config = await getTenantAiConfig(sql, tenantId);
  if (!config) {
    return {
      ok: false,
      blocked: 'no-config',
      message: `${node}: tenant sem inteligência configurada (tenant_ai_config) — configure o provider antes de rodar agentes`,
    };
  }
  const provider = resolveProvider(config);
  if (!provider) {
    return {
      ok: false,
      blocked: 'no-provider',
      message: `${node}: provider de IA '${config.provider}' indisponível nesta execução`,
    };
  }
  let completion;
  try {
    completion = await provider.complete(payload.prompt);
  } catch (error) {
    return {
      ok: false,
      blocked: 'provider-error',
      message: `${node}: provider falhou — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // RESULTADO determinístico que o host persiste (o interior não entra no replay).
  return {
    ok: true,
    result: {
      agentText: completion.text,
      ...(completion.costCents != null ? { agentCostCents: completion.costCents } : {}),
    },
  };
}
