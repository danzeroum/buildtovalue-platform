import { defineConfig } from 'vitest/config';

/**
 * Config dos testes SERIAIS (`*.serial.test.ts`), rodados ISOLADOS do resto da
 * suíte (`test:serial`, depois do run principal). Exercitam o caminho REAL de
 * `pg_snapshot_xmin` — global ao cluster — sem outras suítes escrevendo em
 * paralelo, então a marca d'água é determinística. É o gate de MÁQUINA do
 * caminho de PRODUÇÃO da ancoragem (não só o de teste com watermark injetada).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.serial.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
