/**
 * `realWalker` — o WALKER real do host (AG-2.5). O agentflow ship NÃO tem
 * execução real: seu `AgentRunner.run?` é OPCIONAL e ABSENTE por construção
 * (cerca §0, "no network/SDK/credential"), e `simulate` é um replay de fixtures
 * que NUNCA monta prompt nem chama provider. Logo, executar o grafo com um
 * provider REAL é uma peça do HOST — este arquivo. Ele mantém o seam
 * {@link AgentWalker} idêntico: o `runAgentJob` não sabe que há rede/chave embaixo.
 *
 * Como funciona (sem reimplementar o motor do agentflow, sem gastar à toa):
 *   1. `simulate` com as fixtures atuais → `visitedNodes` (nós REALMENTE
 *      alcançados nesta rodada).
 *   2. Pega o PRIMEIRO nó `llm` visitado ainda sem saída real e chama o provider
 *      UMA vez → texto + usage REAL + custo (tabela de preço versionada).
 *   3. Grava a saída como fixture daquele nó e RE-SIMULA. Uma decisão a jusante
 *      agora roteia sobre a saída REAL, podendo mudar quais nós são alcançados.
 *   4. Repete até o ponto fixo: todo nó `llm` visitado tem saída real. Só então
 *      o walk final é determinístico sobre saídas reais.
 *
 * Por que resolver UM por vez, na ordem de visita: um nó `llm` só é pago quando
 * TODAS as decisões a montante já foram decididas por saídas reais — nunca se
 * paga por um nó que uma saída real a montante rotearia para fora do caminho.
 *
 * Paradas honestas (âmbar, trilha PARCIAL preservada):
 *   · kill-switch ENTRE passos (§5.2) — `shouldStop` no topo de cada rodada;
 *   · budget — custo REAL acumulado (não projeção) > `budget.maxCostBRL`;
 *   · provider-unavailable — erro/timeout/rate-limit (SEM retry, decisão 1);
 *   · price-missing — modelo fora da tabela (nunca estima/cobra zero).
 * Erro NÃO tipado do provider borbulha → o `runAgentJob` o trata como `walk-error`
 * (incidente vermelho) — só o esperado é âmbar.
 */
import {
  finalOutput,
  nodeIndex,
  simulate,
  type AgentWorkflow,
  type LlmNode,
  type SimulationState,
} from '@buildtovalue/agentflow';
import type { AiProvider } from './aiProvider.js';
import type { AgentWalkResult, AgentWalker } from './agentRunner.js';
import { PriceMissingError } from './priceTable.js';
import { ProviderUnavailableError } from './anthropicProvider.js';

/** Resolve o prompt de um nó `llm` (do `promptRef`/Library). INJETADO — o walker
 * não fabrica prompt (não inventa conteúdo). O piloto pluga o resolvedor da
 * Library; o ensaio passa um simples, sem tocar o walker. */
export type PromptResolver = (node: LlmNode, graph: AgentWorkflow) => string | Promise<string>;

/** Converte o texto do modelo na saída estruturada que a decisão consome. */
export type OutputParser = (text: string, node: LlmNode) => Record<string, unknown>;

export interface RealWalkerDeps {
  provider: AiProvider;
  resolvePrompt: PromptResolver;
  /** default: tenta JSON; se não for JSON, embrulha em `{ text }`. */
  parseOutput?: OutputParser;
  /** cap de micro-passos por `simulate` (default 10_000, o mesmo da lib). */
  maxSteps?: number;
}

const defaultParseOutput: OutputParser = (text) => {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return { text };
  }
};

