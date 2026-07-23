import { randomUUID } from 'node:crypto';
import { formExpressionEvaluator, validateSubmission, type SubmissionErrors } from '@buildtovalue/forms';
import type { Sql } from '../client.js';
import type { FieldCipher } from '../crypto/fieldCipher.js';
import { withTenant } from '../tenancy.js';
import { getDefinitionDecisionInfo, getFormDefinitionByRef } from '../registry/store.js';
import { advanceInstance } from './advance.js';
import { insertAuditEvent } from './audit.js';

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
  /** D31: gate de tool (userTask btvGate). Marcador RESOLVIDO no despacho contra
   *  a definição pinada — a Tasklist comum o EXCLUI (não é tarefa de negócio). */
  is_gate: boolean;
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
    /** D31: por padrão a Tasklist NÃO mostra gates de tool (não são tarefa de
     *  negócio; o modo-agente da fila é AG-3). Operate/superfície de gate passam
     *  true para consultá-los explicitamente. */
    includeGates?: boolean;
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
             status, claimed_at, created_at, is_gate, created_at::text AS created_at_cursor
      FROM user_tasks
      WHERE (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.instanceId ?? null}::uuid IS NULL OR instance_id = ${options.instanceId ?? null})
        -- D31: gate de tool NÃO é tarefa comum — some da Tasklist de negócio por
        -- padrão (o modo-agente da fila é AG-3). includeGates=true traz de volta.
        AND (${options.includeGates ?? false} = true OR is_gate = false)
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
  /** etapa 6: variável de decisão declarada no BPMN; null = não exige decisão. */
  decision_var: string | null;
  /** etapa 6: valores EXATOS que roteiam (do gateway a jusante); null = texto livre. */
  decision_options: string[] | null;
}

