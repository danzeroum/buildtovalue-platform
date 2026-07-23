import { describe, expect, it } from 'vitest';
// Servidor: avaliador RICO de formulário (cópia transitória sob gate).
import { formEvaluator } from '../../../packages/db/src/runtime/formEvaluator.js';
// Console: avaliador REAL do preview (arquivo puro, sem deps de runtime).
import { consoleEvaluator } from '../../console/src/sfeel.js';
// Corpus COMPARTILHADO — espelho do @buildtovalue/forms SFEEL_FORM_CORPUS (o
// MESMO artefato que o teste da canônica roda na bpmn). Ver fixtures/ header.
import { SFEEL_FORM_CORPUS } from '../../../packages/db/tests/fixtures/sfeel-corpus.js';

/**
 * ACEITE NOMEADO da AG-2.1 (etapa 7): EQUIVALÊNCIA do avaliador de formulário
 * ancorada no corpus canônico. Cobre as TRÊS implementações que coexistem sob
 * gate: a canônica (@buildtovalue/forms, testada na bpmn contra o MESMO corpus),
 * o servidor (formEvaluator) e o console (consoleEvaluator). Cada caso afirma:
 *   servidor === expect  E  console === expect  E  servidor === console
 * — logo nenhuma das três diverge. Vive em apps/api porque a app importa
 * livremente entre pacotes (o pacote db não pode, por rootDir). Pós-colapso
 * (forms@1.1) servidor e console importam a canônica; este teste sobrevive como
 * regressão contra ela. Ver pendencias.md §2.7.
 */
type Verdict = { kind: 'error' } | { kind: 'value'; value: boolean };
const norm = (r: { value: boolean } | { error: string }): Verdict =>
  'error' in r ? { kind: 'error' } : { kind: 'value', value: r.value };
const want = (e: { value: boolean } | { error: true }): Verdict =>
  'error' in e ? { kind: 'error' } : { kind: 'value', value: e.value };

describe('equivalência servidor≡console≡canônica (corpus compartilhado)', () => {
  for (const c of SFEEL_FORM_CORPUS) {
    it(`${c.expr || '(vazia)'} @ ${JSON.stringify(c.ctx)}`, () => {
      const server = norm(formEvaluator.evaluate(c.expr, c.ctx));
      const client = norm(consoleEvaluator.evaluate(c.expr, c.ctx));
      const target = want(c.expect);
      expect(server).toEqual(target); // servidor ≡ canônica (corpus)
      expect(client).toEqual(target); // console ≡ canônica (corpus)
      expect(server).toEqual(client); // e portanto entre si (bidirecional)
    });
  }

  it('o corpus exercita a grade rica (ordem + and/or) e os erros', () => {
    expect(SFEEL_FORM_CORPUS.some((c) => />|<|>=|<=/.test(c.expr))).toBe(true);
    expect(SFEEL_FORM_CORPUS.some((c) => /\band\b|\bor\b/.test(c.expr))).toBe(true);
    expect(SFEEL_FORM_CORPUS.some((c) => 'error' in c.expect)).toBe(true);
  });
});
