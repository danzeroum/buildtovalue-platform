import { describe, expect, it, vi } from 'vitest';
import { ProviderUnavailableError } from '../src/agent/anthropicProvider.js';
import {
  buildOpenAiCompatProvider,
  createOpenAiCompatProvider,
} from '../src/agent/openaiCompatProvider.js';
import { PriceMissingError, type PriceTable } from '../src/agent/priceTable.js';
import { PlaceholderKeyError, ProviderConfigError } from '../src/agent/providerGuards.js';

/**
 * Adaptador OpenAI-compatible (DeepSeek/Groq/Together/OpenRouter/local) — a
 * PRIMEIRA impl. Mapeamento HTTP/custo com `fetch` fake (SEM rede); guardas na
 * fábrica pública (CI/test + placeholder + base URL obrigatória/https).
 */
const KEY = 'sk-deepseek-REALKEY-abcdefghijklmnop0123456789';
const BASE = 'https://api.deepseek.com';
const fx = { USD: 5 };

const table: PriceTable = {
  version: 'ds-test',
  provider: 'deepseek',
  prices: { 'deepseek-chat': { currency: 'USD', inputPerMTok: 0.27, cachedInputPerMTok: 0.07, outputPerMTok: 1.1 } },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('guardas (openai-compatible)', () => {
  it('recusa em test/CI (VITEST setado)', () => {
    expect(() =>
      createOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'deepseek-chat', priceTable: table, fxRates: fx }),
    ).toThrow(/NODE_ENV=test|VITEST|CI/);
  });

  it('em produção: recusa base URL ausente e não-https; aceita https', () => {
    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() =>
      createOpenAiCompatProvider({ apiKey: KEY, baseUrl: '', model: 'deepseek-chat', priceTable: table, env: prod }),
    ).toThrow(/base_url obrigatória/);
    expect(() =>
      createOpenAiCompatProvider({ apiKey: KEY, baseUrl: 'http://api.deepseek.com', model: 'deepseek-chat', priceTable: table, env: prod }),
    ).toThrow(/https/);
    expect(() =>
      createOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'deepseek-chat', priceTable: table, fxRates: fx, env: prod }),
    ).not.toThrow();
  });

  it('em produção: recusa chave placeholder', () => {
    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() =>
      createOpenAiCompatProvider({ apiKey: 'sk-your-key-here', baseUrl: BASE, model: 'deepseek-chat', priceTable: table, env: prod }),
    ).toThrow(PlaceholderKeyError);
  });

  it('ProviderConfigError é a base das recusas de config', () => {
    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() =>
      createOpenAiCompatProvider({ apiKey: KEY, baseUrl: 'nonsense', model: 'deepseek-chat', priceTable: table, env: prod }),
    ).toThrow(ProviderConfigError);
  });
});

describe('mapeamento HTTP/custo (buildOpenAiCompatProvider, fetch fake)', () => {
  it('sucesso: content + custo do usage real; POST em /chat/completions com Bearer', async () => {
    const fetchImpl = fakeFetch({
      choices: [{ message: { content: 'resposta' } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    });
    const p = buildOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'deepseek-chat', priceTable: table, fxRates: fx, fetchImpl });
    const out = await p.complete('oi');
    expect(out.text).toBe('resposta');
    // (1M×0,27 + 1M×1,10)/1e6 = 1,37 USD × 5 = 6,85 BRL = 685c
    expect(out.costCents).toBeCloseTo(685, 6);
    expect(out.costCurrency).toBe('USD');
    expect(out.fxRate).toBe(5);
    expect(out.priceTableVersion).toBe('ds-test');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.deepseek.com/chat/completions');
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it('CACHE reportado (prompt_cache_hit_tokens) cobra mais barato — budget não estoura antes', async () => {
    const fetchImpl = fakeFetch({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 900_000, prompt_cache_miss_tokens: 100_000 },
    });
    const p = buildOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'deepseek-chat', priceTable: table, fxRates: fx, fetchImpl });
    const out = await p.complete('oi');
    // 100k cheia×0,27 + 900k cache×0,07 = 0,027 + 0,063 = 0,09 USD × 5 = 45c
    expect(out.costCents).toBeCloseTo(45, 6);
    expect(out.usage?.cachedInputTokens).toBe(900_000);
  });

  it('modelo fora da tabela → PriceMissingError antes de gastar', async () => {
    const fetchImpl = fakeFetch({ choices: [], usage: {} });
    const p = buildOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'fantasma', priceTable: table, fxRates: fx, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(PriceMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 429 → ProviderUnavailableError, SEM retry', async () => {
    const fetchImpl = fakeFetch('rate limited', 429);
    const p = buildOpenAiCompatProvider({ apiKey: KEY, baseUrl: BASE, model: 'deepseek-chat', priceTable: table, fxRates: fx, fetchImpl });
    await expect(p.complete('oi')).rejects.toThrow(ProviderUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
