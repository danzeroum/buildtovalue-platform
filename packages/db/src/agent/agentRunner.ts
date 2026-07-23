import {
  simulate,
  finalOutput,
  DEFAULT_COST_MODEL,
  type AgentWorkflow,
  type Fixtures,
  type SimulationState,
} from '@buildtovalue/agentflow';
import type { Sql } from '../client.js';
import { getTenantAiConfig } from './tenantAiConfig.js';

/**
 * AgentRunner (AG-2.2 etapa 2). Materializa o `agentTask` (ADENDO-02 D27/D29):
 * job `type:"agent"` → CAMINHA o grafo agentflow (nós llm/tool/decision). O
 * interior é não-determinístico por design (D27) e não entra no replay — só o
 * RESULTADO (variáveis que o host persiste). No CI o walk é o `simulate`
 * determinístico (fixtures, custo zero); no piloto um `run` real é injetado.
 *
 * Parada honesta (§5.2): kill-switch acionado EM EXECUÇÃO (entre passos, via
 * `shouldStop`), budget estourado (BlockedDecision da lib nomeando nó/razão/
 * contagem) ou erro NÃO fingem que agiram e NÃO descartam a trilha — devolvem os
 * fatos já emitidos (`walk` parcial) para o operador ver até onde o agente chegou.
 */
export interface AgentJobInput {
  elementId?: string;
  /** ref governado do agente (etapa 3 — registry + pin). */
  agentRef?: string;
  /** grafo INLINE — caminho DEV/TESTE (não-governado; recusado em produção). */
  graph?: AgentWorkflow;
  /** fixtures por nó — determinismo no CI. */
  fixtures?: Fixtures;
}

export interface ResolvedAgentGraph {
  graph: AgentWorkflow;
  /** true = veio do payload do job (não passou por validateGraph/versão/lint). */
  fromPayload: boolean;
}

/** Resolve o grafo por ref (padrão AiProvider/KeyProvider). Etapa 3 troca só a
 * implementação (stub de payload → registry+pin) sem tocar o walk nem os testes. */
export type AgentGraphResolver = (input: AgentJobInput) => Promise<ResolvedAgentGraph | null>;

/** Motivo de parada verificado ENTRE passos do walk (kill-switch em execução). */
export type StopReason = 'kill-switch';
export type ShouldStop = () => Promise<StopReason | null>;

/** Resultado do walk — a trilha PARCIAL sobrevive a qualquer parada honesta. */
export interface AgentWalkResult {
  visitedNodes: string[];
  steps: number;
  /** parada honesta entre passos (kill-switch em execução) — antes de bloqueio da lib. */
  stopped: StopReason | null;
  /** bloqueio da lib (budget/erro) com nó/razão. */
  blocked: { nodeId: string; cell: string; reason: string } | null;
  complete: boolean;
  output?: Record<string, unknown>;
}

/**
 * O WALKER injetado. `simulateWalker` (atômico, CI) por padrão; um `run`
 * passo-a-passo (piloto) checa `shouldStop` ENTRE passos e para honesto. O
 * runAgentJob não sabe qual é — o seam é idêntico ao AiProvider.
 */
export type AgentWalker = (
  graph: AgentWorkflow,
  opts: { fixtures?: Fixtures; budget?: { maxCostBRL: number }; shouldStop: ShouldStop },
) => Promise<AgentWalkResult>;

export type AgentBlock =
  | 'no-config'
  | 'kill-switch'
  | 'ungoverned-graph'
  | 'no-graph'
  | 'budget'
  | 'walk-error';

export interface AgentRunDeps {
  resolveGraph: AgentGraphResolver;
  /** 'production' recusa grafo de payload (não-governado). */
  nodeEnv: string;
  /** default: walker sobre agentflow.simulate (determinístico, atômico). */
  walker?: AgentWalker;
}

export type AgentRunOutcome =
  | { ok: true; result: Record<string, unknown>; walk: AgentWalkResult }
  | { ok: false; blocked: AgentBlock; message: string; walk: AgentWalkResult };

const EMPTY_WALK: AgentWalkResult = {
  visitedNodes: [],
  steps: 0,
  stopped: null,
  blocked: null,
  complete: false,
};

