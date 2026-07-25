# AG-3.5 — Proposta de shape (dev → triagem do dono) · Administração básica (A4/A5/A6-A)

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Nenhuma rota
> codada antes do ok. Par de: `docs/handoff/ADENDO-04-administracao.md` §5 (recorte fechado),
> `docs/handoff/ag3-marcacao-administracao.md` §2-4 (marcação aprovada de A4/A5/A6-A — rótulo,
> voz e tratamento já fechados; este doc só fecha rota/RBAC/schema). Levantamento prévio
> (backend existente vs. faltante) já entregue em chat e aceito pelo dono; este documento
> formaliza o shape com os três pontos que o dono pediu resolvidos.

## 0 · O que já existe (confirmado por investigação, nada presumido)

- **`users`** (migração `0001`): `id/tenant_id/email/password_hash/display_name/role/
  created_at/updated_at`. `app_api` já tem `SELECT/INSERT/UPDATE/DELETE` — a permissão de
  banco não é o gargalo, faltam COLUNAS e CÓDIGO.
- **`UserRepository`** (`packages/db/src/repositories/users.ts`): só 3 métodos, TODOS leitura
  (`findTenantBySlug`/`findByEmail`/`findById`). Zero `list`/`update`.
- **`login`** (`apps/api/src/routes/auth.ts`): verifica só `password_hash` — não checa
  nenhum estado de ativação (coluna não existe) nem nenhuma flag de troca obrigatória
  (também não existe).
- **`authenticate`** (`apps/api/src/app.ts`): decodifica o JWT e para — **zero consulta ao
  banco por request**. É o ponto onde as checagens de `active`/`must_change_password` entram.
- **`RefreshTokenRepository.revoke`** (`packages/db/src/repositories/refreshTokens.ts`):
  revoga **um** token por id. Falta "revogar todos os de um usuário".
- **`UserRow.role`** (tipo TS, `repositories/users.ts`): só 4 valores — falta `'auditor'`,
  que já está no CHECK do banco (`0015`), no RBAC (`packages/auth/src/rbac.ts`) e no
  `loginResponseSchema`/`meResponseSchema` (`packages/api-contracts/src/auth.ts`, que já
  incluem `'auditor'` no enum). É só o tipo do lado do banco que ficou para trás.
- **`hashPassword`/`verifyPassword`/`generateRefreshToken`** (`@platform/auth`) — prontos,
  reutilizáveis para reset/troca de senha sem código novo de criptografia.
- **`tenant_audit_events`** (`0006`, via `recordTenantAuditEventTx`) — mecanismo já usado por
  P4/P5 para ações de TENANT sem instância (kill-switch, tools). É o lugar certo para os
  atos de administração de membros (mudar papel, desativar, resetar senha).
- **`insertAuditEvent`** (`packages/db/src/runtime/audit.ts`) — mecanismo já usado por
  `taskClaimed`/`taskUnclaimed` (AG-3.3) para fatos de INSTÂNCIA. É o lugar certo para a
  desatribuição de tarefas/gates na desativação (evento por instância afetada).
- **Console:** `.shell-user` no topbar (`shell.tsx`) já mostra nome+papel+Sair — é onde A5
  pluga sem chrome novo. Zero tela de administração hoje (nem rota `/admin` no `main.tsx`).

## 1 · Os três pontos que o dono pediu resolvidos

### 1.1 · Checagem de `active` no `authenticate` + revoke-all (cinto e suspensório)

**Decisão: os DOIS, como o dono recomendou.** Revogar tokens corta a sessão na hora para
quem ainda não tem access token em voo; checar `active` fecha a janela de até 15 min
(`JWT_ACCESS_TTL_SECONDS`) de um access token já emitido antes da desativação.

A consulta é a MAIS BARATA possível — `SELECT active, must_change_password FROM users WHERE
id = $1` (lookup por PK, sem join) — e roda **DEPOIS** da verificação de assinatura/validade
do JWT (`verifyAccessToken` primeiro; a query só acontece se o token já é válido — nunca paga
o custo de banco para um token forjado/expirado):

