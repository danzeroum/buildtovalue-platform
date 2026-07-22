import { describe, expect, it } from 'vitest';
import { consoleEvaluator } from '../src/sfeel.js';

/**
 * O avaliador do preview é HONESTO: dentro do subconjunto v1 devolve booleano;
 * fora dele devolve `{ error }` — nunca um booleano silenciosamente errado
 * (mesma disciplina do lint D19). Os testes fixam essa fronteira.
 */
describe('consoleEvaluator — subconjunto v1', () => {
  it('comparação de ordem sobre `value`', () => {
    expect(consoleEvaluator.evaluate('value > 5000', { value: 6000 })).toEqual({ value: true });
    expect(consoleEvaluator.evaluate('value > 5000', { value: 100 })).toEqual({ value: false });
    expect(consoleEvaluator.evaluate('value <= 50000', { value: 50000 })).toEqual({ value: true });
  });

  it('referencia outros campos por chave', () => {
    expect(consoleEvaluator.evaluate('valor > 5000', { value: null, valor: 6000 })).toEqual({
      value: true,
    });
    expect(consoleEvaluator.evaluate('valor > 5000', { value: null, valor: 1000 })).toEqual({
      value: false,
    });
  });

  it('conjunção: exige as duas pontas (protótipo "value > 0 and value <= 50000")', () => {
    const e = 'value > 0 and value <= 50000';
    expect(consoleEvaluator.evaluate(e, { value: 100 })).toEqual({ value: true });
    expect(consoleEvaluator.evaluate(e, { value: 0 })).toEqual({ value: false });
    expect(consoleEvaluator.evaluate(e, { value: 60000 })).toEqual({ value: false });
  });

  it('disjunção: basta uma ponta', () => {
    const e = 'value = 1 or value = 2';
    expect(consoleEvaluator.evaluate(e, { value: 2 })).toEqual({ value: true });
    expect(consoleEvaluator.evaluate(e, { value: 3 })).toEqual({ value: false });
  });

  it('igualdade e desigualdade sobre strings', () => {
    expect(consoleEvaluator.evaluate('status = "aberto"', { value: null, status: 'aberto' })).toEqual({
      value: true,
    });
    expect(consoleEvaluator.evaluate('status != "aberto"', { value: null, status: 'fechado' })).toEqual(
      { value: true },
    );
  });

  it('ordem com operando ausente é falso (nunca lança)', () => {
    expect(consoleEvaluator.evaluate('valor > 5000', { value: null })).toEqual({ value: false });
  });

  it('fora do subconjunto v1 → { error }, jamais um booleano', () => {
    const bad = consoleEvaluator.evaluate('substring(value, 1) = "x"', { value: 'abc' });
    expect(bad).toHaveProperty('error');
    const noOp = consoleEvaluator.evaluate('value', { value: true });
    expect(noOp).toHaveProperty('error');
    const empty = consoleEvaluator.evaluate('   ', { value: 1 });
    expect(empty).toHaveProperty('error');
  });
});
