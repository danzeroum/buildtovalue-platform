import { expect, test, type Page } from '@playwright/test';

/**
 * ESTADO "CARREGANDO" POR MÁQUINA (auditoria AG-2.2 item (c)): o gate de UX
 * "estados vazio/erro/carregando obrigatórios" (CLAUDE.md) estava afirmado sem
 * teste do leg CARREGANDO — nenhuma asserção de `aria-busy`/`NonIdeal` em lugar
 * nenhum. Este teste fecha isso de forma DETERMINÍSTICA: segura a resposta de
 * `/v1/instances` (route interception) e prova que o Operate mostra o
 * `NonIdeal kind="loading"` (`role=status`, `aria-busy`, "Carregando…") enquanto
 * os dados não chegam — e que o loading SAI quando a resposta é liberada.
 *
 * Pré (idênticos ao axe/target-flow): API :3000 + worker + console :5173 semeados.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Organização').fill('acme');
  await page.getByLabel('E-mail').fill('admin@acme.test');
  await page.getByLabel('Senha').fill('demo1234');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('link', { name: /Operação/ })).toBeVisible({ timeout: 20_000 });
}

test('carregando: Operate mostra o NonIdeal de loading enquanto /v1/instances não resolve', async ({
  page,
}) => {
  await login(page);
  // Garante uma montagem FRESCA do Operate depois de armar a interceptação:
  // sai para Tarefas primeiro (se já não estiver lá).
  await page.getByRole('link', { name: /Tarefas/ }).click();

  // Segura a listagem de instâncias — a resposta só sai quando liberarmos.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/v1/instances',
    async (route) => {
      await gate;
      await route.continue();
    },
  );

  await page.getByRole('link', { name: /Operação/ }).click();

  // Enquanto a resposta está retida: o estado de carregamento é anunciado.
  // O NonIdeal de loading é um esqueleto visual cujo texto acessível vem do
  // `aria-label` (não há texto renderizado) — casa pelo NOME acessível, não hasText.
  const loading = page.getByRole('status', { name: /Carregando instâncias/ });
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');

  // Libera a resposta → o loading some (renderiza vazio/lista, não trava).
  release();
  await expect(loading).toBeHidden();
});
