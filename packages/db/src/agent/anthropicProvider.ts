/**
 * AIProvider REAL — Anthropic (AG-2.5, decisão (i) do dono). É a PRIMEIRA
 * implementação da interface {@link AiProvider}, não uma premissa do runtime: o
 * walker não sabe qual provider tem embaixo. Nenhum detalhe da API (endpoint,
 * header, formato de body) vaza para fora deste adaptador — trocar de provedor
 * depois NÃO toca o walker nem o runAgentJob.
 *
 * Custo: usage REAL da resposta × {@link PriceTable} (centavos de BRL). Modelo
 * fora da tabela → {@link PriceMissingError} (parada honesta). NUNCA estima.
 *
 * Falha (decisão-correção 1 do dono): erro/timeout/rate-limit → lança
 * {@link ProviderUnavailableError} — SEM retry automático. O walker converte em
 * parada honesta; o operador RETOMA pelo caminho de resume já existente (§5.2).
 *
 * GUARDA DURA (decisão-correção 2): a fábrica pública {@link createRealAiProvider}
 * RECUSA rodar em NODE_ENV=test / CI, e RECUSA um segredo placeholder/exemplo —
 * o CI nunca chama LLM real (D27), nem um deploy com a chave de exemplo esquecida.
 */
import type { AiCompletion, AiProvider } from './aiProvider.js';
import {
  ANTHROPIC_PRICE_TABLE,
  costOf,
  type PriceTable,
} from './priceTable.js';

/** Falha de execução do provider — âmbar, retomável, SEM retry (decisão 1). */
export class ProviderUnavailableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.cause = cause;
  }
}

/** Segredo placeholder/exemplo detectado — recusa dura (decisão-correção 2). */
export class PlaceholderKeyError extends Error {
  constructor(reason: string) {
    super(`chave da API recusada: ${reason} — configure o segredo REAL no backend secret://`);
    this.name = 'PlaceholderKeyError';
  }
}

export interface RealAiProviderOptions {
  /** Chave REAL, já resolvida do secret:// (nunca literal no código/banco). */
  apiKey: string;
  /** Modelo do tenant (tenant_ai_config.model). */
  model: string;
  /** Tabela de preço (default: {@link ANTHROPIC_PRICE_TABLE}). */
  priceTable?: PriceTable;
  /** Timeout duro por chamada (default 30s). Estouro → ProviderUnavailableError. */
  timeoutMs?: number;
  /** Teto de tokens de saída por chamada (default 1024). */
  maxOutputTokens?: number;
  /** Base URL (default oficial). */
  baseUrl?: string;
  /** Versão da API Anthropic (default estável). */
  apiVersion?: string;
  /** `fetch` injetável — os testes passam um fake (SEM rede). */
  fetchImpl?: typeof fetch;
  /** ambiente para a GUARDA DURA (default process.env). */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * GUARDA 1 — recusa em ambiente de teste/CI. O provider real NUNCA roda no CI:
 * o interior do agentTask não é reproduzível (D27) e o CI usa fixtures.
 */
function assertNotTestEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'test' || env.VITEST) {
    throw new Error('provider REAL recusado: NODE_ENV=test/VITEST — o CI usa fixtures (D27), nunca LLM real');
  }
  if (env.CI && env.CI !== 'false' && env.CI !== '0') {
    throw new Error('provider REAL recusado: CI ativo — o CI usa fixtures (D27), nunca LLM real');
  }
}

/**
 * GUARDA 2 — recusa segredo placeholder/exemplo. Chave da Anthropic é
 * `sk-ant-…`; recusa se: não tem o prefixo, é curta demais, ou bate num padrão
 * de exemplo (inclui as fixtures deste repo: `sk-ant-xyz`, `sk-ant-file`).
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /example/i,
  /placeholder/i,
  /changeme/i,
  /your[-_]?key/i,
  /replace[-_]?me/i,
  /dummy/i,
  /^sk-ant-xyz/i, // fixture do repo
  /^sk-ant-file/i, // fixture do repo
  /x{4,}/i,
  /\.\.\./,
];

export function assertRealKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key.startsWith('sk-ant-')) {
    throw new PlaceholderKeyError("não tem o prefixo 'sk-ant-'");
  }
  if (key.length < 40) {
    throw new PlaceholderKeyError('curta demais para ser uma chave real');
  }
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(key)) {
      throw new PlaceholderKeyError(`bate num padrão de exemplo (${re})`);
    }
  }
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Constrói o provider SEM as guardas duras — INTERNO, para os testes exercitarem
 * o mapeamento HTTP/custo com um `fetchImpl` fake (sem rede, sem chave real). NÃO
 * é reexportado do índice; o caminho público é {@link createRealAiProvider}, que
 * aplica as guardas. Mantê-los separados deixa o mapeamento testável sem furar a guarda.
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
      // Preço PRIMEIRO: modelo sem tabela é parada honesta ANTES de gastar a
      // chamada real (nunca cobrar zero por modelo desconhecido, regra 1).
      if (!priceTable.prices[opts.model]) {
        // costOf lança PriceMissingError tipado — o walker distingue de rede.
        costOf(priceTable, opts.model, { inputTokens: 0, outputTokens: 0 });
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
        // timeout (AbortError) / rede / DNS → parada honesta, SEM retry.
        throw new ProviderUnavailableError(
          `Anthropic indisponível (rede/timeout ${timeoutMs}ms): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      if (!res.ok) {
        // 429/5xx/4xx → parada honesta, SEM retry (o operador retoma, §5.2).
        const body = await res.text().catch(() => '');
        throw new ProviderUnavailableError(
          `Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
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
      const usage = {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
      // costOf lança PriceMissingError se o modelo sumiu da tabela — honesto.
      const cost = costOf(priceTable, opts.model, usage);
      return {
        text,
        costCents: cost.cents,
        usage,
        priceTableVersion: cost.priceTableVersion,
        model: opts.model,
      };
    },
  };
}

/**
 * Fábrica PÚBLICA do provider real. Aplica as DUAS guardas duras antes de
 * construir; é o único caminho que o worker/piloto deve usar.
 */
export function createRealAiProvider(opts: RealAiProviderOptions): AiProvider {
  assertNotTestEnv(opts.env ?? process.env);
  assertRealKey(opts.apiKey);
  return buildAnthropicProvider(opts);
}
