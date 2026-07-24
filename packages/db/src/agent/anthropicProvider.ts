/**
 * AIProvider REAL — Anthropic (AG-2.5). **SEGUNDA** implementação da interface
 * {@link AiProvider}: a API (endpoint, headers `x-api-key`/`anthropic-version`,
 * formato do body/usage) é diferente o bastante do OpenAI-compatible para ser o
 * TESTE REAL da abstração — se o walker roda igual contra as duas, a abstração é
 * abstração. Nenhum detalhe da API vaza daqui.
 *
 * Custo: usage REAL × {@link PriceTable} (moeda + taxa registradas, decisão (a)).
 * Cache tratado explícito (`cache_read_input_tokens`). Falha → parada honesta,
 * SEM retry. Guardas duras compartilhadas ({@link providerGuards}).
 */
import type { AiCompletion, AiProvider } from './aiProvider.js';
import { ANTHROPIC_PRICE_TABLE, costOf, isPriced, type FxRates, type PriceTable, type Usage } from './priceTable.js';
import { assertNotTestEnv, assertRealKey } from './providerGuards.js';

/** Falha de execução do provider — âmbar, retomável, SEM retry (decisão 1). */
export class ProviderUnavailableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.cause = cause;
  }
}

export interface RealAiProviderOptions {
  /** Chave REAL, já resolvida do secret:// (nunca literal no código/banco). */
  apiKey: string;
  /** Modelo do tenant (tenant_ai_config.model). */
  model: string;
  /** Tabela de preço (default: {@link ANTHROPIC_PRICE_TABLE}). */
  priceTable?: PriceTable;
  /** Taxas de câmbio (config). Moeda estrangeira sem taxa → parada honesta. */
  fxRates?: FxRates;
  timeoutMs?: number;
  maxOutputTokens?: number;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** tokens de entrada lidos do cache (mais baratos), quando reportado. */
    cache_read_input_tokens?: number;
  };
}

/**
 * Construtor SEM guardas — INTERNO, para os testes exercitarem o mapeamento com
 * `fetchImpl` fake. NÃO reexportado do índice; o caminho público é a fábrica.
 */
export function buildAnthropicProvider(opts: RealAiProviderOptions): AiProvider {
  const priceTable = opts.priceTable ?? ANTHROPIC_PRICE_TABLE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async complete(prompt: string): Promise<AiCompletion> {
      // Preço PRIMEIRO: modelo sem tabela → parada honesta antes de gastar (regra 1).
      if (!isPriced(priceTable, opts.model)) {
        costOf(priceTable, opts.model, { inputTokens: 0, outputTokens: 0 }, { fxRates: opts.fxRates });
      }

      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': apiVersion,
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: maxOutputTokens,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new ProviderUnavailableError(
          `Anthropic indisponível (rede/timeout ${timeoutMs}ms): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderUnavailableError(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      let data: AnthropicResponse;
      try {
        data = (await res.json()) as AnthropicResponse;
      } catch (err) {
        throw new ProviderUnavailableError('resposta da Anthropic não é JSON válido', err);
      }

      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      const cacheRead = data.usage?.cache_read_input_tokens;
      const usage: Usage = {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        ...(cacheRead != null ? { cachedInputTokens: cacheRead } : {}),
      };
      const cost = costOf(priceTable, opts.model, usage, { fxRates: opts.fxRates });
      return {
        text,
        costCents: cost.cents,
        usage,
        priceTableVersion: cost.priceTableVersion,
        costCurrency: cost.currency,
        fxRate: cost.fxRate,
        model: opts.model,
      };
    },
  };
}

/** Fábrica PÚBLICA — aplica as guardas duras (CI/test, placeholder). */
export function createRealAiProvider(opts: RealAiProviderOptions): AiProvider {
  assertNotTestEnv(opts.env ?? process.env);
  assertRealKey(opts.apiKey);
  return buildAnthropicProvider(opts);
}
