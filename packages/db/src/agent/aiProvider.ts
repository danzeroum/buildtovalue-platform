/**
 * AIProvider do tenant (ADENDO-02 D29). Abstração mínima que o AgentRunner
 * (AG-2.2) consome para os nós `llm`. Na v1 o piloto usa um provider real;
 * os TESTES usam o mock por fixtures (determinístico, custo zero — o interior
 * do agentTask NÃO é reproduzível por design, D27, então o CI nunca chama LLM
 * real: injeta respostas fixas).
 */
export interface AiCompletion {
  text: string;
  /** tokens/custo estimado — alimenta o enforcement de budget (AG-2.2). */
  costCents?: number;
}

export interface AiProvider {
  complete(prompt: string): Promise<AiCompletion>;
}

/** Provider de FIXTURES: respostas fixas por prompt (testes/CI). */
export function fixtureAiProvider(fixtures: Record<string, AiCompletion>): AiProvider {
  return {
    async complete(prompt: string): Promise<AiCompletion> {
      const hit = fixtures[prompt];
      if (!hit) throw new Error(`fixture ausente para o prompt: ${prompt.slice(0, 60)}…`);
      return hit;
    },
  };
}
