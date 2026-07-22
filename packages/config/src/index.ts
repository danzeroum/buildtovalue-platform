import { z } from 'zod';

/**
 * Config por ambiente (12-factor, G-COD-4): TODA configuração entra por env e
 * é validada aqui com zod — a aplicação não sobe com config inválida, e o erro
 * nomeia a variável exata. `.env.example` na raiz é o contrato vivo.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),

  DATABASE_URL: z.string().url().startsWith('postgres'),
  /** Papel de migração SEPARADO do papel da API (D7 / gate 8.4). */
  DATABASE_MIGRATION_URL: z.string().url().startsWith('postgres').optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de >= 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('buildtovalue'),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Erro de configuração: lista TODAS as variáveis inválidas de uma vez. */
export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Configuração inválida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Carrega e valida a configuração a partir de `source` (default: process.env).
 * Falha rápido e com mensagem acionável — nunca deixa a app subir capenga.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}
