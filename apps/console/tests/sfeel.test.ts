import { describe, expect, it } from 'vitest';
import { formExpressionEvaluator } from '@buildtovalue/forms';

/**
 * Pós-colapso §2.7: o console consome o avaliador CANÔNICO de
 * `@buildtovalue/forms` (não há mais cópia local). Estes testes fixam, do lado
 * do console, a fronteira honesta: dentro do subconjunto v1 devolve booleano;
 * fora dele `{ error }` — nunca booleano silenciosamente errado.
 */
describe('formExpressionEvaluator (canônico) — subconjunto v1', () => {
  it('comparação de ordem sobre `value`', () => {
    expect(formExpressionEvaluator.evaluate('value > 5000', { value: 6000 })).toEqual({ value: true });
    expect(formExpressionEvaluator.evaluate('value > 5000', { value: 100 })).toEqual({ value: false });
    expect(formExpressionEvaluator.evaluate('value <= 50000', { value: 50000 })).toEqual({ value: true });
  });

  it('referencia outros campos por chave', () => {
    expect(formExpressionEvaluator.evaluate('valor > 5000', { value: null, valor: 6000 })).toEqual({
      value: true,
    });
    expect(formExpressionEvaluator.evaluate('valor > 5000', { value: null, valor: 1000 })).toEqual({
      value: false,
    });
  });

  it('conjunção: exige as duas pontas (protótipo "value > 0 and value <= 50000")', () => {
    const e = 'value > 0 and value <= 50000';
    expect(formExpressionEvaluator.evaluate(e, { value: 100 })).toEqual({ value: true });
    expect(formExpressionEvaluator.evaluate(e, { value: 0 })).toEqual({ value: false });
    expect(formExpressionEvaluator.evaluate(e, { value: 60000 })).toEqual({ value: false });
  });

  it('disjunção: basta uma ponta', () => {
    const e = 'value = 1 or value = 2';
    expect(formExpressionEvaluator.evaluate(e, { value: 2 })).toEqual({ value: true });
    expect(formExpressionEvaluator.evaluate(e, { value: 3 })).toEqual({ value: false });
  });

  it('igualdade e desigualdade sobre strings', () => {
    expect(formExpressionEvaluator.evaluate('status = "aberto"', { value: null, status: 'aberto' })).toEqual({
      value: true,
    });
    expect(formExpressionEvaluator.evaluate('status != "aberto"', { value: null, status: 'fechado' })).toEqual(
      { value: true },
    );
  });

  it('ordem com operando ausente é falso (nunca lança)', () => {
    expect(formExpressionEvaluator.evaluate('valor > 5000', { value: null })).toEqual({ value: false });
  });

  it('fora do subconjunto v1 → { error }, jamais um booleano', () => {
    const bad = formExpressionEvaluator.evaluate('substring(value, 1) = "x"', { value: 'abc' });
    expect(bad).toHaveProperty('error');
    const noOp = formExpressionEvaluator.evaluate('value', { value: true });
    expect(noOp).toHaveProperty('error');
    const empty = formExpressionEvaluator.evaluate('   ', { value: 1 });
    expect(empty).toHaveProperty('error');
  });
});
