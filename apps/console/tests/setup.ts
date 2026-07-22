import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as axeMatchers from 'vitest-axe/matchers';

// Matchers de a11y disponíveis a todos os testes; desmonta a árvore entre
// casos para não vazar DOM (e handlers de sessão) de um teste para o outro.
expect.extend(axeMatchers);
afterEach(() => cleanup());
