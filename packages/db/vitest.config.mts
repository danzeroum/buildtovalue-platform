import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Testes de integração compartilham um database recém-migrado — série única.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
