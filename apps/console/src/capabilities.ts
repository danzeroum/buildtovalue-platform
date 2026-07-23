import type { Role } from './session.js';

/**
 * ESPELHO DE UX do RBAC v1 (o servidor é o guarda REAL — `@platform/auth`
 * `GRANTS`; toda rota declara a permissão e devolve 403 quando falta). Aqui
 * só decidimos o que MOSTRAR: um operador de negócio não vê o botão «Repetir»
 * de um incidente, mas se forjasse a chamada o servidor recusaria mesmo assim.
 * Mantido byte-a-byte com o mapa do servidor; divergência é falha de UX, não
 * de segurança. (Espelho local para não arrastar `node:crypto` do
 * `@platform/auth` para o bundle do navegador.)
 */
export type Permission =
  | 'me:read'
  | 'definitions:read'
  | 'definitions:deploy'
  | 'instances:read'
  | 'instances:start'
  | 'instances:cancel'
  | 'tasks:read'
  | 'tasks:work'
  | 'operate:read'
  | 'operate:act'
  | 'variables:reveal-sensitive';

const ALL: Permission[] = [
  'me:read',
  'definitions:read',
  'definitions:deploy',
  'instances:read',
  'instances:start',
  'instances:cancel',
  'tasks:read',
  'tasks:work',
  'operate:read',
  'operate:act',
  'variables:reveal-sensitive',
];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: ALL,
  analyst: ['me:read', 'definitions:read', 'definitions:deploy', 'instances:read', 'instances:start', 'tasks:read'],
  business: ['me:read', 'instances:read', 'instances:start', 'tasks:read', 'tasks:work'],
  operator: [
    'me:read',
    'definitions:read',
    'instances:read',
    'instances:cancel',
    'tasks:read',
    'operate:read',
    'operate:act',
    'variables:reveal-sensitive',
  ],
};

/** Espelho de `hasPermission` do servidor — só para decidir o que renderizar. */
export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}
