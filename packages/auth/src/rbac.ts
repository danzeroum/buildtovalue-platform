/**
 * RBAC v1 (F1.4): papéis alinhados às personas do plano (G-UX-2) + admin.
 * Permissões são INTENÇÕES estáveis — as rotas declaram a permissão, nunca o
 * papel (trocar o mapa não toca rota nenhuma).
 *
 * A matriz cresce na F3 (claim/reatribuição D24, revelação de sensíveis §3 do
 * ADENDO-01, operate); na AG-2.3 ganha o papel `auditor` [GATE-D]: SÓ leitura +
 * `audit:export`, zero escrita — a separação de deveres que o export de auditoria
 * (ISO 42001 / EU AI Act) exige. Aqui nasce o esqueleto que a F1 exercita.
 */
export const ROLES = ['admin', 'analyst', 'business', 'operator', 'auditor'] as const;
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
  'audit:export',
  // AG-3.2 (P4 — inteligência do tenant + kill-switch). SEPARAÇÃO em quatro:
  //  · ler-estado (FATO do kill-switch p/ o banner) = AMPLO (toda a Operação);
  //  · ler-config (provider/model/base_url/keyRef ponteiro; razão só p/ quem configura) = admin+auditor;
  //  · acionar/retomar o kill-switch = admin;
  //  · configurar inteligência = admin.
  // A chave NUNCA volta em nenhuma; o `keyRef` (secret://) é ponteiro, não segredo.
  'ai:read-state',
  'ai:read-config',
  'ai:operate',
  'ai:configure',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  // `ai:read-state` é AMPLO: todo papel que opera precisa VER que os agentes
  // estão pausados numa emergência (o banner vive fora da Admin). Acionar e
  // configurar continuam só no admin.
  analyst: [
    'me:read',
    'definitions:read',
    'definitions:deploy',
    'instances:read',
    'instances:start',
    'tasks:read',
    'ai:read-state',
  ],
  business: ['me:read', 'instances:read', 'instances:start', 'tasks:read', 'tasks:work', 'ai:read-state'],
  operator: [
    'me:read',
    'definitions:read',
    'instances:read',
    'instances:cancel',
    'tasks:read',
    'operate:read',
    'operate:act',
    'variables:reveal-sensitive',
    'ai:read-state',
  ],
  // [GATE-D] papel `auditor`: separação de deveres. SÓ leitura de metadados +
  // `audit:export`; ZERO escrita (sem start/cancel/work/act/deploy) e sem
  // `variables:reveal-sensitive` (o auditor lê procedência, NUNCA conteúdo —
  // "evidência nunca é conteúdo"). A ausência de qualquer permissão de escrita
  // é o contrato provado no teste `auditor não escreve nada`.
  // + AG-3.2: o auditor LÊ a config de IA (evidência de conformidade — "o tenant
  // usa provedor X via cofre"): provider/model/base_url/keyRef ponteiro. Continua
  // SEM escrita (não aciona nem configura) e sem a chave. A RAZÃO do kill-switch
  // (nível 2) só é projetada a quem tem `ai:configure` — o auditor a vê como null.
  auditor: [
    'me:read',
    'definitions:read',
    'instances:read',
    'tasks:read',
    'operate:read',
    'audit:export',
    'ai:read-state',
    'ai:read-config',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}