export async function getUserTask(
  sql: Sql,
  tenantId: string,
  taskId: string,
  viewer: TaskViewer,
): Promise<UserTaskDetail | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx`
      SELECT ut.id, ut.instance_id, ut.element_id, ut.form_ref, ut.assignee,
             ut.candidate_roles, ut.status, ut.claimed_at, ut.created_at, ut.payload,
             ut.is_gate, i.definition_ref
      FROM user_tasks ut JOIN instances i ON i.id = ut.instance_id
      WHERE ut.id = ${taskId}`;
    if (!row) return undefined;
    // decisionVar + opções do BPMN — o cliente sabe que ESTA task exige decisão
    // e oferece a ESCOLHA EXATA (não texto livre), fechando o desencontro de
    // valor (etapa 6): "Aprovar" ≠ "aprovar" jamais chega ao servidor.
    const decision = await getDefinitionDecisionInfo(
      tx,
      String(row.definition_ref),
      String(row.element_id),
    );
    return {
      ...(row as unknown as UserTaskListItem),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      visible: visibleTo(
        { assignee: row.assignee as string | null, candidate_roles: row.candidate_roles as string[] },
        viewer,
      ),
      decision_var: decision.decisionVar,
      decision_options: decision.decisionOptions,
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

/** Comprimento máximo de uma `decision` (token de roteamento, não conteúdo). */
export const DECISION_MAX_LENGTH = 200;

export type CompleteTaskOutcome =
  | { ok: true; instanceStatus: string }
  | { ok: false; reason: 'notFound' | 'notOpen' | 'staleClaim' | 'formMissing' | string; message: string }
  | { ok: false; reason: 'invalidSubmission'; errors: SubmissionErrors }
  // etapa 6 — a decisão NUNCA é ignorada em silêncio:
  | { ok: false; reason: 'decisionRequired' | 'decisionUnexpected' | 'decisionInvalid'; message: string };

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
  input: {
    claimToken: string;
    submission: Record<string, unknown>;
    user: string;
    now: string;
    /** etapa 6: valor de roteamento; obrigatória sse o elemento declara decisionVar. */
    decision?: string;
  },
  cipher?: FieldCipher,
): Promise<CompleteTaskOutcome> {
  const fenced = await withTenant(sql, tenantId, async (tx) => {
    // JOIN com instances: o definition_ref localiza o diagrama para resolver a
    // decisionVar declarada no BPMN (opção B) do elemento desta task.
    const [task] = await tx`
      SELECT ut.id, ut.instance_id, ut.wait_key, ut.element_id, ut.form_ref,
             ut.status, ut.claim_token, i.definition_ref
      FROM user_tasks ut JOIN instances i ON i.id = ut.instance_id
      WHERE ut.id = ${taskId} FOR UPDATE`;
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
    // avaliador CANÔNICO de formulário (@buildtovalue/forms) — a MESMA função do
    // preview do console; a divergência histórica (§2.6) fica fechada de vez.
    const validated = validateSubmission(form.schema, input.submission, formExpressionEvaluator);
    if (!validated.ok) return { ok: false as const, reason: 'invalidSubmission' as const, errors: validated.errors };

    // etapa 6 — A DECISÃO NUNCA É IGNORADA EM SILÊNCIO (mesma família do
    // /cancel e da parada honesta: nunca fingir que agiu):
    const { decisionVar, decisionOptions } = await getDefinitionDecisionInfo(
      tx,
      String(task.definition_ref),
      String(task.element_id),
    );
    const decision = input.decision?.trim();
    if (decisionVar && !decision) {
      return {
        ok: false as const,
        reason: 'decisionRequired' as const,
        message: `elemento '${String(task.element_id)}' declara decisionVar '${decisionVar}' — o campo 'decision' é obrigatório`,
      };
    }
    if (!decisionVar && input.decision !== undefined) {
      return {
        ok: false as const,
        reason: 'decisionUnexpected' as const,
        message: `elemento '${String(task.element_id)}' não declara decisionVar — 'decision' não seria roteada; conclua sem 'decision'`,
      };
    }
    if (decision && decision.length > DECISION_MAX_LENGTH) {
      return {
        ok: false as const,
        reason: 'decisionInvalid' as const,
        message: `'decision' excede ${DECISION_MAX_LENGTH} caracteres`,
      };
    }
    // DESENCONTRO DE VALOR: se as opções são deriváveis do gateway a jusante e a
    // decisão não está entre elas, NENHUMA condição casaria (aprovação inócua
    // pela porta do valor) — recusa 422 com a lista, nunca aceita-e-descarta.
    if (decision && decisionOptions && !decisionOptions.includes(decision)) {
      return {
        ok: false as const,
        reason: 'decisionInvalid' as const,
        message: `'decision' = '${decision}' não é uma rota válida de '${decisionVar}' (esperado: ${decisionOptions.map((o) => `'${o}'`).join(', ')})`,
      };
    }

    await tx`UPDATE user_tasks
      SET status = 'completed', completed_at = now(), claim_token = NULL
      WHERE id = ${taskId}`;
    // a decisão entra nas variáveis do avanço sob a decisionVar: o engine a lê
    // no gateway a jusante (igualdade) E o host a persiste em `variables`.
    const values =
      decisionVar && decision ? { ...validated.values, [decisionVar]: decision } : validated.values;
    return {
      ok: true as const,
      instanceId: String(task.instance_id),
      waitKey: String(task.wait_key),
      elementId: String(task.element_id),
      values,
      decisionVar: decisionVar ?? null,
      decision: decision ?? null,
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
    {
      cipher,
      // etapa 6: a decisão vai TAMBÉM para history_events (Operate + XES mostram
      // quem decidiu o quê), na MESMA tx do avanço — atômica com a variável.
      onApplied:
        fenced.decisionVar && fenced.decision
          ? async (tx) => {
              await insertAuditEvent(tx, tenantId, fenced.instanceId, 'taskDecision', {
                elementId: fenced.elementId,
                decisionVar: fenced.decisionVar,
                decision: fenced.decision,
                actor: input.user,
              });
            }
          : undefined,
    },
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
