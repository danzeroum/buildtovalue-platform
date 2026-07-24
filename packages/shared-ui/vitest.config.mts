import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// tokens.test.ts é puro (contraste AA, sem DOM); os testes de componente do selo
// usam jsdom + testing-library + vitest-axe (o mesmo transform de JSX do console).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
