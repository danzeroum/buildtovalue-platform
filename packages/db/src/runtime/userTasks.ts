import { randomUUID } from 'node:crypto';
import { validateSubmission, type SubmissionErrors } from '@buildtovalue/forms';
import type { Sql } from '../client.js';
import type { FieldCipher } from '../crypto/fieldCipher.js';
import { withTenant } from '../tenancy.js';
import { getFormDefinitionByRef } from '../registry/store.js';
import { advanceInstance } from './advance.js';
import { insertAuditEvent } from './audit.js';
import { conditionEvaluator } from './definitions.js';

/**
 * User tasks pelo CONTRATO público (shape §6): claim PERSISTENTE (D21 —
 * sobrevive a restart porque vive em user_tasks.claim_token), token
 * ROTACIONADO a cada claim (decisão 10.b — um token ativo por task),
 * completion validada NO SERVIDOR com o schema PINADO do form, e
 * reatribuição por operador (D24) auditada que INVALIDA o token vigente.
 */
export interface UserTaskListItem {
  id: string;
  instance_id: string;
  element_id: string;
  form_ref: string;
  assignee: string | null;
  candidate_roles: string[];
  status: string;
  claimed_at: string | null;
  created_at: string;
}

export interface TaskViewer {
  sub: string;
  role: string;
  /** admin enxerga tudo (Operate); demais seguem a visibilidade §2.2. */
  seesAll: boolean;
}

/** Visibilidade (ADENDO §2.2 + decisão 10.d): papel alheio é FILTRADO. */
function visibleTo(task: { assignee: string | null; candidate_roles: string[] }, viewer: TaskViewer): boolean {
  if (viewer.seesAll) return true;
  if (task.assignee === viewer.sub) return true;
  if (task.candidate_roles.length === 0) return true;
  return task.candidate_roles.includes(viewer.role);
}

