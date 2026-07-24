import { describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '../src/agent/aiProvider.js';
import { buildAnthropicProvider } from '../src/agent/anthropicProvider.js';
import { buildOpenAiCompatProvider } from '../src/agent/openaiCompatProvider.js';
import type { PriceTable } from '../src/agent/priceTable.js';

/**
 * A abstração É abstração (exigência do dono): DUAS APIs diferentes (Anthropic
 * `x-api-key`/`content[]`/`input_tokens` vs OpenAI-compat `Bearer`/`choices[]`/
 * `prompt_tokens`) atrás da MESMA interface `AiProvider`. Um consumidor que só
 * conhece `AiProvider.complete` recebe a MESMA forma de `AiCompletion` das duas —
 * é isso que garante que trocar de provedor não toca o walker.
 */
const fx = { USD: 5 };
const anthropicTable: PriceTable = {
  version: 'a', provider: 'anthropic',
  prices: { m: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 1 } },
};
const openaiTable: PriceTable = {
  version: 'o', provider: 'deepseek',
  prices: { m: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 1 } },
};

const fakeFetch = (body: unknown): typeof fetch =>
  (vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);

// Consumidor GENÉRICO: só conhece a interface, não o provedor concreto.
async function consume(provider: AiProvider): Promise<{ text: string; hasCost: boolean; hasVersion: boolean }> {
  const c = await provider.complete('mesmo prompt');
  return { text: c.text, hasCost: typeof c.costCents === 'number', hasVersion: typeof c.priceTableVersion === 'string' };
}

describe('paridade da abstração AiProvider (duas APIs concretas)', () => {
  it('Anthropic e OpenAI-compat devolvem a MESMA forma pelo mesmo consumidor', async () => {
    const anthropic = buildAnthropicProvider({
      apiKey: 'sk-ant-real-000000000000000000000000', model: 'm', priceTable: anthropicTable, fxRates: fx,
      fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'olá' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    });
    const openai = buildOpenAiCompatProvider({
      apiKey: 'sk-real-0000000000000000000000', baseUrl: 'https://api.deepseek.com', model: 'm', priceTable: openaiTable, fxRates: fx,
      fetchImpl: fakeFetch({ choices: [{ message: { content: 'olá' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    });

    const a = await consume(anthropic);
    const o = await consume(openai);

    // mesmo texto, ambas com custo e versão preenchidos — forma idêntica.
    expect(a.text).toBe('olá');
    expect(o.text).toBe('olá');
    expect(a).toMatchObject({ hasCost: true, hasVersion: true });
    expect(o).toMatchObject({ hasCost: true, hasVersion: true });
  });
});
