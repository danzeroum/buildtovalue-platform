/**
 * Guardas duras compartilhadas pelos adaptadores de AiProvider (AG-2.5). Vivem
 * fora dos adaptadores concretos para que TODA implementação real herde a mesma
 * cerca — o CI nunca chama LLM real; placeholder e base URL torta não sobem.
 */

/** Erro de configuração de provider — recusa dura na fábrica. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/**
 * GUARDA 1 — recusa em ambiente de teste/CI. Nenhum provider real nasce no CI:
 * o interior do agentTask não é reproduzível (D27); o CI usa fixtures.
 */
export function assertNotTestEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'test' || env.VITEST) {
    throw new ProviderConfigError(
      'provider REAL recusado: NODE_ENV=test/VITEST — o CI usa fixtures (D27), nunca LLM real',
    );
  }
  if (env.CI && env.CI !== 'false' && env.CI !== '0') {
    throw new ProviderConfigError('provider REAL recusado: CI ativo — o CI usa fixtures (D27), nunca LLM real');
  }
}

/** Segredo placeholder/exemplo recusado (inclui as fixtures deste repo). */
export class PlaceholderKeyError extends ProviderConfigError {
  constructor(reason: string) {
    super(`chave da API recusada: ${reason} — configure o segredo REAL no backend secret://`);
    this.name = 'PlaceholderKeyError';
  }
}

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /example/i,
  /placeholder/i,
  /changeme/i,
  /your[-_]?key/i,
  /replace[-_]?me/i,
  /dummy/i,
  /^sk-ant-xyz/i, // fixture do repo
  /^sk-ant-file/i, // fixture do repo
  /^sk-xyz/i,
  /x{4,}/i,
  /\.\.\./,
];

/**
 * GUARDA 2 — recusa segredo placeholder/exemplo. Aceita as duas famílias de
 * prefixo em uso: `sk-ant-` (Anthropic) e `sk-` (OpenAI-compatible/DeepSeek).
 * Recusa se: sem prefixo conhecido, curta demais, ou bate num padrão de exemplo.
 */
export function assertRealKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key.startsWith('sk-')) {
    throw new PlaceholderKeyError("não tem o prefixo 'sk-' (Anthropic 'sk-ant-…', OpenAI-compat 'sk-…')");
  }
  if (key.length < 24) {
    throw new PlaceholderKeyError('curta demais para ser uma chave real');
  }
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(key)) {
      throw new PlaceholderKeyError(`bate num padrão de exemplo (${re})`);
    }
  }
}

/**
 * GUARDA 3 (openai-compatible) — base URL obrigatória e validada. `https://`
 * obrigatório; sem default silencioso apontando para o provedor errado.
 */
export function assertBaseUrl(baseUrl: string | undefined | null): string {
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new ProviderConfigError('base_url obrigatória para o adaptador openai-compatible — sem default');
  }
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ProviderConfigError(`base_url malformada: '${baseUrl}'`);
  }
  if (url.protocol !== 'https:') {
    throw new ProviderConfigError(`base_url deve ser https:// — recebida '${url.protocol}//' em '${baseUrl}'`);
  }
  return url.toString().replace(/\/$/, '');
}
