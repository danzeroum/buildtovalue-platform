import { generateTemporaryPassword, hashPassword, verifyPassword } from '@platform/auth';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { recordTenantAuditEventTx, type AuditActor } from '../audit/tenantAudit.js';
import { insertAuditEvent } from '../runtime/audit.js';
import { revokeAllForUserTx } from '../repositories/refreshTokens.js';
import type { UserRole } from '../repositories/users.js';

/**
 * Administração básica (AG-3.5, ADENDO-04 §5, shape
 * `ag3-5-shape-proposta-admin-basica.md`). A4 (membros/papéis/desativar/redefinir
 * senha) + A5 (perfil/senha/preferências) + A6-A (senha temporária). Todo ATO de
 * TENANT (mudar papel, desativar/reativar, resetar senha) grava em
 * `tenant_audit_events` — mesma separação fato-de-tenant × fato-de-instância que
 * P4/P5 já usam. A desatribuição de tarefas/gates na desativação é fato DE
 * INSTÂNCIA (`history_events`, por tarefa) — quem lê a história de uma instância
 * vê exatamente por que um elemento ficou sem dono.
 */

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  disabledAt: string | null;
  mustChangePassword: boolean;
}

interface MemberQueryRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  active: boolean;
  disabled_at: Date | null;
  must_change_password: boolean;
}

function toMember(row: MemberQueryRow): MemberRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    mustChangePassword: row.must_change_password,
  };
}

export async function listMembers(sql: Sql, tenantId: string): Promise<MemberRow[]> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<MemberQueryRow[]>`
      SELECT id, email, display_name, role, active, disabled_at, must_change_password
      FROM users ORDER BY display_name`;
    return rows.map(toMember);
  });
}

/** Invariante sobre o RESULTADO, não sobre quem pediu (triagem do dono, AG-3.5):
 *  qualquer caminho que zeraria os admins ativos do tenant é recusado — auto-rebaixe,
 *  rebaixe de terceiro, auto-desativação, desativação de terceiro, todos iguais. */
