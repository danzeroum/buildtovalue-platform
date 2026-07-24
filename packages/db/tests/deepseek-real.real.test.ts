import { APPROVAL_GATE_AGENT } from '@buildtovalue/agentflow';
import { describe, expect, it } from 'vitest';
import { buildOpenAiCompatProvider } from '../src/agent/openaiCompatProvider.js';
import { costOf, DEEPSEEK_PRICE_TABLE } from '../src/agent/priceTable.js';
import { createRealWalker } from '../src/agent/realWalker.js';

/**
 * INTEGRAÇÃO REAL com a DeepSeek (AG-2.5, aceite da fiação do provider) — FORA do CI.
 * É o (b)→(a) desta peça: uma chamada de VERDADE prova o caminho completo, que fixture
 * nenhuma cobre. Pula sem `DEEPSEEK_API_KEY` no ambiente.
 *
 * Usa `buildOpenAiCompatProvider` (construtor SEM a guarda de test/CI) de propósito —
 * a guarda pública recusaria sob VITEST; aqui o teste É o caminho real, com chave real.
 */
const KEY = process.env.DEEPSEEK_API_KEY;
const FX = { USD: Number(process.env.FX_USD_BRL ?? '5.40') };
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

describe.skipIf(!KEY)('DeepSeek REAL — usage/custo/proposta + falha honesta', () => {
  it('chamada real: usage volta, custo do usage real (não zero), vira saída/proposta', async () => {
    const provider = buildOpenAiCompatProvider({
      apiKey: KEY!, baseUrl: BASE, model: MODEL, priceTable: DEEPSEEK_PRICE_TABLE, fxRates: FX,
    });
    const walker = createRealWalker({
      provider,
      // prompt curto e determinístico o bastante para uma saída estruturada.
      resolvePrompt: (_node, g) =>
        `Responda SOMENTE com JSON {"approved": true, "rationale": "ok"} para o agente ${g.name}.`,
    });
    const walk = await walker(APPROVAL_GATE_AGENT, { shouldStop: async () => null });

    // usage REAL veio da API
    const call = walk.cost!.calls[0];
    expect(call.usage!.inputTokens).toBeGreaterThan(0);
    expect(call.usage!.outputTokens).toBeGreaterThan(0);
    // custo = usage real × tabela (não estimado, não zero) — e BATE com o recompute.
    expect(call.costCents).toBeGreaterThan(0);
    const recompute = costOf(DEEPSEEK_PRICE_TABLE, MODEL, call.usage!, { fxRates: FX });
    expect(call.costCents).toBeCloseTo(recompute.cents, 6);
    expect(call.priceTableVersion).toBe(DEEPSEEK_PRICE_TABLE.version);
    // o resultado virou PROPOSTA (saída do walk)
    expect(walk.complete).toBe(true);
    expect(walk.output).toBeDefined();
  });

  it('chave INVÁLIDA (401) → parada honesta provider-unavailable, SEM retry', async () => {
    const provider = buildOpenAiCompatProvider({
      apiKey: 'sk-chave-invalida-de-proposito-000000000000', baseUrl: BASE, model: MODEL,
      priceTable: DEEPSEEK_PRICE_TABLE, fxRates: FX,
    });
    const walker = createRealWalker({ provider, resolvePrompt: () => 'oi' });
    const walk = await walker(APPROVAL_GATE_AGENT, { shouldStop: async () => null });
    expect(walk.complete).toBe(false);
    expect(walk.blocked?.cell).toBe('provider-unavailable');
  });
});
