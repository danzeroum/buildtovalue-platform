import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as axeMatchers from 'vitest-axe/matchers';

// Mesmo setup do console: matchers de a11y + desmonta a árvore entre casos.
expect.extend(axeMatchers);
afterEach(() => cleanup());