async function wouldRemoveLastAdminTx(
  tx: TransactionSql,
  tenantId: string,
  targetUserId: string,
): Promise<boolean> {
  const [row] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count FROM users
    WHERE tenant_id = ${tenantId} AND role = 'admin' AND active = true AND id != ${targetUserId}`;
  return Number(row.count) === 0;
}

export type UpdateRoleOutcome =
  | { ok: true; member: MemberRow }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'LAST_ADMIN' };

export async function updateMemberRole(
  sql: Sql,
  tenantId: string,
  targetUserId: string,
  role: UserRole,
  actor: AuditActor,
  reason: string,
): Promise<UpdateRoleOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [current] = await tx<{ role: UserRole }[]>`SELECT role FROM users WHERE id = ${targetUserId}`;
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (current.role === 'admin' && role !== 'admin' && (await wouldRemoveLastAdminTx(tx, tenantId, targetUserId))) {
      return { ok: false, code: 'LAST_ADMIN' };
    }
    const [row] = await tx<MemberQueryRow[]>`
      UPDATE users SET role = ${role}, updated_at = now() WHERE id = ${targetUserId}
      RETURNING id, email, display_name, role, active, disabled_at, must_change_password`;
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'user.role_changed',
      resourceType: 'user',
      resourceId: targetUserId,
      motivo: reason,
      payload: { from: current.role, to: role },
    });
    return { ok: true, member: toMember(row) };
  });
}

export type SetActiveOutcome =
  | { ok: true; member: MemberRow; unassignedTasks: number }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'LAST_ADMIN' };

/**
 * Desativar: revoga TODAS as sessões + desatribui tarefas E gates abertos (mesma
 * query — `user_tasks.is_gate` é só uma coluna) ANTES de marcar inativo, tudo na
 * MESMA tx. Um gate órfão travaria a instância esperando uma decisão de alguém que
 * não existe mais — a supervisão do Art. 14 não pode ficar presa. Reativar só
 * limpa o estado de desativação; nada a restaurar (o que foi desatribuído já
 * voltou para a fila do papel, ação normal do produto).
 */
export async function setMemberActive(
  sql: Sql,
  tenantId: string,
  targetUserId: string,
  active: boolean,
  actor: AuditActor,
  reason: string,
): Promise<SetActiveOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [current] = await tx<{ role: UserRole; active: boolean }[]>`
      SELECT role, active FROM users WHERE id = ${targetUserId}`;
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (!active && current.role === 'admin' && (await wouldRemoveLastAdminTx(tx, tenantId, targetUserId))) {
      return { ok: false, code: 'LAST_ADMIN' };
    }

    let unassignedTasks = 0;
    if (!active) {
      await revokeAllForUserTx(tx, targetUserId);
      const openTasks = await tx<{ id: string; instance_id: string; element_id: string; is_gate: boolean }[]>`
        SELECT id, instance_id, element_id, is_gate FROM user_tasks
        WHERE tenant_id = ${tenantId} AND assignee = ${targetUserId} AND status = 'open'`;
      for (const task of openTasks) {
        await tx`UPDATE user_tasks SET assignee = NULL, claim_token = NULL, claimed_at = NULL
          WHERE id = ${task.id}`;
        await insertAuditEvent(tx, tenantId, task.instance_id, 'taskUnassignedOnDeactivation', {
          elementId: task.element_id,
          taskId: task.id,
          isGate: task.is_gate,
          previousAssignee: targetUserId,
          actor,
          reason,
        });
      }
      unassignedTasks = openTasks.length;
    }

    const [row] = active
      ? await tx<MemberQueryRow[]>`
          UPDATE users SET active = true, disabled_at = NULL, disabled_by = NULL,
                            disabled_reason = NULL, updated_at = now()
          WHERE id = ${targetUserId}
          RETURNING id, email, display_name, role, active, disabled_at, must_change_password`
      : await tx<MemberQueryRow[]>`
          UPDATE users SET active = false, disabled_at = now(), disabled_by = ${actor.id},
                            disabled_reason = ${reason}, updated_at = now()
          WHERE id = ${targetUserId}
          RETURNING id, email, display_name, role, active, disabled_at, must_change_password`;

    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: active ? 'user.reactivated' : 'user.deactivated',
      resourceType: 'user',
      resourceId: targetUserId,
      motivo: reason,
      payload: active ? {} : { unassignedTasks },
    });
    return { ok: true, member: toMember(row), unassignedTasks };
  });
}

export type ResetPasswordOutcome =
  | { ok: true; temporaryPassword: string }
  | { ok: false; code: 'NOT_FOUND' };

/** Admin reseta (A4→A6-A): senha temporária, `must_change_password=true`, TODAS as
 *  sessões antigas revogadas (a senha mudou). A senha em claro só existe no
 *  retorno desta chamada — nunca persistida, nunca no evento de auditoria. */
export async function resetMemberPassword(
  sql: Sql,
  tenantId: string,
  targetUserId: string,
  actor: AuditActor,
  reason: string,
): Promise<ResetPasswordOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [exists] = await tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${targetUserId}`;
    if (!exists) return { ok: false, code: 'NOT_FOUND' };
    const temporaryPassword = generateTemporaryPassword();
    const hash = await hashPassword(temporaryPassword);
    await tx`UPDATE users SET password_hash = ${hash}, must_change_password = true, updated_at = now()
      WHERE id = ${targetUserId}`;
    await revokeAllForUserTx(tx, targetUserId);
    await recordTenantAuditEventTx(tx, tenantId, actor, {
      eventType: 'user.password_reset',
      resourceType: 'user',
      resourceId: targetUserId,
      motivo: reason,
      // NUNCA a senha em claro no evento — evidência ≠ conteúdo.
    });
    return { ok: true, temporaryPassword };
  });
}

export type ChangePasswordOutcome =
  | { ok: true }
  | { ok: false; code: 'WRONG_CURRENT_PASSWORD' | 'NOT_FOUND' };

/** A5: o próprio usuário troca a senha (funciona igual para senha normal ou
 *  temporária — `currentPassword` é sempre verificado contra o hash atual).
 *  Revoga TODAS as outras sessões, preservando a desta requisição (`sid`, o
 *  claim do próprio access token — nunca um valor que o cliente reenvia). */
export async function changeOwnPassword(
  sql: Sql,
  tenantId: string,
  userId: string,
  input: { currentPassword: string; newPassword: string; sid: string },
): Promise<ChangePasswordOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [current] = await tx<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${userId}`;
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (!(await verifyPassword(input.currentPassword, current.password_hash))) {
      return { ok: false, code: 'WRONG_CURRENT_PASSWORD' };
    }
    const hash = await hashPassword(input.newPassword);
    await tx`UPDATE users SET password_hash = ${hash}, must_change_password = false, updated_at = now()
      WHERE id = ${userId}`;
    await revokeAllForUserTx(tx, userId, input.sid);
    await recordTenantAuditEventTx(tx, tenantId, { type: 'user', id: userId }, {
      eventType: 'user.password_changed',
      resourceType: 'user',
      resourceId: userId,
      // ato próprio, sem motivo — a marcação (A5) não pede um.
    });
    return { ok: true };
  });
}

/** A5: fuso horário + formato de data. Sem implicação de sessão. */
export async function updatePreferences(
  sql: Sql,
  tenantId: string,
  userId: string,
  prefs: { timezone: string; dateFormat: string },
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`UPDATE users SET timezone = ${prefs.timezone}, date_format = ${prefs.dateFormat}, updated_at = now()
      WHERE id = ${userId}`;
  });
}
