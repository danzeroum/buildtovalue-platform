import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `*.serial.test.ts` rodam SÓ pelo `test:serial` (config própria), ISOLADOS do
    // resto: exercitam o `pg_snapshot_xmin` REAL, que é global ao cluster e ficaria
    // não-determinístico com outras suítes escrevendo em paralelo.
    // `*.real.test.ts` = integração REAL (rede/chave, ex. DeepSeek) — FORA do CI,
    // rodam só pelo `test:real` com a chave presente (senão pulam). Mesmo princípio
    // do provider: o CI usa fake; o caminho real é gate de máquina fora do CI.
    exclude: ['tests/**/*.serial.test.ts', 'tests/**/*.real.test.ts', 'node_modules/**'],
    // Testes de integração compartilham um database recém-migrado — série única.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
