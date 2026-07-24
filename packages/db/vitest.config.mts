import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `*.serial.test.ts` rodam SÓ pelo `test:serial` (config própria), ISOLADOS do
    // resto: exercitam o `pg_snapshot_xmin` REAL, que é global ao cluster e ficaria
    // não-determinístico com outras suítes escrevendo em paralelo.
    exclude: ['tests/**/*.serial.test.ts', 'node_modules/**'],
    // Testes de integração compartilham um database recém-migrado — série única.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
