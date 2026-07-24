/**
 * Tabela de preço EMBUTIDA e VERSIONADA (AG-2.5). O custo de um nó `llm` vem do
 * **usage REAL da API** × esta tabela — nunca de estimativa.
 *
 * Decisão (a) do dono — **moeda por entrada + taxa configurável**:
 *  - cada modelo declara sua `currency` (USD/BRL);
 *  - a conversão para BRL usa uma **taxa injetada** (`fxRates`) — CONFIGURAÇÃO,
 *    não cotação de rede no caminho quente;
 *  - o custo gravado registra os TRÊS: `currency` da entrada, `fxRate` usada e
 *    `priceTableVersion`. Sem os três, reconciliar custo histórico é impossível.
 *
 * Três paradas honestas (nunca chutar):
 *  1. modelo ausente → {@link PriceMissingError};
 *  2. moeda estrangeira sem taxa configurada → {@link FxRateMissingError};
 *  3. tokens de CACHE (mais baratos) tratados explícitos — se o provedor não
 *     reportar, caem no caminho normal (preço cheio); se a tabela não tiver taxa
 *     de cache, também caem no cheio. NUNCA assumir zero nem estimar desconto.
 *
 * Unidade da tabela: **unidade maior da moeda por 1M de tokens** (ex. USD 0,27
 * /Mtok). O custo final sai em **centavos de BRL** — a mesma do `budget_cents`.
 */

export type Currency = 'USD' | 'BRL';

/** Preço de um modelo, na unidade MAIOR da `currency` por 1M de tokens. */
export interface ModelPricing {
  currency: Currency;
  /** Por 1M tokens de ENTRADA cheia (cache-miss). */
  inputPerMTok: number;
  /** Por 1M tokens de SAÍDA. */
  outputPerMTok: number;
  /** Por 1M tokens de ENTRADA que bateram CACHE (mais barato). Ausente → usa a
   * taxa de entrada cheia (nunca assume desconto). */
  cachedInputPerMTok?: number;
}

/** Tabela versionada. `version` pina modelos (a taxa de câmbio é registrada por custo). */
export interface PriceTable {
  version: string;
  provider: string;
  prices: Readonly<Record<string, ModelPricing>>;
}

/**
 * Usage REAL da API. `inputTokens` é o TOTAL de entrada; `cachedInputTokens` é o
 * SUBCONJUNTO que bateu cache (quando o provedor reporta). Ausente → sem cache.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** Taxa de câmbio: BRL por 1 unidade da moeda. BRL é implicitamente 1. */
export type FxRates = Partial<Record<Currency, number>>;

/** Custo calculado + tudo para reconciliar depois (vai para a trilha). */
export interface CostBreakdown {
  /** Centavos de BRL (fracionários; some antes de comparar com budget). */
  cents: number;
  currency: Currency;
  /** Taxa BRL/moeda usada (1 se a entrada já é BRL). */
  fxRate: number;
  priceTableVersion: string;
  model: string;
  usage: Usage;
}

/** Modelo não precificado → parada honesta (âmbar, retomável). */
export class PriceMissingError extends Error {
  readonly model: string;
  readonly tableVersion: string;
  constructor(model: string, tableVersion: string) {
    super(`modelo sem tabela de preço: '${model}' (tabela ${tableVersion})`);
    this.name = 'PriceMissingError';
    this.model = model;
    this.tableVersion = tableVersion;
  }
}

/** Moeda estrangeira sem taxa configurada → parada honesta (nunca chuta câmbio). */
export class FxRateMissingError extends Error {
  readonly currency: Currency;
  constructor(currency: Currency) {
    super(`sem taxa de câmbio configurada para ${currency} — configure fxRates (nunca cotar em runtime)`);
    this.name = 'FxRateMissingError';
    this.currency = currency;
  }
}

/** True se o modelo está precificado (sem lançar) — pré-checagem barata. */
export function isPriced(table: PriceTable, model: string): boolean {
  return Object.prototype.hasOwnProperty.call(table.prices, model);
}

/**
 * Custo do usage real sob a tabela + taxa. Modelo ausente → {@link PriceMissingError};
 * moeda estrangeira sem taxa → {@link FxRateMissingError}.
 */
export function costOf(
  table: PriceTable,
  model: string,
  usage: Usage,
  opts: { fxRates?: FxRates } = {},
): CostBreakdown {
  const p = table.prices[model];
  if (!p) throw new PriceMissingError(model, table.version);

  const fxRate = p.currency === 'BRL' ? 1 : opts.fxRates?.[p.currency];
  if (fxRate == null) throw new FxRateMissingError(p.currency);

  const cachedIn = Math.max(0, usage.cachedInputTokens ?? 0);
  const fullIn = Math.max(0, usage.inputTokens - cachedIn);
  // taxa de cache ausente → entrada cheia (nunca assume desconto).
  const cachedRate = p.cachedInputPerMTok ?? p.inputPerMTok;

  const inCurrency =
    (fullIn * p.inputPerMTok + cachedIn * cachedRate + usage.outputTokens * p.outputPerMTok) /
    1_000_000;
  const cents = inCurrency * fxRate * 100;
  return { cents, currency: p.currency, fxRate, priceTableVersion: table.version, model, usage };
}

/**
 * Tabela do OpenAI-compatible — preços da **DeepSeek** (lista pública em USD),
 * com a taxa de **cache-hit** explícita (a DeepSeek reporta cache no usage e o
 * cobra bem mais barato; somar tudo cheio estouraria o budget antes da hora).
 * Trocar preço → BUMPAR a versão.
 *
 * Proveniência 2026-07-24 (USD /Mtok, in-miss / cache-hit / out):
 *   deepseek-chat      0,27 / 0,07 / 1,10
 *   deepseek-reasoner  0,55 / 0,14 / 2,19
 */
export const DEEPSEEK_PRICE_TABLE: PriceTable = {
  version: '2026-07-24',
  provider: 'deepseek',
  prices: {
    'deepseek-chat': { currency: 'USD', inputPerMTok: 0.27, cachedInputPerMTok: 0.07, outputPerMTok: 1.1 },
    'deepseek-reasoner': { currency: 'USD', inputPerMTok: 0.55, cachedInputPerMTok: 0.14, outputPerMTok: 2.19 },
  },
};

/**
 * Tabela da Anthropic (lista pública em USD), cache-read ~0,1× a entrada. É a
 * SEGUNDA implementação — existe para PROVAR que a abstração é abstração.
 *
 * Proveniência 2026-07-24 (USD /Mtok, in / cache-read / out):
 *   claude-opus-4-8              15 / 1,50 / 75
 *   claude-sonnet-5               3 / 0,30 / 15
 *   claude-haiku-4-5-20251001     0,80 / 0,08 / 4
 * `claude-fable-5` fica de fora de propósito (exercita a parada honesta).
 */
export const ANTHROPIC_PRICE_TABLE: PriceTable = {
  version: '2026-07-24',
  provider: 'anthropic',
  prices: {
    'claude-opus-4-8': { currency: 'USD', inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 },
    'claude-sonnet-5': { currency: 'USD', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
    'claude-haiku-4-5-20251001': { currency: 'USD', inputPerMTok: 0.8, cachedInputPerMTok: 0.08, outputPerMTok: 4 },
  },
};
