import { describe, expect, it, vi } from 'vitest';
import {
  buildAnthropicProvider,
  createRealAiProvider,
  ProviderUnavailableError,
} from '../src/agent/anthropicProvider.js';
import { PriceMissingError, type PriceTable } from '../src/agent/priceTable.js';
import { assertRealKey, PlaceholderKeyError } from '../src/agent/providerGuards.js';

/**
 * Adaptador Anthropic — SEGUNDA impl (prova a abstração: API diferente da
 * openai-compatible). Mapeamento com `fetch` fake (sem rede); guardas na fábrica.
 */
const KEY = 'sk-ant-api03-REALKEYVALUE-abcdefghijklmnopqrstuvwxyz012345';
const fx = { USD: 5 };
const table: PriceTable = {
  version: 'anthropic-test',
  provider: 'anthropic',
  prices: { 'claude-opus-4-8': { currency: 'USD', inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 } },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('guardas duras', () => {
  it('createRealAiProvider recusa em test/CI (VITEST setado)', () => {
    expect(() => createRealAiProvider({ apiKey: KEY, model: 'claude-opus-4-8' })).toThrow(
      /NODE_ENV=test|VITEST|CI/,
    );
  });

  it('assertRealKey recusa placeholder/exemplo (inclui fixtures do repo) e aceita chave real', () => {
    expect(() => assertRealKey('plain-nothing')).toThrow(PlaceholderKeyError);
    expect(() => assertRealKey('sk-ant-xyz')).toThrow(/exemplo|curta/); // fixture do repo
    expect(() => assertRealKey('sk-ant-file-content')).toThrow(PlaceholderKeyError);
    expect(() => assertRealKey('sk-your-key-here-000000000000')).toThrow(PlaceholderKeyError);
    expect(() => assertRealKey(KEY)).not.toThrow();
  });
});

describe('mapeamento HTTP/custo (buildAnthropicProvider, fetch fake)', () => {
  it('sucesso: texto concatenado + custo real; POST /v1/messages com x-api-key', async () => {
    const fetchImpl = fakeFetch({
      content: [{ type: 'text', text: 'a ' }, { type: 'text', text: 'b' }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable: table, fxRates: fx, fetchImpl });
    const out = await p.complete('oi');
    expect(out.text).toBe('a b');
    // (1M×15 + 1M×75)/1e6 = 90 USD × 5 = 450 BRL = 45000c
    expect(out.costCents).toBeCloseTo(45000, 6);
    expect(out.costCurrency).toBe('USD');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    expect((call[1] as RequestInit).headers).toMatchObject({ 'x-api-key': KEY });
  });

  it('cache_read_input_tokens cobra mais barato', async () => {
    const fetchImpl = fakeFetch({
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
    });
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable: table, fxRates: fx, fetchImpl });
    const out = await p.complete('oi');
    // 1M cache×1,5 = 1,5 USD × 5 = 7,5 BRL = 750c
    expect(out.costCents).toBeCloseTo(750, 6);
  });

  it('modelo fora da tabela → PriceMissingError antes de gastar', async () => {
    const fetchImpl = fakeFetch({ content: [], usage: {} });
    const p = buildAnthropicProvider({ apiKey: KEY, model: 'fantasma', priceTable: table, fxRates: fx, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(PriceMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 429 → ProviderUnavailableError, SEM retry; rede rejeitada idem', async () => {
    const p429 = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable: table, fxRates: fx, fetchImpl: fakeFetch('x', 429) });
    await expect(p429.complete('oi')).rejects.toThrow(/429/);
    const netFail = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const pNet = buildAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', priceTable: table, fxRates: fx, fetchImpl: netFail });
    await expect(pNet.complete('oi')).rejects.toThrow(ProviderUnavailableError);
  });
});
