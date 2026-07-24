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
  // AG-3.1 (world-delta do gate): os `params` propostos (destinatários, corpo)
  // carregam PII herdada da variável proposalVar. O world-delta vive sob `payload`
  // (já redigido), mas o REVEAL auditado devolve `{ params: {…PII…} }` fora de
  // `payload` — esta rede garante que um log do reveal saia `[REDACTED]`.
  'params',
  '*.params',
  // AG-2.5 (provider real): a CHAVE resolvida do `secret://` no runtime. O código
  // nunca a loga (o doctor imprime só len+prefixo), mas a rede garante que, se um
  // call-site a puser num campo de log, saia `[REDACTED]`. (`key_ref` é ponteiro, não a chave.)
  'apiKey',
  '*.apiKey',
];