```ts
// apps/api/src/app.ts, dentro de app.decorate('authenticate', ...), APÓS verifyAccessToken:
const authState = await deps.users.getAuthState(req.auth.tenantId, req.auth.sub);
if (!authState || !authState.active) {
  return problem(reply, {
    type: PROBLEM_TYPES.unauthorized,
    title: 'Conta desativada',
    status: 401,
    requestId: String(req.id),
  }); // MESMA família de "token inválido" — a conta não é mais um princípio autenticável.
}
if (authState.mustChangePassword && !MUST_CHANGE_ALLOWLIST.has(req.routeOptions.url)) {
  return problem(reply, {
    type: PROBLEM_TYPES.forbidden,
    title: 'Senha temporária — troque antes de continuar',
    status: 403,
    requestId: String(req.id),
  }); // autenticado, mas restrito a uma ação pendente — família 403, não 401.
}
```

`MUST_CHANGE_ALLOWLIST = new Set(['/v1/me', '/v1/me/password'])` — só essas duas rotas
funcionam com `must_change_password:true`; qualquer outra rota autenticada devolve 403 com a
mensagem acima (nunca um erro genérico — é a mesma honestidade das paradas honestas). Nota:
`/v1/auth/refresh` **não passa por `authenticate`** (recebe o refresh token no corpo, não
Bearer) — não precisa entrar no allowlist.

**Revoke-all acontece em DOIS pontos** (mesmo mecanismo, `RefreshTokenRepository.revokeAllForUser`,
novo método):
- ao **desativar** um usuário (§1.2);
- ao **trocar de senha**, seja via reset do admin (a senha muda) ou via troca pelo próprio
  usuário (A5) — em ambos os casos a senha mudou, então toda sessão baseada na senha antiga
  deve morrer.

**A ressalva "você continua conectado só aqui" (A5) exige um detalhe de contrato:** para a
API saber QUAL sessão preservar, o cliente precisa mandar o PRÓPRIO refresh token no corpo de
`PATCH /v1/me/password` — a rota revoga TODOS os refresh tokens do usuário **exceto** o que
veio no corpo. Sem isso, "encerrar as outras" e "continuar só aqui" são indistinguíveis para
o servidor. Documentado em §2.3.

### 1.2 · Desatribuição de tarefas E gates ao desativar, com trilha de auditoria

**Confirmado: `user_tasks` é a MESMA tabela para tarefa comum e gate** (`is_gate` é só uma
coluna, migração `0013`) — `assignee`/`claim_token`/`claimed_at` funcionam idêntico nos dois
casos. A desatribuição na desativação **cobre os dois igualmente, pela MESMA query** — não
existe um caminho separado para gate:

```ts
// dentro da MESMA tx que desativa o usuário:
const openTasks = await tx<{ id: string; instance_id: string; element_id: string; is_gate: boolean }[]>`
  SELECT id, instance_id, element_id, is_gate FROM user_tasks
  WHERE tenant_id = ${tenantId} AND assignee = ${targetUserId} AND status = 'open'`;
for (const task of openTasks) {
  await tx`UPDATE user_tasks SET assignee = NULL, claim_token = NULL, claimed_at = NULL
    WHERE id = ${task.id}`;
  await insertAuditEvent(tx, tenantId, task.instance_id, 'taskUnassignedOnDeactivation', {
    elementId: task.element_id, taskId: task.id, isGate: task.is_gate,
    previousAssignee: targetUserId, actor, reason,
  });
}
```

**Por que isso importa mais para gate que para tarefa comum:** uma tarefa comum órfã ainda é
visível para qualquer um do papel `candidate_roles` — incômodo, não bloqueio. Um GATE órfão
(a supervisão humana do Art. 14) É um bloqueio: a instância fica esperando uma decisão de
alguém que não existe mais, e **nada hoje reabre isso automaticamente** — só a desatribuição
devolve o gate à fila do papel. Sem esta correção, desativar um usuário com um gate pendente
travaria a instância permanentemente. `insertAuditEvent` é **por tarefa** (não um resumo) —
cada desatribuição é um fato consultável na história da instância certa, com ator+motivo
(o motivo é o MESMO da desativação, propagado).

