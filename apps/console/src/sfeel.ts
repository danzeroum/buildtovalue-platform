import type { ExpressionEvaluator } from '@buildtovalue/forms';

/**
 * Avaliador S-FEEL do PREVIEW do console (subconjunto HONESTO da v1): suporta
 * comparações (`> >= < <= = !=`) e conjunção/disjunção (`and`/`or`) sobre
 * `value` (o campo em edição) e as chaves dos outros campos — o suficiente
 * para o `visibleWhen`/`validation` dos protótipos ("value > 5000",
 * "value > 0 and value <= 50000"). Qualquer coisa fora disso retorna
 * `{ error }` — NUNCA um booleano silenciosamente errado (mesma disciplina do
 * D19/lint e da cerca de honestidade da biblioteca).
 *
 * NOTA (pendência registrada): o SERVIDOR valida a submissão com o próprio
 * avaliador injetado (hoje `conditionEvaluator` da plataforma, só igualdade).
 * Este avaliador do preview é mais rico; a UNIFICAÇÃO num avaliador único
 * consumido por console e servidor está registrada em `pendencias.md`.
 */

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
  return Symbol.for('btv:unsupported');
}

function evalComparison(
  expr: string,
  ctx: Readonly<Record<string, unknown>>,
): { value: boolean } | { error: string } {
  for (const op of CMP) {
    const at = expr.indexOf(op);
    if (at <= 0) continue;
    // não confundir '=' com '>=' '<=' '!=' (já testados antes de '=')
    if (op === '=' && (expr[at - 1] === '>' || expr[at - 1] === '<' || expr[at - 1] === '!')) continue;
    const left = coerce(expr.slice(0, at), ctx);
    const right = coerce(expr.slice(at + op.length), ctx);
    if (left === Symbol.for('btv:unsupported') || right === Symbol.for('btv:unsupported')) {
      return { error: `operando fora do subconjunto v1 em "${expr.trim()}"` };
    }
    switch (op) {
      case '=':
        return { value: left === right };
      case '!=':
        return { value: left !== right };
      default: {
        if (typeof left !== 'number' || typeof right !== 'number') {
          // comparação de ordem exige números definidos; ausente → falso
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

export const consoleEvaluator: ExpressionEvaluator = {
  evaluate(expression, context) {
    const expr = expression.trim();
    if (expr === '') return { error: 'expressão vazia' };
    // conjunção tem precedência menor que disjunção no S-FEEL; a v1 do preview
    // trata `and`/`or` da esquerda para a direita, sem parênteses.
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
