import { describe, expect, it } from 'vitest';
import { can } from '../src/capabilities.js';

/**
 * O espelho de UX precisa bater com o RBAC do servidor (`@platform/auth`). Se
 * o servidor mudar um grant e este espelho não, o console mostra um botão que
 * o servidor recusa (403) — feio, mas nunca inseguro. Estes casos travam as
 * distinções que as telas usam para decidir o que renderizar.
 */
describe('capabilities — espelho do RBAC v1', () => {
  it('operador age no Operate; negócio não', () => {
    expect(can('operator', 'operate:act')).toBe(true);
    expect(can('operator', 'variables:reveal-sensitive')).toBe(true);
    expect(can('business', 'operate:act')).toBe(false);
    expect(can('business', 'variables:reveal-sensitive')).toBe(false);
  });

  it('negócio e analista iniciam instância; operador não inicia mas trabalha o Operate', () => {
    expect(can('business', 'instances:start')).toBe(true);
    expect(can('analyst', 'instances:start')).toBe(true);
    expect(can('operator', 'instances:start')).toBe(false);
  });

  it('só negócio (e admin) trabalha tarefa (tasks:work)', () => {
    expect(can('business', 'tasks:work')).toBe(true);
    expect(can('operator', 'tasks:work')).toBe(false);
    expect(can('admin', 'tasks:work')).toBe(true);
  });

  it('admin tem tudo', () => {
    for (const p of ['operate:act', 'instances:start', 'tasks:work', 'variables:reveal-sensitive'] as const) {
      expect(can('admin', p)).toBe(true);
    }
  });
});
