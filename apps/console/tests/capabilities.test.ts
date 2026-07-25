import { ROLES as SERVER_ROLES } from '@platform/auth';
import { describe, expect, it } from 'vitest';
import { can, GRANTS, type Permission } from '../src/capabilities.js';
import type { Role } from '../src/session.js';

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

  it('auditor: só leitura + audit:export — ZERO escrita, nunca revela sensível (evidência nunca é conteúdo)', () => {
    expect(can('auditor', 'audit:export')).toBe(true);
    expect(can('auditor', 'instances:read')).toBe(true);
    for (const p of ['instances:start', 'instances:cancel', 'tasks:work', 'operate:act', 'definitions:deploy', 'variables:reveal-sensitive', 'ai:operate', 'ai:configure'] as const) {
      expect(can('auditor', p)).toBe(false);
    }
  });

  it('AG-3.4 (P5): tools:read é admin+auditor; tools:configure só admin', () => {
    expect(can('admin', 'tools:read')).toBe(true);
    expect(can('admin', 'tools:configure')).toBe(true);
    expect(can('auditor', 'tools:read')).toBe(true);
    expect(can('auditor', 'tools:configure')).toBe(false);
    for (const role of ['analyst', 'business', 'operator'] as const) {
      expect(can(role, 'tools:read')).toBe(false);
      expect(can(role, 'tools:configure')).toBe(false);
    }
  });

  it('AG-3.5 (admin básica): members:* só admin; me:write é universal (todo papel troca a própria senha)', () => {
    expect(can('admin', 'members:read')).toBe(true);
    expect(can('admin', 'members:manage')).toBe(true);
    for (const role of ['analyst', 'business', 'operator', 'auditor'] as const) {
      expect(can(role, 'members:read')).toBe(false);
      expect(can(role, 'members:manage')).toBe(false);
      expect(can(role, 'me:write')).toBe(true);
    }
    expect(can('admin', 'me:write')).toBe(true);
  });
});

/**
 * FECHA A CLASSE, não só o caso (achado do G-UX-3 da timeline, AG-3.4): o
 * papel `auditor` existia no `rbac.ts` do servidor mas faltava no `GRANTS`
 * daqui — `GRANTS['auditor']` → `undefined.includes(...)` → CRASH em runtime
 * para quem logasse como auditor, justo o papel de conformidade. A causa raiz
 * não é "esqueci o auditor" — é a ausência de qualquer teste que garanta que
 * TODO papel real do servidor tem entrada aqui. Estes dois testes leem
 * `ROLES` DIRETO do `@platform/auth` (fonte da verdade) — um papel novo
 * amanhã sem este espelho atualizado FALHA aqui, antes de chegar a produção.
 */
describe('paridade de papéis servidor↔console (nunca mais um papel novo derruba can())', () => {
  it('todo papel de ROLES (servidor) tem entrada em GRANTS (console)', () => {
    for (const serverRole of SERVER_ROLES) {
      expect(Object.prototype.hasOwnProperty.call(GRANTS, serverRole)).toBe(true);
    }
  });

  it('can() nunca lança para nenhum papel real do servidor', () => {
    for (const serverRole of SERVER_ROLES) {
      expect(() => can(serverRole as Role, 'me:read' as Permission)).not.toThrow();
    }
  });
});
