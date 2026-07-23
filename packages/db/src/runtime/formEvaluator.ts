import type { ExpressionEvaluator } from '@buildtovalue/forms';

/**
 * Avaliador S-FEEL de `validation`/`visibleWhen` dos FORMULÁRIOS no SERVIDOR —
 * o mesmo subconjunto rico do preview do console (comparações + and/or), NÃO o
 * avaliador de GATEWAY (que é só igualdade, por decisão do D19). Fecha a
 * divergência histórica: antes o servidor validava a submissão com o avaliador
 * de gateway (só `variavel = literal`), recusando `value > 5000` que o preview
 * aceitava.
 *
 * INTERINO da AG-2.1 etapa 7: a versão CANÔNICA vive em `@buildtovalue/forms`
 * (`formExpressionEvaluator`, já publicada no branch da bpmn como default de
 * `validateSubmission`). Assim que forms@1.1 for publicada e a plataforma subir
 * a dependência, este arquivo e o `consoleEvaluator` somem — ambos passam a
 * importar a MESMA função. Até lá, o teste de equivalência bidirecional
 * (form-evaluator-equivalence.test.ts) garante paridade byte-a-byte de
 * comportamento com o console. Ver pendencias.md §2.7.
 */

const UNSUPPORTED = Symbol.for('btv:unsupported');

type Cmp = '>=' | '<=' | '!=' | '>' | '<' | '=';
const CMP: Cmp[] = ['>=', '<=', '!=', '>', '<', '='];

function coerce(token: string, ctx: Readonly<Record<string, unknown>>): unknown {
  const t = token.trim();
  if (t === 'value') return ctx.value;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^"[^"]*"$/.test(t)) return t.slice(1, -1);
  if (/^[A-Za-z_]\w*$/.test(t)) return ctx[t];
  return UNSUPPORTED;
}

function evalComparison(
  expr: string,
  ctx: Readonly<Record<string, unknown>>,
): { value: boolean } | { error: string } {
  for (const op of CMP) {
    const at = expr.indexOf(op);
    if (at <= 0) continue;
    if (op === '=' && (expr[at - 1] === '>' || expr[at - 1] === '<' || expr[at - 1] === '!')) continue;
    const left = coerce(expr.slice(0, at), ctx);
    const right = coerce(expr.slice(at + op.length), ctx);
    if (left === UNSUPPORTED || right === UNSUPPORTED) {
      return { error: `operando fora do subconjunto v1 em "${expr.trim()}"` };
    }
    switch (op) {
      case '=':
        return { value: left === right };
      case '!=':
        return { value: left !== right };
      default: {
        if (typeof left !== 'number' || typeof right !== 'number') {
          return { value: false };
        }
        if (op === '>') return { value: left > right };
        if (op === '<') return { value: left < right };
        if (op === '>=') return { value: left >= right };
        return { value: left <= right };
      }
    }
  }
  return { error: `expressão sem operador de comparação suportado: "${expr.trim()}"` };
}

export const formEvaluator: ExpressionEvaluator = {
  evaluate(expression, context) {
    const expr = expression.trim();
    if (expr === '') return { error: 'expressão vazia' };
    if (/\bor\b/.test(expr)) {
      for (const part of expr.split(/\bor\b/)) {
        const r = this.evaluate(part, context);
        if ('error' in r) return r;
        if (r.value) return { value: true };
      }
      return { value: false };
    }
    if (/\band\b/.test(expr)) {
      for (const part of expr.split(/\band\b/)) {
        const r = this.evaluate(part, context);
        if ('error' in r) return r;
        if (!r.value) return { value: false };
      }
      return { value: true };
    }
    return evalComparison(expr, context);
  },
};
