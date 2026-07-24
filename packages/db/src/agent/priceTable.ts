/**
 * Tabela de preço EMBUTIDA e VERSIONADA (AG-2.5, decisão (ii) do dono). O custo
 * de um nó `llm` vem do **usage REAL da API** × esta tabela — nunca de uma
 * estimativa (o `CostModel` do agentflow é projeção de modelagem, não custo real).
 *
 * Duas regras a tornam HONESTA:
 *  1. Modelo AUSENTE da tabela → {@link PriceMissingError} (parada honesta
 *     'modelo sem tabela de preço'). NUNCA estima nem cobra zero — cobrar zero
 *     por um modelo não precificado é mentir sobre o custo.
 *  2. A trilha grava QUAL VERSÃO da tabela calculou aquele custo
 *     ({@link CostBreakdown.priceTableVersion}). Trocar preço = nova versão; o
 *     custo histórico continua auditável contra a tabela que o produziu.
 *
 * Unidade: **centavos de BRL** — a MESMA do `budget_cents` do tenant, para o
 * enforcement de budget comparar maçã com maçã. A conversão USD→BRL é uma TAXA
 * que muda; por isso ela é PINADA pela `version` (ver o comentário da tabela),
 * não recalculada em runtime. Se a lista de preço OU o câmbio mudar, é uma
 * versão nova — o número histórico nunca "escorrega".
 */

/** Preço de um modelo, em centavos de BRL por 1M de tokens. */
export interface ModelPricing {
  /** Centavos de BRL por 1M tokens de ENTRADA (input). */
  inputCentsPerMTok: number;
  /** Centavos de BRL por 1M tokens de SAÍDA (output). */
  outputCentsPerMTok: number;
}

/** Tabela versionada. `version` pina modelos + câmbio (proveniência no comentário). */
export interface PriceTable {
  version: string;
  provider: string;
  prices: Readonly<Record<string, ModelPricing>>;
}

/** Usage REAL devolvido pela API (nunca estimado). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Custo calculado + a versão que o calculou (vai para a trilha). */
export interface CostBreakdown {
  /** Centavos de BRL (fracionários; some antes de comparar com budget). */
  cents: number;
  priceTableVersion: string;
  model: string;
  usage: Usage;
}

/**
 * Modelo não precificado → PARADA HONESTA. É um erro TIPADO para o walker
 * distinguir de uma falha de rede: preço faltando é âmbar (retomável após
 * corrigir a tabela), não incidente vermelho.
 */
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

/**
 * Custo do usage real sob a tabela. Modelo ausente → {@link PriceMissingError}.
 * Cobrar zero por modelo desconhecido seria mentir; por isso lança em vez de
 * devolver `{ cents: 0 }`.
 */
export function costOf(table: PriceTable, model: string, usage: Usage): CostBreakdown {
  const p = table.prices[model];
  if (!p) throw new PriceMissingError(model, table.version);
  const cents =
    (usage.inputTokens * p.inputCentsPerMTok + usage.outputTokens * p.outputCentsPerMTok) / 1_000_000;
  return { cents, priceTableVersion: table.version, model, usage };
}

/** True se o modelo está precificado (sem lançar) — útil para pré-checagem. */
export function isPriced(table: PriceTable, model: string): boolean {
  return Object.prototype.hasOwnProperty.call(table.prices, model);
}

/**
 * Tabela EMBUTIDA da Anthropic. Números = lista pública em USD × câmbio
 * 5,40 BRL/USD, AMBOS pinados por esta `version` (proveniência abaixo). Trocar
 * qualquer um → BUMPAR a versão (nunca editar in-place um preço já usado).
 *
 * Proveniência 2026-07-24:
 *   modelo                        USD in/out /Mtok    → centavos BRL /Mtok (×5,40×100)
 *   claude-opus-4-8               15 / 75             → 8100  / 40500
 *   claude-sonnet-5                3 / 15             → 1620  /  8100
 *   claude-haiku-4-5-20251001      0,80 / 4           →  432  /  2160
 *
 * `claude-fable-5` fica DE FORA de propósito: exercita a regra 1 (modelo sem
 * preço → parada honesta) no piloto sem precisar de um modelo falso.
 */
export const ANTHROPIC_PRICE_TABLE: PriceTable = {
  version: '2026-07-24',
  provider: 'anthropic',
  prices: {
    'claude-opus-4-8': { inputCentsPerMTok: 8100, outputCentsPerMTok: 40500 },
    'claude-sonnet-5': { inputCentsPerMTok: 1620, outputCentsPerMTok: 8100 },
    'claude-haiku-4-5-20251001': { inputCentsPerMTok: 432, outputCentsPerMTok: 2160 },
  },
};
