/**
 * RBAC v1 (F1.4): papéis alinhados às personas do plano (G-UX-2) + admin.
 * Permissões são INTENÇÕES estáveis — as rotas declaram a permissão, nunca o
 * papel (trocar o mapa não toca rota nenhuma).
 *
 * A matriz cresce na F3 (claim/reatribuição D24, revelação de sensíveis §3 do
 * ADENDO-01, operate); aqui nasce o esqueleto que a F1 exercita.
 */
export const ROLES = ['admin', 'analyst', 'business', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
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

export function hasPermission(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}
