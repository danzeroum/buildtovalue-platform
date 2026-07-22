import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS } from './redaction.js';

export interface LoggerOptions {
  level?: string;
  /** Nome do serviço (api, worker) — vira campo estruturado em todo evento. */
  service: string;
  /** Destino custom (testes capturam a saída por aqui). */
  destination?: DestinationStream;
}

/**
 * Logger estruturado padrão da plataforma: pino + redaction testada
 * (G-API-3: logs como eventos, com contexto). Todo log carrega `service`;
 * request-id e tenant entram como bindings por request na API.
 */
export function createLogger(options: LoggerOptions): Logger {
  const config = {
    level: options.level ?? 'info',
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

export type { Logger };
