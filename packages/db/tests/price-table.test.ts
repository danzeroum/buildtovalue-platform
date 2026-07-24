import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PRICE_TABLE,
  costOf,
  DEEPSEEK_PRICE_TABLE,
  FxRateMissingError,
  isPriced,
  PriceMissingError,
  type PriceTable,
} from '../src/agent/priceTable.js';

/**
 * Tabela de preço versionada, moeda por entrada + taxa configurável (decisão (a)):
 * modelo ausente → parada honesta; moeda estrangeira sem taxa → parada honesta;
 * cache tratado explícito; o custo grava moeda + taxa + versão.
 */
describe('tabela de preço (AG-2.5, moeda + câmbio + cache)', () => {
  const usd: PriceTable = {
    version: 'test-1',
    provider: 'x',
    prices: {
      m: { currency: 'USD', inputPerMTok: 1, cachedInputPerMTok: 0.25, outputPerMTok: 2 },
      'm-brl': { currency: 'BRL', inputPerMTok: 100, outputPerMTok: 200 },
    },
  };

  it('custo USD × taxa → centavos de BRL, registrando moeda + taxa + versão', () => {
    const c = costOf(usd, 'm', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { fxRates: { USD: 5 } });
    // (1M×1 + 1M×2)/1e6 = 3 USD × 5 = 15 BRL = 1500 centavos
    expect(c.cents).toBe(1500);
    expect(c.currency).toBe('USD');
    expect(c.fxRate).toBe(5);
    expect(c.priceTableVersion).toBe('test-1');
  });

  it('cache-hit cobra pela taxa de cache (mais barato), não pela cheia', () => {
    // 1M entrada, 800k em cache → 200k cheia×1 + 800k cache×0,25 = 0,2 + 0,2 = 0,4 USD
    const c = costOf(
      usd,
      'm',
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 },
      { fxRates: { USD: 5 } },
    );
    expect(c.cents).toBeCloseTo(0.4 * 5 * 100, 6); // 200
  });

  it('provedor NÃO reporta cache → caminho normal (tudo cheio, nunca assume zero)', () => {
    const c = costOf(usd, 'm', { inputTokens: 1_000_000, outputTokens: 0 }, { fxRates: { USD: 5 } });
    expect(c.cents).toBeCloseTo(1 * 5 * 100, 6); // 500 — entrada cheia
  });

  it('moeda BRL → taxa 1, sem precisar de fxRates', () => {
    const c = costOf(usd, 'm-brl', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(c.fxRate).toBe(1);
    expect(c.cents).toBe(100 * 100); // 100 BRL /Mtok × 1M = 100 BRL = 10000c
  });

  it('moeda estrangeira SEM taxa → FxRateMissingError (nunca chuta câmbio)', () => {
    expect(() => costOf(usd, 'm', { inputTokens: 1, outputTokens: 1 })).toThrow(FxRateMissingError);
  });

  it('modelo ausente → PriceMissingError (nunca zero)', () => {
    expect(() => costOf(usd, 'zzz', { inputTokens: 1, outputTokens: 1 }, { fxRates: { USD: 5 } })).toThrow(
      PriceMissingError,
    );
  });

  it('tabelas embutidas: DeepSeek precifica chat/reasoner com cache; Anthropic exclui fable-5', () => {
    expect(isPriced(DEEPSEEK_PRICE_TABLE, 'deepseek-chat')).toBe(true);
    expect(DEEPSEEK_PRICE_TABLE.prices['deepseek-chat'].cachedInputPerMTok).toBeGreaterThan(0);
    expect(isPriced(ANTHROPIC_PRICE_TABLE, 'claude-opus-4-8')).toBe(true);
    expect(isPriced(ANTHROPIC_PRICE_TABLE, 'claude-fable-5')).toBe(false);
  });
});