/**
 * Walker padrão: agentflow `simulate` (determinístico). `shouldStop` é checado
 * UMA vez antes — `simulate` é atômico, então o kill-switch mid-step é do `run`
 * real injetado (o `simulateWalker` do CI roda em microssegundos). Budget:
 * `budget_cents` (centavos de BRL) → `maxCostBRL = /100`, precificado pelo
 * `DEFAULT_COST_MODEL` (0,05 BRL por chamada llm); overflow projetado = parada
 * honesta da própria lib (`BlockedDecision cell:'budget'`).
 */
export const simulateWalker: AgentWalker = async (graph, opts) => {
  const stop = await opts.shouldStop();
  if (stop) return { ...EMPTY_WALK, stopped: stop };
  const state: SimulationState = simulate(graph, {
    fixtures: opts.fixtures,
    ...(opts.budget ? { budget: { maxCostBRL: opts.budget.maxCostBRL }, costModel: DEFAULT_COST_MODEL } : {}),
  });
  return {
    visitedNodes: state.visitedNodes,
    steps: state.trail.length,
    stopped: null,
    blocked: state.blockedDecision
      ? {
          nodeId: state.blockedDecision.nodeId,
          cell: state.blockedDecision.cell,
          reason: state.blockedDecision.reason,
        }
      : null,
    complete: state.complete,
    output: finalOutput(state) ?? undefined,
  };
};

export async function runAgentJob(
  sql: Sql,
  tenantId: string,
  input: AgentJobInput,
  deps: AgentRunDeps,
): Promise<AgentRunOutcome> {
  const node = input.elementId ? `'${input.elementId}'` : 'agentTask';
  const config = await getTenantAiConfig(sql, tenantId);
  if (!config) {
    return { ok: false, blocked: 'no-config', message: `${node}: tenant sem inteligência configurada (tenant_ai_config)`, walk: EMPTY_WALK };
  }
  // kill-switch ANTES de iniciar: nem começa (parada honesta imediata).
  if (config.killSwitch) {
    return { ok: false, blocked: 'kill-switch', message: `${node}: kill-switch acionado — agente pausado (parada honesta)`, walk: EMPTY_WALK };
  }

  const resolved = await deps.resolveGraph(input);
  if (!resolved) {
    return { ok: false, blocked: 'no-graph', message: `${node}: nenhum grafo de agente resolvido`, walk: EMPTY_WALK };
  }
  // GUARDA DURA: grafo de payload é NÃO-GOVERNADO (sem validateGraph/versão/lint)
  // — recusado em produção. Transitório sob gate; a etapa 3 deleta este caminho.
  if (resolved.fromPayload && deps.nodeEnv === 'production') {
    return {
      ok: false,
      blocked: 'ungoverned-graph',
      message: `${node}: grafo em payload recusado em produção — publique o agente no registry (etapa 3)`,
      walk: EMPTY_WALK,
    };
  }

  // kill-switch EM EXECUÇÃO (§5.2): o walker chama `shouldStop` entre passos; a
  // re-leitura da config pega o acionamento no meio da corrida. Trilha parcial preservada.
  const shouldStop: ShouldStop = async () => {
    const current = await getTenantAiConfig(sql, tenantId);
    return current?.killSwitch ? 'kill-switch' : null;
  };
  const walker = deps.walker ?? simulateWalker;
  const budget = config.budgetCents != null ? { maxCostBRL: config.budgetCents / 100 } : undefined;

  let walk: AgentWalkResult;
  try {
    walk = await walker(resolved.graph, { fixtures: input.fixtures, budget, shouldStop });
  } catch (error) {
    return { ok: false, blocked: 'walk-error', message: `${node}: walk falhou — ${error instanceof Error ? error.message : String(error)}`, walk: EMPTY_WALK };
  }

  if (walk.stopped === 'kill-switch') {
    return {
      ok: false,
      blocked: 'kill-switch',
      message: `${node}: kill-switch acionado EM EXECUÇÃO — parada honesta após ${walk.visitedNodes.length} passo(s)`,
      walk,
    };
  }
  if (walk.blocked) {
    const kind = walk.blocked.cell === 'budget' ? ('budget' as const) : ('walk-error' as const);
    return {
      ok: false,
      blocked: kind,
      message: `${node}: parada honesta em '${walk.blocked.nodeId}' — ${walk.blocked.cell}: ${walk.blocked.reason}`,
      walk,
    };
  }
  if (!walk.complete) {
    return { ok: false, blocked: 'walk-error', message: `${node}: walk não completou (deadlock)`, walk };
  }
  return { ok: true, result: { ...(walk.output ?? {}) }, walk };
}
