import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Testes de UI do console: jsdom + testing-library + vitest-axe. O plugin
// React garante o mesmo transform de JSX (runtime automático) do app; CSS é
// ignorado (imports de estilo resolvem para módulo vazio) — os testes provam
// COMPORTAMENTO e ACESSIBILIDADE, não pixels.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
