import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * GATE DE ACESSIBILIDADE POR MÁQUINA (AG-2.2 etapa 5 · slice final): o critério
 * "axe serious = 0 nas telas novas" (circuito do designer, desde a F3) era afirmado
 * em relatórios SEM verificação automática. Este harness fecha isso: sobe o console
 * real (mesmo stack do fluxo-alvo) e FALHA se qualquer violação `serious`/`critical`
 * aparecer nas telas do fluxo principal. A partir daqui, "axe serious = 0" só é
 * afirmado com máquina — ou passa aqui, ou não se afirma.
 *
 * Pré (idênticos ao target-flow, runbook §2–5): Postgres semeado + API :3000 +
 * worker + console :5173. Alvo próprio (`pnpm --filter @platform/e2e e2e`), fora do
 * CI de cobertura (vitest).
 */

/** Falha só no que o critério nomeia: serious + critical (minor/moderate não travam). */
async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  // Mensagem legível quando falha: regra + impacto + primeiro alvo.
  const report = blocking.map((v) => `${v.id} [${v.impact}] → ${v.nodes[0]?.target?.join(' ')}`).join('\n');
  expect(blocking, `violações serious/critical em ${label}:\n${report}`).toEqual([]);
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Organização').fill('acme');
  await page.getByLabel('E-mail').fill('admin@acme.test');
  await page.getByLabel('Senha').fill('demo1234');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('link', { name: /Operação/ })).toBeVisible({ timeout: 20_000 });
}

test('axe serious/critical = 0 — tela de login', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expectNoSeriousA11y(page, 'login');
});

test('axe serious/critical = 0 — telas do fluxo principal (autenticado)', async ({ page }) => {
  await login(page);
  const routes: [string, RegExp][] = [
    ['Tarefas', /Tarefas/],
    ['Formulários', /Formulários/],
    ['Estúdio', /Estúdio/],
    ['Operação', /Operação/],
  ];
  for (const [label, name] of routes) {
    await page.getByRole('link', { name }).click();
    await page.waitForLoadState('networkidle');
    await expectNoSeriousA11y(page, label);
  }
});
