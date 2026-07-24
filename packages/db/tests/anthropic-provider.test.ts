import { describe, expect, it, vi } from 'vitest';
import {
  assertRealKey,
  buildAnthropicProvider,
  createRealAiProvider,
  PlaceholderKeyError,
  ProviderUnavailableError,
} from '../src/agent/anthropicProvider.js';
import { PriceMissingError, type PriceTable } from '../src/agent/priceTable.js';

/**
 * AIProvider REAL — Anthropic (AG-2.5). Os testes NUNCA tocam a rede: o
 * mapeamento HTTP/custo é exercitado com um `fetch` fake (via `buildAnthropicProvider`,
 * o construtor SEM guarda); as GUARDAS DURAS são testadas na fábrica pública
 * `createRealAiProvider` (recusa em CI/test + chave placeholder).
 */
const KEY = 'sk-ant-api03-REALKEYVALUE-abcdefghijklmnopqrstuvwxyz012345';

const priceTable: PriceTable = {
  version: 'test-anthropic',
  provider: 'anthropic',
  prices: { 'claude-opus-4-8': { inputCentsPerMTok: 8100, outputCentsPerMTok: 40500 } },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('guardas duras (decisão-correção 2 do dono)', () => {
  it('createRealAiProvider RECUSA em ambiente de teste/CI (VITEST setado)', () => {
    // O vitest seta VITEST=true → o provider real jamais nasce no CI (D27).
    expect(() => createRealAiProvider({ apiKey: KEY, model: 'claude-opus-4-8' })).toThrow(
      /NODE_ENV=test|VITEST|CI/,
    );
  });

  it('RECUSA chave placeholder/exemplo (inclui as fixtures do repo)', () => {
    expect(() => assertRealKey('plain-nothing')).toThrow(PlaceholderKeyError);
    expect(() => assertRealKey('sk-ant-xyz')).toThrow(/exemplo|curta/); // fixture do repo
    expect(() => assertRealKey('sk-ant-file-content')).toThrow(PlaceholderKeyError);
    expect(() => assertRealKey('sk-ant-your-key-here-please-replace-me-now-000')).toThrow(
      PlaceholderKeyError,
    );
    expect(() => assertRealKey('sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toThrow(
      PlaceholderKeyError,
    );
    // chave com formato real NÃO é recusada.
    expect(() => assertRealKey(KEY)).not.toThrow();
  });

  it('a guarda de ambiente aceita produção (env injetado) mas a de chave ainda vale', () => {
    const prodEnv = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    // env de produção passa a guarda 1; chave placeholder ainda barra na guarda 2.
    expect(() =>
      createRealAiProvider({ apiKey: 'sk-ant-xyz', model: 'claude-opus-4-8', env: prodEnv }),
    ).toThrow(PlaceholderKeyError);
    // env de produção + chave real → nasce.
    expect(() =>
      createRealAiProvider({ apiKey: KEY, model: 'claude-opus-4-8', env: prodEnv, priceTable }),
    ).not.toThrow();
  });
});

describe('mapeamento HTTP/custo (buildAnthropicProvider, fetch fake — SEM rede)', () => {
  it('sucesso: texto concatenado + custo do usage REAL × tabela', async () => {
    const fetchImpl = fakeFetch({
      content: [
        { type: 'text', text: 'parte 1 ' },
        { type: 'text', text: 'parte 2' },
      ],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable, fetchImpl });
    const out = await p.complete('oi');
    expect(out.text).toBe('parte 1 parte 2');
    // 1M×8100 + 1M×40500 = 48600 centavos
    expect(out.costCents).toBe(48600);
    expect(out.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(out.priceTableVersion).toBe('test-anthropic');
    expect(out.model).toBe('claude-opus-4-8');
  });

  it('modelo fora da tabela → PriceMissingError ANTES de gastar a chamada', async () => {
    const fetchImpl = fakeFetch({ content: [], usage: {} });
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'modelo-fantasma', priceTable, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(PriceMissingError);
    // nunca chamou a rede (preço barrou antes).
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP não-2xx (ex. 429) → ProviderUnavailableError, SEM retry', async () => {
    const fetchImpl = fakeFetch('rate limited', 429);
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(ProviderUnavailableError);
    await expect(p.complete('oi')).rejects.toThrow(/429/);
    // SEM retry: cada complete chamou fetch UMA vez (2 chamadas p/ 2 completes).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rede/timeout (fetch rejeita) → ProviderUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(ProviderUnavailableError);
  });
});