interface LlmCall {
  nodeId: string;
  costCents: number;
  priceTableVersion?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function mapComplete(state: SimulationState, calls: LlmCall[]): AgentWalkResult {
  const totalCents = calls.reduce((s, c) => s + c.costCents, 0);
  return {
    visitedNodes: state.visitedNodes,
    steps: state.trail.length,
    stopped: null,
    blocked: state.blockedDecision
      ? { nodeId: state.blockedDecision.nodeId, cell: state.blockedDecision.cell, reason: state.blockedDecision.reason }
      : null,
    complete: state.complete,
    decisions: state.trail.filter((t) => t.type === 'decision' && t.nodeId).map((t) => t.nodeId as string),
    // paridade com o simulateWalker: `finalOutput` é a peça TESTADA da lib.
    output: finalOutput(state) ?? undefined,
    cost: { totalCents, calls },
  };
}

function blocked(
  cell: 'budget' | 'provider-unavailable' | 'price-missing',
  nodeId: string,
  reason: string,
  lastState: SimulationState | null,
  calls: LlmCall[],
): AgentWalkResult {
  const totalCents = calls.reduce((s, c) => s + c.costCents, 0);
  return {
    visitedNodes: lastState?.visitedNodes ?? [],
    steps: lastState?.trail.length ?? 0,
    stopped: null,
    blocked: { nodeId, cell, reason },
    complete: false,
    decisions: lastState?.trail.filter((t) => t.type === 'decision' && t.nodeId).map((t) => t.nodeId as string) ?? [],
    cost: { totalCents, calls },
  };
}

const fmtBRL = (cents: number): string => `R$ ${(cents / 100).toFixed(2)}`;

export function createRealWalker(deps: RealWalkerDeps): AgentWalker {
  const parseOutput = deps.parseOutput ?? defaultParseOutput;
  return async (graph, opts) => {
    const fixtures = { ...(opts.fixtures ?? {}) };
    const resolvedNodes = new Set(Object.keys(fixtures));
    const index = nodeIndex(graph);
    const budgetCents = opts.budget ? opts.budget.maxCostBRL * 100 : null;
    const calls: LlmCall[] = [];
    let accCents = 0;
    let lastState: SimulationState | null = null;

    // Cada rodada resolve exatamente UM novo nó llm; o teto é o nº de nós llm + 1.
    const llmCount = graph.nodes.filter((n) => n.type === 'llm').length;
    for (let round = 0; round <= llmCount; round++) {
      // kill-switch EM EXECUÇÃO (§5.2): re-lê a config viva entre passos.
      const stop = await opts.shouldStop();
      if (stop) {
        return {
          visitedNodes: lastState?.visitedNodes ?? [],
          steps: lastState?.trail.length ?? 0,
          stopped: stop,
          blocked: null,
          complete: false,
          cost: { totalCents: accCents, calls },
        };
      }

      lastState = simulate(graph, { fixtures, maxSteps: deps.maxSteps });
      const target = lastState.visitedNodes.find(
        (id) => index.get(id)?.type === 'llm' && !resolvedNodes.has(id),
      );
      if (!target) {
        // ponto fixo: todo nó llm visitado tem saída real → walk determinístico.
        return mapComplete(lastState, calls);
      }

      const node = index.get(target) as LlmNode;
      const prompt = await deps.resolvePrompt(node, graph);
      let completion;
      try {
        completion = await deps.provider.complete(prompt);
      } catch (err) {
        if (err instanceof PriceMissingError) {
          return blocked('price-missing', node.id, err.message, lastState, calls);
        }
        if (err instanceof ProviderUnavailableError) {
          return blocked('provider-unavailable', node.id, err.message, lastState, calls);
        }
        throw err; // não-tipado → walk-error (incidente) no runAgentJob.
      }

      const cents = completion.costCents ?? 0;
      accCents += cents;
      calls.push({
        nodeId: node.id,
        costCents: cents,
        priceTableVersion: completion.priceTableVersion,
        usage: completion.usage,
      });

      // budget: custo REAL acumulado (não a projeção do CostModel). A chamada já
      // ocorreu (dinheiro gasto) e está contabilizada; o estouro barra as próximas.
      if (budgetCents != null && accCents > budgetCents) {
        return blocked(
          'budget',
          node.id,
          `custo real ${fmtBRL(accCents)} excede o budget ${fmtBRL(budgetCents)} após ${calls.length} chamada(s)`,
          lastState,
          calls,
        );
      }

      fixtures[node.id] = { outputs: [parseOutput(completion.text, node)] };
      resolvedNodes.add(node.id);
    }

    // Não convergiu no teto de rodadas — grafo com laço patológico. Deadlock honesto.
    return {
      visitedNodes: lastState?.visitedNodes ?? [],
      steps: lastState?.trail.length ?? 0,
      stopped: null,
      blocked: { nodeId: '(walk)', cell: 'deadlock', reason: 'ponto fixo não alcançado no teto de rodadas' },
      complete: false,
      cost: { totalCents: accCents, calls },
    };
  };
}