O ato de desativação em si (fato de TENANT, não de instância) grava em `tenant_audit_events`
(`event_type: 'user.deactivated'`, `resourceType: 'user'`, `resourceId: targetUserId`,
`motivo`) — a mesma separação que P4/P5 já fazem entre fato-de-tenant e fato-de-instância.

### 1.3 · Fluxo completo de senha (reset → temporária → forçar troca → revoke-all)

Fluxo nomeado, ponta a ponta:

1. **Admin reseta** (`POST /v1/admin/members/:id/reset-password`, motivo obrigatório) →
   gera senha aleatória, grava o HASH, `must_change_password = true`, revoga TODOS os
   refresh tokens do alvo (a senha mudou, sessões antigas morrem), devolve a senha em
   **texto plano UMA VEZ** na resposta (nunca persistida em claro, nunca logada — mesma
   disciplina do leak-fail/kill-switch reason).
2. **Usuário loga com ela** — login comum (`verifyPassword` contra o hash novo funciona
   igual); a resposta de login já inclui `mustChangePassword: true` (novo campo no
   `loginResponseSchema`) para o console abrir a tela obrigatória sem round-trip extra.
3. **Forçado a trocar** — `must_change_password=true` bloqueia TODAS as rotas exceto
   `GET /v1/me` e `PATCH /v1/me/password` (§1.1) — o usuário não circula sem trocar.
4. **Trocar encerra as outras sessões** — `PATCH /v1/me/password` seta `must_change_password
   = false`, grava o hash novo, revoga todos os refresh tokens EXCETO o que veio no corpo
   da requisição (§1.1).

## 2 · Rotas propostas

### 2.1 · Membros — A4

```
GET /v1/admin/members                                            → 200
{ "items": [{ "id", "displayName", "email", "role",
    "active", "disabledAt", "mustChangePassword" }] }
```
RBAC `members:read` (admin apenas — não é evidência de conformidade como tools/audit; é
gestão administrativa direta).

```
PATCH /v1/admin/members/:id/role       body: { "role": "...", "reason": "…" }   → 200
PATCH /v1/admin/members/:id/active     body: { "active": bool, "reason": "…" }  → 200
POST  /v1/admin/members/:id/reset-password  body: { "reason": "…" }            → 200
{ "temporaryPassword": "…" }   // SÓ nesta resposta, uma vez, nunca mais
```
RBAC `members:manage` (admin apenas). `reason` obrigatório nas três — motivo é evidência,
mesma disciplina do kill-switch/tools. **Lockout do último admin (§3):** `role` (mudando
PARA fora de `admin`) e `active:false` (desativando um `admin`) são recusados com 422 se a
tenant ficaria com ZERO admins ativos após a operação — vale para auto-ação e para ação de
terceiro, o invariante é sobre o RESULTADO, não sobre quem pediu.

### 2.2 · Perfil — A5

```
PATCH /v1/me/password
  body: { "currentPassword": "…", "newPassword": "…", "refreshToken": "…" }     → 200
```
RBAC: nenhuma permissão nova além de estar autenticado — `me:write` (novo, concedido a
TODO papel, mesmo padrão universal de `me:read`). `currentPassword` verificado com
`verifyPassword` (funciona igual para senha normal ou temporária — é sempre o hash atual).
`refreshToken` no corpo é o que permite "revoga todas as outras, mantém esta" (§1.1) — 422
se o token não bater com uma sessão do próprio usuário.

```
PATCH /v1/me/preferences   body: { "timezone": "…", "dateFormat": "…" }         → 200
```
RBAC `me:write`. Sem implicação de sessão — update simples.

`GET /v1/me` (existente) ganha `mustChangePassword`, `timezone`, `dateFormat` na resposta.

## 3 · RBAC — o [GATE]

Escopos novos: `members:read`, `members:manage`, `me:write`.

