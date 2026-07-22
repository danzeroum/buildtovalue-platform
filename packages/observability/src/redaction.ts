/**
 * Caminhos de redaction do pino — a LISTA ÚNICA que api e worker consomem.
 *
 * Regra (G-ARQ-7 / 8.1): credenciais e dados sensíveis NUNCA aparecem em log.
 * O teste `tests/redaction.test.ts` FALHA se um campo desta classe vazar —
 * é o "teste que falha se sensível vazar em log" exigido pelo plano (F2.6
 * costura a criptografia; a redaction nasce aqui na F1 e já vale para auth).
 *
 * Convenção: variáveis de processo entram em logs SÓ por referência (nome),
 * nunca por valor — `variables` inteiro é redigido por segurança.
 */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.jwt',
  'password',
  'passwordHash',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'variables',
  '*.variables',
];
