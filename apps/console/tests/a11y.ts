import { expect } from 'vitest';
import { axe } from 'vitest-axe';

/**
 * Barra do dono para os PRs de interface: **axe serious = 0**. Rodamos o axe
 * completo mas reprovamos só o que tem impacto `serious`/`critical` — é a
 * régua acordada, e evita falso-vermelho em heurísticas que o jsdom não
 * consegue medir sem layout (ex.: contraste, coberto pelos testes de token do
 * `@platform/shared-ui`). A mensagem lista cada violação para diagnóstico.
 */
export async function expectNoSeriousAxe(el: HTMLElement): Promise<void> {
  // `color-contrast` exige layout/canvas que o jsdom não tem; o contraste AA é
  // garantido pelos testes de token do `@platform/shared-ui`. Desligamos só
  // essa regra para evitar ruído de `getContext`, mantendo todo o resto.
  const results = await axe(el, { rules: { 'color-contrast': { enabled: false } } });
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const report = blocking.map((v) => `[${v.impact}] ${v.id}: ${v.help}`).join('\n');
  expect(blocking, report || 'sem violações serious/critical').toEqual([]);
}
