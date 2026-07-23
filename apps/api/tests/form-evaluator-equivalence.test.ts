import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formExpressionEvaluator } from '@buildtovalue/forms';
import { SFEEL_FORM_CORPUS } from '@buildtovalue/forms/corpus';

/**
 * FONTE ÚNICA do avaliador de formulário (colapso da §2.7 concluído): servidor
 * (`userTasks.ts`) e console (`tasks.tsx`/`forms.tsx`) importam o MESMO
 * `formExpressionEvaluator` de `@buildtovalue/forms`. As cópias locais e o
 * espelho de corpus foram APAGADOS. Este teste, que era de equivalência entre
 * três implementações, vira REGRESSÃO contra a canônica:
 *  1. a canônica bate com o corpus publicado (`@buildtovalue/forms/corpus`);
 *  2. NENHUM avaliador/corpus local reaparece — se alguém reintroduzir uma
 *     cópia, o teste FALHA (a fonte é a biblioteca, não o repo).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FORBIDDEN_LOCAL_COPIES = [
  'packages/db/src/runtime/formEvaluator.ts',
  'apps/console/src/sfeel.ts',
  'packages/db/tests/fixtures/sfeel-corpus.ts',
];

describe('avaliador de forms — fonte única (regressão contra a canônica)', () => {
  for (const c of SFEEL_FORM_CORPUS) {
    it(`${c.expr || '(vazia)'} @ ${JSON.stringify(c.ctx)}`, () => {
      const r = formExpressionEvaluator.evaluate(c.expr, c.ctx);
      if ('error' in c.expect) {
        expect('error' in r).toBe(true);
      } else {
        expect(r).toEqual({ value: c.expect.value });
      }
    });
  }

  it('nenhum avaliador/corpus LOCAL reintroduzido (fonte única §2.7)', () => {
    const orphans = FORBIDDEN_LOCAL_COPIES.filter((p) => existsSync(join(REPO_ROOT, p)));
    expect(
      orphans,
      `cópia local do avaliador/corpus reapareceu — a fonte é @buildtovalue/forms: ${orphans.join(', ')}`,
    ).toEqual([]);
  });
});
