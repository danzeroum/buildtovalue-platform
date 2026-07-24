import { defineConfig } from 'vitest/config';

/**
 * Config dos testes de INTEGRAÇÃO REAL (`*.real.test.ts`) — FORA do CI. Exercitam
 * a rede/chave de verdade (ex. DeepSeek): a peça onde a integração real aparece,
 * que fixture nenhuma cobre. Sem a chave no ambiente, os casos PULAM (skipIf).
 * Rodar: `DEEPSEEK_API_KEY=sk-… pnpm --filter @platform/db run test:real`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.real.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
