import { APPROVAL_GATE_AGENT, type AgentWorkflow } from '@buildtovalue/agentflow';
import { describe, expect, it, vi } from 'vitest';
import { isHonestStop, type ShouldStop } from '../src/agent/agentRunner.js';
import type { AiCompletion, AiProvider } from '../src/agent/aiProvider.js';
import { ProviderUnavailableError } from '../src/agent/anthropicProvider.js';
import { PriceMissingError } from '../src/agent/priceTable.js';
import { createRealWalker } from '../src/agent/realWalker.js';

/**
 * realWalker (AG-2.5) — o walker do HOST que executa o grafo com um provider
 * REAL (o agentflow ship não tem `run`). Aqui o provider é FAKE (sem rede): os
 * testes exercem custo real acumulado, budget, kill-switch entre passos, e as
 * paradas honestas de provider/preço. O CI nunca chama LLM real (D27).
 */
const graph: AgentWorkflow = APPROVAL_GATE_AGENT; // llm-review → dec-approve(output.approved===true)
const noStop: ShouldStop = async () => null;
const resolvePrompt = (): string => 'revise a proposta';

/** Provider fake: devolve uma completion canned (texto JSON + custo declarado). */
function cannedProvider(c: AiCompletion): AiProvider {
  return { complete: vi.fn(async () => c) };
}

describe('realWalker — walk com provider real (fake, SEM rede)', () => {
  it('caminho feliz: resolve o nó llm com saída REAL, custo acumula + versão na trilha', async () => {
    const provider = cannedProvider({
      text: JSON.stringify({ approved: true, rationale: 'ok' }),
      costCents: 5,
      usage: { inputTokens: 100, outputTokens: 50 },
      priceTableVersion: '2026-07-24',
    });
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { shouldStop: noStop });

    expect(walk.complete).toBe(true);
    expect(walk.visitedNodes).toContain('llm-review');
    expect(walk.output).toMatchObject({ approved: true });
    expect(walk.cost?.totalCents).toBe(5);
    expect(walk.cost?.calls).toHaveLength(1);
    expect(walk.cost?.calls[0]).toMatchObject({
      nodeId: 'llm-review',
      costCents: 5,
      priceTableVersion: '2026-07-24',
    });
    // provider chamado UMA vez (um nó llm no caminho).
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('budget: custo REAL acumulado > maxCostBRL → parada honesta (não projeção)', async () => {
    // completion custa 50 centavos = R$0,50; budget R$0,30 → estoura.
    const provider = cannedProvider({ text: '{"approved":true}', costCents: 50 });
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { budget: { maxCostBRL: 0.3 }, shouldStop: noStop });

    expect(walk.complete).toBe(false);
    expect(walk.blocked?.cell).toBe('budget');
    expect(walk.blocked?.reason).toMatch(/custo real/);
    // a chamada JÁ ocorreu (dinheiro gasto) e está contabilizada.
    expect(walk.cost?.totalCents).toBe(50);
    expect(isHonestStop('budget')).toBe(true);
  });

  it('budget folgado → completa (confirma a unidade centavos↔BRL)', async () => {
    const provider = cannedProvider({ text: '{"approved":true}', costCents: 5 });
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { budget: { maxCostBRL: 0.3 }, shouldStop: noStop });
    expect(walk.complete).toBe(true);
  });

  it('§5.2 kill-switch ENTRE passos: para honesto, trilha PARCIAL preservada, sem nova chamada', async () => {
    const provider = cannedProvider({ text: '{"approved":true}', costCents: 5 });
    let calls = 0;
    // null na 1ª checagem (topo da rodada 0), 'kill-switch' na 2ª (rodada 1).
    const shouldStop: ShouldStop = async () => (++calls >= 2 ? 'kill-switch' : null);
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { shouldStop });

    expect(walk.stopped).toBe('kill-switch');
    expect(walk.complete).toBe(false);
    // o nó llm rodou na rodada 0 (trilha parcial); a rodada 1 parou antes de re-simular.
    expect(walk.visitedNodes).toContain('llm-review');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('kill-switch ANTES do 1º passo → nem chama o provider', async () => {
    const provider = cannedProvider({ text: '{"approved":true}', costCents: 5 });
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { shouldStop: async () => 'kill-switch' });
    expect(walk.stopped).toBe('kill-switch');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('falha de provider (erro/timeout/rate-limit) → parada honesta provider-unavailable, SEM retry', async () => {
    const provider: AiProvider = {
      complete: vi.fn(async () => {
        throw new ProviderUnavailableError('Anthropic HTTP 429');
      }),
    };
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { shouldStop: noStop });

    expect(walk.blocked?.cell).toBe('provider-unavailable');
    expect(walk.complete).toBe(false);
    // SEM retry: uma única tentativa.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(isHonestStop('provider-unavailable')).toBe(true);
  });

  it('modelo sem preço → parada honesta price-missing (nunca cobra zero)', async () => {
    const provider: AiProvider = {
      complete: vi.fn(async () => {
        throw new PriceMissingError('modelo-x', 'v1');
      }),
    };
    const walker = createRealWalker({ provider, resolvePrompt });
    const walk = await walker(graph, { shouldStop: noStop });

    expect(walk.blocked?.cell).toBe('price-missing');
    expect(isHonestStop('price-missing')).toBe(true);
  });

  it('erro NÃO tipado do provider borbulha (→ walk-error/incidente no runAgentJob)', async () => {
    const provider: AiProvider = {
      complete: vi.fn(async () => {
        throw new Error('bug inesperado');
      }),
    };
    const walker = createRealWalker({ provider, resolvePrompt });
    await expect(walker(graph, { shouldStop: noStop })).rejects.toThrow(/bug inesperado/);
  });
});
