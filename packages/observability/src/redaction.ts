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
  // F2.6: payloads de job, submissões de task e results de handler carregam
  // dados de negócio (possivelmente pessoais) — redigidos por inteiro.
  'payload',
  '*.payload',
  'submission',
  '*.submission',
  'result',
  '*.result',
  // Gate 8.4 (leak-fail de log): rede de segurança para PII de contato que um
  // call-site possa extrair do container redigido. O primário é NÃO logar PII
  // (o handler send-email loga `hasRecipient`, não o endereço); estes caminhos
  // garantem que, se `email`/`to` reaparecerem num log, saem `[REDACTED]`.
  'email',
  '*.email',
  'to',
  '*.to',
];
