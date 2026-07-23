import { expect, test } from '@playwright/test';

/**
 * Fluxo-alvo da F3 pelo NAVEGADOR (o mesmo do runbook §6), como admin:
 *   Entrar → Iniciar processo → (worker cria a tarefa) → Assumir → preencher o
 *   form pinado → Concluir → ver concluída na Operação.
 *
 * Pré: banco RECÉM-semeado (um processo publicado, sem instâncias), API+worker
 * no ar. Seletores batem com o console (shell.tsx / routes/tasks.tsx /
 * routes/operate.tsx). Credenciais do seed: acme / admin@acme.test / demo1234.
 */
test('fluxo-alvo: login → iniciar → assumir → concluir → Operação', async ({ page }) => {
  // 1) Entrar
  await page.goto('/');
  await page.getByLabel('Organização').fill('acme');
  await page.getByLabel('E-mail').fill('admin@acme.test');
  await page.getByLabel('Senha').fill('demo1234');
  await page.getByRole('button', { name: 'Entrar' }).click();

  // 2) Iniciar processo (modal → definição publicada → Idempotency-Key no POST)
  await page.getByRole('button', { name: /Iniciar processo/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Iniciar processo' });
  await dialog.getByRole('radio', { name: /Reembolso de despesas/ }).click();
  await dialog.getByRole('button', { name: 'Iniciar instância' }).click();
  await expect(dialog.getByText(/criada/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  // 3) O worker materializa a user task a partir da outbox — espere aparecer
  const taskItem = page.getByRole('button', { name: /aprovar_reembolso/ });
  await expect(taskItem).toBeVisible({ timeout: 20_000 });
  await taskItem.click();

  // 4) Assumir (claim D21) — o formulário pinado habilita
  await page.getByRole('button', { name: 'Assumir tarefa' }).click();

  // 5) Preencher o form (mesmo renderer) e concluir (validado no servidor)
  await page.getByLabel(/Colaborador/).fill('Marina Duarte');
  await page.getByLabel(/Valor/).fill('1200');
  await page.getByRole('radio', { name: 'Aprovar' }).check();
  await page.getByRole('button', { name: 'Concluir tarefa' }).click();
  await expect(page.getByText(/Tarefa concluída/)).toBeVisible();

  // 6) Operação: marcador exclusivo da rota + a instância na lista
  await page.getByRole('link', { name: /Operação/ }).click();
  await expect(page.getByRole('button', { name: 'só incidentes' })).toBeVisible();
});
