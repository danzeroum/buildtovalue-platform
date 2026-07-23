/**
 * ESPELHO VENDORIZADO (sob gate) do corpus canônico de conformidade S-FEEL.
 *
 * FONTE ÚNICA: @buildtovalue/forms → `SFEEL_FORM_CORPUS` (bpmn:
 * packages/forms/src/conformance.ts). Enquanto forms@1.1 (com o export) não
 * sobe na plataforma, este arquivo é uma cópia BYTE-A-BYTE do artefato, para
 * que o teste de equivalência afira o servidor e o console contra o MESMO
 * `expect` que a canônica. Coexistência transitória — precedente do Anexo C
 * item 2 (simulation×engine). Ver pendencias.md §2.7.
 *
 * PONTO DE COLAPSO (nomeado): publicado forms@1.1.0-next.N e subida a dep →
 *   import { SFEEL_FORM_CORPUS } from '@buildtovalue/forms'   nos testes;
 *   DELETAR este arquivo e as cópias locais do avaliador (server formEvaluator,
 *   console consoleEvaluator); o teste de equivalência sobrevive como REGRESSÃO
 *   contra a canônica.
 */
export interface SfeelConformanceCase {
  expr: string;
  ctx: Record<string, unknown>;
  expect: { value: boolean } | { error: true };
}

export const SFEEL_FORM_CORPUS: readonly SfeelConformanceCase[] = [
  // igualdade / desigualdade (o que o servidor JÁ fazia)
  { expr: 'value = "aprovar"', ctx: { value: 'aprovar' }, expect: { value: true } },
  { expr: 'value = "aprovar"', ctx: { value: 'reprovar' }, expect: { value: false } },
  { expr: 'decisao = "reprovar"', ctx: { decisao: 'reprovar' }, expect: { value: true } },
  { expr: 'ativo = true', ctx: { ativo: true }, expect: { value: true } },
  { expr: 'ativo = false', ctx: { ativo: true }, expect: { value: false } },
  { expr: 'n = 3', ctx: { n: 3 }, expect: { value: true } },
  { expr: 'value != "x"', ctx: { value: 'y' }, expect: { value: true } },
  // comparações de ordem (a DIVERGÊNCIA que o servidor recusava)
  { expr: 'value > 5000', ctx: { value: 6000 }, expect: { value: true } },
  { expr: 'value > 5000', ctx: { value: 4000 }, expect: { value: false } },
  { expr: 'value >= 10', ctx: { value: 10 }, expect: { value: true } },
  { expr: 'value <= 50000', ctx: { value: 50000 }, expect: { value: true } },
  { expr: 'value < 0', ctx: { value: 5 }, expect: { value: false } },
  // ordem com operando não-numérico → falso (não-erro): honesto
  { expr: 'value > 5', ctx: { value: undefined }, expect: { value: false } },
  // and / or
  { expr: 'value > 0 and value <= 50000', ctx: { value: 25000 }, expect: { value: true } },
  { expr: 'value > 0 and value <= 50000', ctx: { value: 60000 }, expect: { value: false } },
  { expr: 'value = "a" or value = "b"', ctx: { value: 'b' }, expect: { value: true } },
  { expr: 'value = "a" or value = "b"', ctx: { value: 'c' }, expect: { value: false } },
  { expr: 'tipo = "pj" and valor > 1000', ctx: { tipo: 'pj', valor: 2000 }, expect: { value: true } },
  // erros DECLARADOS (nunca booleano silencioso)
  { expr: '', ctx: {}, expect: { error: true } },
  { expr: 'value ~ 3', ctx: { value: 3 }, expect: { error: true } },
  { expr: 'funcao(value)', ctx: { value: 1 }, expect: { error: true } },
];
