/**
 * Credenciais do seed para os testes de browser — do AMBIENTE, nunca do código.
 *
 * Antes, os specs traziam a senha literal; ela vazava para o repositório e era
 * a MESMA que autenticava o ambiente de demo exposto na internet. Agora o valor
 * vive só onde roda (env do job de CI, shell de quem roda local), e o teste
 * falha alto se ninguém o forneceu — em vez de tentar um login que não existe e
 * reprovar por um motivo que não é o dele.
 */
export const SEED_EMAIL = process.env.SEED_EMAIL ?? 'admin@acme.test';
export const SEED_TENANT = process.env.SEED_TENANT ?? 'acme';

export const SEED_PASSWORD = (() => {
  const v = process.env.SEED_PASSWORD;
  if (!v) {
    throw new Error(
      'SEED_PASSWORD não definida — os testes de browser fazem login real.\n' +
        '  Use a MESMA senha passada ao `seed:demo`, ex.: export SEED_PASSWORD=...',
    );
  }
  return v;
})();
