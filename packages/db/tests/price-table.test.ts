import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PRICE_TABLE,
  costOf,
  isPriced,
  PriceMissingError,
  type PriceTable,
} from '../src/agent/priceTable.js';

/**
 * Tabela de preço versionada (AG-2.5). As DUAS regras que a tornam honesta:
 * modelo ausente → parada honesta (nunca zero), e o custo carrega a VERSÃO que
 * o calculou.
 */
describe('tabela de preço (AG-2.5)', () => {
  const table: PriceTable = {
    version: 'test-1',
    provider: 'anthropic',
    prices: { m1: { inputCentsPerMTok: 1000, outputCentsPerMTok: 2000 } },
  };

  it('custo = usage real × preço, em centavos de BRL', () => {
    const c = costOf(table, 'm1', { inputTokens: 1_000_000, outputTokens: 500_000 });
    // 1M in × 1000c/M = 1000c ; 0,5M out × 2000c/M = 1000c → 2000c
    expect(c.cents).toBe(2000);
    expect(c.model).toBe('m1');
    expect(c.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000 });
  });

  it('grava QUAL VERSÃO calculou o custo (auditável)', () => {
    const c = costOf(table, 'm1', { inputTokens: 10, outputTokens: 10 });
    expect(c.priceTableVersion).toBe('test-1');
  });

  it('modelo AUSENTE → PriceMissingError (parada honesta, NUNCA zero)', () => {
    expect(() => costOf(table, 'inexistente', { inputTokens: 1, outputTokens: 1 })).toThrow(
      PriceMissingError,
    );
    expect(() => costOf(table, 'inexistente', { inputTokens: 1, outputTokens: 1 })).toThrow(
      /modelo sem tabela de preço/,
    );
    expect(isPriced(table, 'inexistente')).toBe(false);
    expect(isPriced(table, 'm1')).toBe(true);
  });

  it('a tabela embutida da Anthropic precifica os modelos correntes e EXCLUI fable-5 (regra 1)', () => {
    expect(isPriced(ANTHROPIC_PRICE_TABLE, 'claude-opus-4-8')).toBe(true);
    expect(isPriced(ANTHROPIC_PRICE_TABLE, 'claude-sonnet-5')).toBe(true);
    // fable-5 fora de propósito → exercita a parada honesta no piloto.
    expect(isPriced(ANTHROPIC_PRICE_TABLE, 'claude-fable-5')).toBe(false);
    expect(ANTHROPIC_PRICE_TABLE.version).toBeTruthy();
  });
});
