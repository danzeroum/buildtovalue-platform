import {
  createLocalSecretResolver,
  createOpenAiCompatProvider,
  createRealWalker,
  DEEPSEEK_PRICE_TABLE,
  getTenantAiConfig,
  OPENAI_COMPATIBLE,
  type AgentWalker,
  type FxRates,
  type PromptResolver,
  type Sql,
} from '@platform/db';

/**
 * Fiação do PROVIDER REAL no worker (AG-2.5, peça final). O handler `agent` usa o
 * `simulateWalker` por padrão (CI/test, custo zero, D27). SÓ em produção com backend
 * de arquivo (`SECRET_BACKEND=file`) e um tenant `openai-compatible` configurado, o
 * worker injeta o **realWalker** com o adaptador OpenAI-compatible (DeepSeek): a chave
 * vem do `secret://` resolvido no runtime; o custo, do usage REAL × tabela.
 *
 * Falha de configuração (segredo com perm frouxa, placeholder, base_url ruim) NÃO vira
 * erro opaco: devolve um walker que PARA HONESTO (`provider-unavailable`, âmbar) — o
 * operador corrige e RETOMA (§5.2). Falha da CHAMADA (timeout/401/rate-limit) já vira
 * parada honesta no próprio adaptador→realWalker (sem retry automático).
 */

export interface RealProviderEnv {
  dir: string;
  fxRates?: FxRates;
}

/** Liga o provider real só em produção + backend de arquivo. Caso contrário `null`
 * (→ o handler usa o simulateWalker padrão; o CI nunca chega aqui). */
export function realProviderEnv(env: NodeJS.ProcessEnv = process.env): RealProviderEnv | null {
  if (env.NODE_ENV !== 'production') return null;
  if (env.SECRET_BACKEND !== 'file') return null;
  const fx = env.FX_USD_BRL != null && env.FX_USD_BRL !== '' ? Number(env.FX_USD_BRL) : undefined;
  return {
    dir: env.SECRET_DIR ?? '/run/secrets/btv',
    fxRates: fx != null && Number.isFinite(fx) ? { USD: fx } : undefined,
  };
}

/** Prompt do ensaio a partir do nó llm (o resolvedor da Library é da AG-4, D38): monta
 * um prompt REAL pedindo a saída estruturada esperada pelo grafo. Não fabrica conteúdo
 * de negócio — só emoldura o pedido para o modelo responder no schema. */
export const ensaioPromptResolver: PromptResolver = (node, graph) =>
  `Você é o agente "${graph.name}", passo "${node.id}" (prompt ${node.config.promptRef}).\n` +
  `Entrada esperada: ${JSON.stringify(graph.inputSchema)}.\n` +
  `Responda SOMENTE com um JSON válido conforme a saída esperada: ${JSON.stringify(graph.outputSchema)}.`;

/** Walker que PARA HONESTO imediatamente — para falha de configuração do provider. */
export function honestFailWalker(reason: string): AgentWalker {
  return async () => ({
    visitedNodes: [],
    steps: 0,
    stopped: null,
    blocked: { nodeId: '(provider)', cell: 'provider-unavailable', reason },
    complete: false,
  });
}

/**
 * Constrói o walker real para o tenant, ou `null` quando não há config real
 * `openai-compatible` (o handler cai no `simulateWalker`; `no-config` real é tratado
 * pelo `runAgentJob`). Erro de construção → walker de parada honesta.
 */
export async function buildRealWalker(sql: Sql, tenantId: string, env: RealProviderEnv): Promise<AgentWalker | null> {
  const cfg = await getTenantAiConfig(sql, tenantId);
  if (!cfg || cfg.provider !== OPENAI_COMPATIBLE || !cfg.baseUrl) return null;
  try {
    const resolver = createLocalSecretResolver({ backend: 'file', baseDir: env.dir });
    const apiKey = await resolver.resolve(cfg.keyRef); // fail-closed: perm frouxa/ausente lança
    // AG-3.2: o câmbio vem da CONFIG POR TENANT quando presente; o env (`FX_USD_BRL`)
    // vira piso/fallback. A taxa é usada no cálculo e vai gravada no custo (imutável, D30).
    const fxRates: FxRates | undefined = cfg.fxUsdBrl != null ? { USD: cfg.fxUsdBrl } : env.fxRates;
    const provider = createOpenAiCompatProvider({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      priceTable: DEEPSEEK_PRICE_TABLE,
      fxRates,
    });
    return createRealWalker({ provider, resolvePrompt: ensaioPromptResolver });
  } catch (err) {
    return honestFailWalker(`provider real não configurável: ${err instanceof Error ? err.message : String(err)}`);
  }
}
