/**
 * AIProvider REAL — adaptador **OpenAI-compatible** (AG-2.5, PRIMEIRA impl). Um
 * só adaptador cobre DeepSeek, Groq, Together, OpenRouter e modelos locais:
 * muda-se só `baseUrl` + `model` por tenant. Nenhum detalhe do endpoint vaza
 * para fora daqui — o walker/`runAgentJob` não sabe qual provedor tem embaixo.
 *
 * Custo: usage REAL × {@link PriceTable} (decisão (a): moeda + taxa registradas).
 * **Cache de prompt** tratado explícito: lê `prompt_cache_hit_tokens` (a DeepSeek
 * cobra esses tokens bem mais barato); provedor que não reporta → caminho normal.
 * Falha/timeout/rate-limit → {@link ProviderUnavailableError}, SEM retry.
 *
 * GUARDA DURA: a fábrica {@link createOpenAiCompatProvider} recusa NODE_ENV=test/CI,
 * chave placeholder E base URL ausente/não-https (validada na fábrica, não só no uso).
 */
import type { AiCompletion, AiProvider } from './aiProvider.js';
import { ProviderUnavailableError } from './anthropicProvider.js';
import { costOf, isPriced, type FxRates, type PriceTable, type Usage } from './priceTable.js';
import { assertBaseUrl, assertNotTestEnv, assertRealKey } from './providerGuards.js';

export interface OpenAiCompatProviderOptions {
  /** Chave REAL resolvida do secret:// (`sk-…`). */
  apiKey: string;
  /** Base URL do provedor (ex. `https://api.deepseek.com`). Obrigatória, https. */
  baseUrl: string;
  /** Modelo do tenant (ex. `deepseek-chat`). */
  model: string;
  /** Tabela de preço (o adaptador não embute uma — é injetada por provedor). */
  priceTable: PriceTable;
  /** Taxas de câmbio (config, não rede). Moeda estrangeira sem taxa → parada honesta. */
  fxRates?: FxRates;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek: tokens da entrada que bateram cache (mais baratos). */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * Construtor SEM guardas — INTERNO, para os testes exercitarem o mapeamento
 * HTTP/custo com `fetchImpl` fake (sem rede). NÃO reexportado do índice.
 */
export function buildOpenAiCompatProvider(opts: OpenAiCompatProviderOptions): AiProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const base = opts.baseUrl.replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async complete(prompt: string): Promise<AiCompletion> {
      // Preço PRIMEIRO: modelo sem tabela é parada honesta ANTES de gastar (regra 1).
      if (!isPriced(opts.priceTable, opts.model)) {
        costOf(opts.priceTable, opts.model, { inputTokens: 0, outputTokens: 0 }, { fxRates: opts.fxRates });
      }

      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
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
          `provider indisponível (rede/timeout ${timeoutMs}ms): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderUnavailableError(`provider HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      let data: OpenAiResponse;
      try {
        data = (await res.json()) as OpenAiResponse;
      } catch (err) {
        throw new ProviderUnavailableError('resposta do provider não é JSON válido', err);
      }

      const text = data.choices?.[0]?.message?.content ?? '';
      const cacheHit = data.usage?.prompt_cache_hit_tokens;
      const usage: Usage = {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        // só define quando o provedor REPORTA cache — ausente = caminho normal.
        ...(cacheHit != null ? { cachedInputTokens: cacheHit } : {}),
      };
      const cost = costOf(opts.priceTable, opts.model, usage, { fxRates: opts.fxRates });
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

/** Fábrica PÚBLICA — aplica as guardas duras (CI, placeholder, base URL). */
export function createOpenAiCompatProvider(opts: OpenAiCompatProviderOptions): AiProvider {
  assertNotTestEnv(opts.env ?? process.env);
  assertRealKey(opts.apiKey);
  const baseUrl = assertBaseUrl(opts.baseUrl);
  return buildOpenAiCompatProvider({ ...opts, baseUrl });
}