| Papel | `members:read` | `members:manage` | `me:write` |
|---|---|---|---|
| admin | ✅ | ✅ | ✅ |
| analyst/business/operator/auditor | — | — | ✅ |

`me:write` é universal (todo usuário troca a própria senha/preferências, inclusive
`business`) — mesma régua de `me:read`.

**Lockout do último admin** (proposta-default, `packages/db/src/repositories/users.ts` ou
função dedicada em `admin/members.ts`):
```ts
async function wouldRemoveLastAdmin(tx, tenantId, targetUserId): Promise<boolean> {
  const [row] = await tx<{ count: string }[]>`
    SELECT count(*) FROM users
    WHERE tenant_id = ${tenantId} AND role = 'admin' AND active = true AND id != ${targetUserId}`;
  return Number(row.count) === 0;
}
```
Chamado antes de aplicar `role` (saindo de `admin`) ou `active:false` (em um `admin`) — 422
`"não é possível remover o último admin do tenant"` se `true`.

## 4 · Migração (`0021`, sem quebrar nada existente)

```sql
ALTER TABLE users
  ADD COLUMN active               boolean NOT NULL DEFAULT true,
  ADD COLUMN disabled_at          timestamptz,
  ADD COLUMN disabled_by          uuid REFERENCES users(id),
  ADD COLUMN disabled_reason      text,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN timezone             text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN date_format          text NOT NULL DEFAULT 'DD/MM/YYYY'
    CHECK (date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'));

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'analyst', 'business', 'operator', 'auditor'));
-- (o CHECK já aceita 'auditor' desde a 0015 — este ALTER é redundante e pode ser
-- OMITIDO; citado aqui só para confirmar que não há necessidade de mexer nele. O que
-- muda é só `UserRow['role']` do lado TypeScript, sem migração.)
```

`disabled_at`/`disabled_by`/`disabled_reason` são o denormalizado (leitura O(1) em
`GET /v1/admin/members`), mesmo padrão do `kill_switch_at`/`kill_switch_by`/
`kill_switch_reason` em `tenant_ai_config` — `tenant_audit_events` continua a fonte de
verdade.

## 5 · Fora deste shape (F4, já fechado no ADENDO-04 §5)

"+ Adicionar pessoa" (criação de usuário) — ausente, não desabilitada (marcação §2, motivo à
vista). Recuperação autoatendimento (A6-B, e-mail transacional). Nenhum dos dois entra aqui.

## 6 · Ordem de código (quando o gate abrir)

1. Migração `0021`.
2. `UserRepository`: `getAuthState`, `list`, `updateRole`, `setActive`, `resetPassword`,
   `changePassword`, `updatePreferences` (+ `UserRow.role` ganha `'auditor'`); espelhar o
   fake de `apps/api/src/testing/fakes.ts`.
3. `RefreshTokenRepository.revokeAllForUser` (+ variante "exceto um token").
4. `app.authenticate` ganha as duas checagens (§1.1); `MUST_CHANGE_ALLOWLIST`.
5. Desatribuição de tarefas/gates na desativação (§1.2), dentro da tx de `setActive(false)`.
6. Rotas `apps/api/src/routes/admin.ts` (membros) + extensão de `routes/auth.ts` (`/v1/me/
   password`, `/v1/me/preferences`, campos novos em `/v1/me` e `loginResponseSchema`).
7. RBAC (`members:read`/`members:manage`/`me:write`) + espelho `capabilities.ts` + parity test.
8. Testes: os 5 aceites do ADENDO-04 §8 relevantes a esta fatia (2, 4) + lockout do último
   admin + desatribuição de gate (não só tarefa comum) + `must_change_password` bloqueando
   tudo exceto as duas rotas + revoke-all nos dois pontos + "continua conectado só aqui"
   (refresh token preservado).

UI (A4/A5/A6-A) fica para depois deste gate fechar — a marcação já existe
(`ag3-marcacao-administracao.md` §2-4), então não é preciso um novo G-UX-3 de design antes
do código de tela, só a revisão de acessibilidade/estados de sempre.
