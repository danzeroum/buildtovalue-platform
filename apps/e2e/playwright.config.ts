import { defineConfig, devices } from '@playwright/test';

/**
 * e2e de NAVEGADOR do fluxo-alvo (F3, leva 7). Dirige o console real no
 * Chromium. Pré-requisitos (o runbook §2–5 os deixa prontos):
 *   - Postgres migrado + `pnpm --filter @platform/api run seed:demo`
 *   - API :3000, worker, console :5173 no ar
 * `webServer` sobe o console (reaproveita se já estiver rodando); a API e o
 * worker precisam estar de pé (o worker é quem materializa a user task).
 *
 * NÃO roda no CI de cobertura (vitest) — é um alvo próprio (`pnpm e2e`).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @platform/console dev',
    url: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
