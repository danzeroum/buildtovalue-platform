import { describe, expect, it } from 'vitest';
import { pinnedElementLabel } from '../src/runtime/outbox.js';

/**
 * Unidade da extração do rótulo (0022). Sem Postgres: a regra é pura, e é ela
 * que decide o que fica GRAVADO para sempre na tarefa — `user_tasks` é registro
 * de trabalho realizado e não se corrige depois.
 */
describe('pinnedElementLabel — o que vira rótulo pinado', () => {
  it('rótulo comum é pinado verbatim', () => {
    expect(pinnedElementLabel({ label: 'Etapa 1' })).toBe('Etapa 1');
    expect(pinnedElementLabel({ label: 'Aprovar pedido' })).toBe('Aprovar pedido');
  });

  it('rótulo hostil é pinado COMO ESTÁ — escapar é da camada de renderização', () => {
    // Sanitizar aqui adulteraria o modelo publicado: a trilha deve dizer o que o
    // elemento se chamava, não uma versão higienizada dele. Quem garante que não
    // executa é o JSX (interpola como texto), coberto em tasks-label.test.tsx.
    const hostil = '<script>alert("xss")</script>';
    expect(pinnedElementLabel({ label: hostil })).toBe(hostil);
  });

  it('sem nó (definição embutida, fora do registry) → null', () => {
    expect(pinnedElementLabel(undefined)).toBeNull();
  });

  it('nó sem label → null', () => {
    expect(pinnedElementLabel({})).toBeNull();
  });

  it('vazio e whitespace NÃO viram rótulo — seriam título em branco na Tasklist', () => {
    expect(pinnedElementLabel({ label: '' })).toBeNull();
    expect(pinnedElementLabel({ label: '   ' })).toBeNull();
    expect(pinnedElementLabel({ label: '\n\t' })).toBeNull();
  });

  it('label de tipo errado no diagrama → null, nunca coerção', () => {
    expect(pinnedElementLabel({ label: 42 })).toBeNull();
    expect(pinnedElementLabel({ label: null })).toBeNull();
    expect(pinnedElementLabel({ label: { pt: 'Etapa' } })).toBeNull();
  });

  it('preserva acento, emoji e espaço interno — só as bordas decidem ausência', () => {
    expect(pinnedElementLabel({ label: '🚀 Início com emoji' })).toBe('🚀 Início com emoji');
    expect(pinnedElementLabel({ label: 'Emissão de parecer — ç, ñ, 中文' })).toBe(
      'Emissão de parecer — ç, ñ, 中文',
    );
  });
});
