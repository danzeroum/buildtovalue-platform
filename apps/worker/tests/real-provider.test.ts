import { isHonestStop } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { ensaioPromptResolver, honestFailWalker, realProviderEnv } from '../src/realProvider.js';

// grafo mínimo inline (o worker não depende de @buildtovalue/agentflow diretamente).
const GRAPH = {
  kind: 'AgentWorkflow', id: 'agnt-x', version: '1.0.0', name: 'aprovador', autonomyLevel: 1,
  inputSchema: { q: 'string' }, outputSchema: { approved: 'boolean' }, nodes: [], edges: [],
};

/**
 * Fiação do provider real no worker (AG-2.5). O que dá para provar SEM rede:
 *  · o CI NUNCA liga o provider real (realProviderEnv → null fora de produção+file);
 *  · falha de config → walker de PARADA HONESTA (provider-unavailable), não erro opaco;
 *  · o prompt do ensaio é REAL (pede a saída no schema), não fabrica conteúdo.
 * A chamada de verdade fica no teste de integração real (fora do CI).
 */
describe('realProviderEnv — o CI nunca liga o provider real', () => {
  it('null fora de produção (test/CI) e sem backend de arquivo', () => {
    expect(realProviderEnv({ NODE_ENV: 'test', SECRET_BACKEND: 'file' } as NodeJS.ProcessEnv)).toBeNull();
    expect(realProviderEnv({ NODE_ENV: 'production', SECRET_BACKEND: 'env' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('produção + backend de arquivo → liga, com FX parseado', () => {
    const env = realProviderEnv({
      NODE_ENV: 'production', SECRET_BACKEND: 'file', SECRET_DIR: '/run/secrets/btv', FX_USD_BRL: '5.40',
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ dir: '/run/secrets/btv', fxRates: { USD: 5.4 } });
  });

  it('FX ausente/inválido → sem fxRates (o custo em USD fará fx-missing, honesto)', () => {
    const env = realProviderEnv({ NODE_ENV: 'production', SECRET_BACKEND: 'file' } as NodeJS.ProcessEnv);
    expect(env?.fxRates).toBeUndefined();
  });
});

describe('honestFailWalker — falha de config vira parada honesta, não erro opaco', () => {
  it('devolve blocked provider-unavailable (âmbar, retomável §5.2)', async () => {
    const walk = await honestFailWalker('segredo com permissão frouxa')(GRAPH as never, {
      shouldStop: async () => null,
    });
    expect(walk.complete).toBe(false);
    expect(walk.blocked?.cell).toBe('provider-unavailable');
    expect(walk.blocked?.reason).toMatch(/permissão frouxa/);
    // 'provider-unavailable' é parada honesta (não incidente vermelho).
    expect(isHonestStop('provider-unavailable')).toBe(true);
  });
});

describe('ensaioPromptResolver — prompt REAL a partir do nó, sem fabricar negócio', () => {
  it('inclui o nome do agente, o promptRef e pede a saída no schema', () => {
    const llm = { id: 'llm-x', type: 'llm', config: { model: 'deepseek-chat', promptRef: 'prm:x@1.0.0' } };
    const prompt = ensaioPromptResolver(llm as never, GRAPH as never);
    expect(prompt).toContain(GRAPH.name);
    expect(prompt).toContain('prm:x@1.0.0');
    expect(prompt).toMatch(/JSON/);
  });
});