export async function listUserTasks(
  sql: Sql,
  tenantId: string,
  viewer: TaskViewer,
  options: {
    cursor?: string;
    limit?: number;
    status?: string;
    instanceId?: string;
    filter?: 'mine' | 'role' | 'unassigned';
  } = {},
): Promise<{ items: UserTaskListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor
    ? (() => {
        const raw = Buffer.from(options.cursor!, 'base64url').toString('utf8');
        const at = raw.lastIndexOf('|');
        return at > 0 ? { createdAt: raw.slice(0, at), id: raw.slice(at + 1) } : undefined;
      })()
    : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    // filtros SQL primeiro; a visibilidade por papel é aplicada em memória
    // sobre a página (+1) — v1 com poucos papéis por tenant.
    const rows = await tx`
      SELECT id, instance_id, element_id, form_ref, assignee, candidate_roles,
             status, claimed_at, created_at, created_at::text AS created_at_cursor
      FROM user_tasks
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.instanceId ?? null}::uuid IS NULL OR instance_id = ${options.instanceId ?? null})
        AND (${options.filter === 'mine'} = false OR assignee = ${viewer.sub})
        AND (${options.filter === 'unassigned'} = false OR assignee IS NULL)
        AND (${options.filter === 'role'} = false OR ${viewer.role} = ANY(candidate_roles))
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const visible = rows.filter((row) =>
      visibleTo(
        { assignee: row.assignee as string | null, candidate_roles: row.candidate_roles as string[] },
        viewer,
      ),
    );
    const items = visible.slice(0, limit) as unknown as UserTaskListItem[];
    const nextCursor =
      rows.length > limit
        ? Buffer.from(`${rows[limit - 1].created_at_cursor}|${rows[limit - 1].id}`).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}

export interface UserTaskDetail extends UserTaskListItem {
  payload: Record<string, unknown>;
  visible: boolean;
}

export async function getUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  viewer: TaskViewer,
): Promise<UserTaskDetail | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`
      SELECT id, instance_id, element_id, form_ref, assignee, candidate_roles,
             status, claimed_at, created_at, payload
      FROM user_tasks WHERE id = ${taskId}`;
    if (!row) return undefined;
    return {
      ...(row as unknown as UserTaskListItem),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      visible: visibleTo(
        { assignee: row.assignee as string | null, candidate_roles: row.candidate_roles as string[] },
        viewer,
      ),
    };
  });
}

export type ClaimOutcome =
  | { ok: true; claimToken: string }
  | { ok: false; reason: 'notFound' | 'notOpen'; message: string }
  | { ok: false; reason: 'held'; holder: { user: string; since: string }; message: string };

/** Claim persistente (D21): re-claim do MESMO usuário ROTACIONA o token. */
export async function claimUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  user: string,
): Promise<ClaimOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [task] = await tx`
      SELECT id, status, assignee, claimed_at FROM user_tasks
      WHERE id = ${taskId} FOR UPDATE`;
    if (!task) return { ok: false, reason: 'notFound', message: 'task não existe' };
    if (task.status !== 'open') {
      return { ok: false, reason: 'notOpen', message: `task está '${String(task.status)}'` };
    }
    if (task.assignee && task.assignee !== user) {
      // 409 com o HOLDER para a UI exibir "com {user} desde {since}" (§2.2)
      return {
        ok: false,
        reason: 'held',
        holder: { user: String(task.assignee), since: String(task.claimed_at) },
        message: `task reivindicada por ${String(task.assignee)}`,
      };
    }
    const claimToken = randomUUID(); // rotação: o token anterior MORRE aqui
    await tx`UPDATE user_tasks
      SET assignee = ${user}, claim_token = ${claimToken},
          claimed_at = COALESCE(claimed_at, now())
      WHERE id = ${taskId}`;
    return { ok: true, claimToken };
  });
}

export type UnclaimOutcome =
  | { ok: true }
  | { ok: false; reason: 'notFound' | 'notOwner'; message: string };

export async function unclaimUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  user: string,
): Promise<UnclaimOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [task] = await tx`
      SELECT assignee FROM user_tasks WHERE id = ${taskId} FOR UPDATE`;
    if (!task) return { ok: false, reason: 'notFound', message: 'task não existe' };
    if (task.assignee !== user) {
      return { ok: false, reason: 'notOwner', message: 'só o dono do claim pode desfazê-lo (operador usa /assignment)' };
    }
    await tx`UPDATE user_tasks
      SET assignee = NULL, claim_token = NULL, claimed_at = NULL
      WHERE id = ${taskId}`;
    return { ok: true };
  });
}

export type CompleteTaskOutcome =
  | { ok: true; instanceStatus: string }
  | { ok: false; reason: 'notFound' | 'notOpen' | 'staleClaim' | 'formMissing' | string; message: string }
  | { ok: false; reason: 'invalidSubmission'; errors: SubmissionErrors };

/**
 * Completion com FENCING FORMAL (critério nomeado do aceite F3): só o
 * claim_token VIGENTE conclui — token rotacionado/revogado = 409; validação
 * NO SERVIDOR com o MESMO schema pinado do renderer (422 por campo); a
 * marcação 'completed' e o fencing acontecem numa tx, o avanço do engine em
 * seguida (mesmo padrão do contrato de jobs).
 */
export async function completeUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  input: { claimToken: string; submission: Record<string, unknown>; user: string; now: string },
  cipher?: FieldCipher,
): Promise<CompleteTaskOutcome> {
  const fenced = await withTenant(sql, tenantId, async (tx) => {
    const [task] = await tx`
      SELECT id, instance_id, wait_key, form_ref, status, claim_token
      FROM user_tasks WHERE id = ${taskId} FOR UPDATE`;
    if (!task) return { ok: false as const, reason: 'notFound' as const, message: 'task não existe' };
    if (task.status !== 'open') {
      return { ok: false as const, reason: 'notOpen' as const, message: `task está '${String(task.status)}' (conclusão dupla?)` };
    }
    if (!task.claim_token || task.claim_token !== input.claimToken) {
      return {
        ok: false as const,
        reason: 'staleClaim' as const,
        message: 'claimToken não é o vigente (rotacionado, revogado ou task não reivindicada)',
      };
    }
    const form = await getFormDefinitionByRef(sql, tenantId, String(task.form_ref));
    if (!form) {
      return { ok: false as const, reason: 'formMissing' as const, message: `form '${String(task.form_ref)}' não está no registry` };
    }
    const validated = validateSubmission(form.schema, input.submission, conditionEvaluator);
    if (!validated.ok) return { ok: false as const, reason: 'invalidSubmission' as const, errors: validated.errors };
    await tx`UPDATE user_tasks
      SET status = 'completed', completed_at = now(), claim_token = NULL
      WHERE id = ${taskId}`;
    return {
      ok: true as const,
      instanceId: String(task.instance_id),
      waitKey: String(task.wait_key),
      values: validated.values,
    };
  });
  if (!fenced.ok) return fenced;
  const advanced = await advanceInstance(
    sql,
    tenantId,
    fenced.instanceId,
    {
      type: 'UserTaskCompleted',
      now: input.now,
      waitKey: fenced.waitKey,
      variables: {},
      submission: fenced.values,
    },
    { cipher },
  );
  if (!advanced.ok) return { ok: false, reason: advanced.reason, message: advanced.message };
  return { ok: true, instanceStatus: advanced.instance.status };
}

export type AssignOutcome =
  | { ok: true }
  | { ok: false; reason: 'notFound' | 'notOpen'; message: string };

/** Reatribuição por OPERADOR (D24): invalida o token vigente, auditada. */
export async function assignUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  input: { assignee: string; reason: string; actor: string },
): Promise<AssignOutcome> {
  return withTenant(sql, tenantId, async (tx) => {
    const [task] = await tx`
      SELECT id, instance_id, element_id, assignee, status
      FROM user_tasks WHERE id = ${taskId} FOR UPDATE`;
    if (!task) return { ok: false, reason: 'notFound', message: 'task não existe' };
    if (task.status !== 'open') {
      return { ok: false, reason: 'notOpen', message: `task está '${String(task.status)}'` };
    }
    await tx`UPDATE user_tasks
      SET assignee = ${input.assignee}, claim_token = NULL, claimed_at = now()
      WHERE id = ${taskId}`;
    // revogação AUDITADA (D21/D24): ator + motivo + de/para, nunca payload
    await insertAuditEvent(tx, tenantId, String(task.instance_id), 'taskReassigned', {
      taskId,
      elementId: String(task.element_id),
      from: (task.assignee as string | null) ?? null,
      to: input.assignee,
      actor: input.actor,
      reason: input.reason,
    });
    return { ok: true };
  });
}
