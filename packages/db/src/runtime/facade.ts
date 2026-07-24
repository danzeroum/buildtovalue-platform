import type { Sql } from '../client.js';
import { createFieldCipher, type KeyProvider } from '../crypto/fieldCipher.js';
import { resumeAgentJobs as resumeAgentJobsRow, type PauseKind, type ResumeResult } from '../agent/resume.js';
import { reproposeGate as reproposeGateRow, type ReproposeResult } from '../agent/repropose.js';
import type { AuditActor } from '../audit/tenantAudit.js';
import {
  getIdempotentResponse,
  putIdempotentResponse,
  type IdempotentHit,
} from './idempotency.js';
import {
  listInstanceHistory,
  listInstances,
  type HistoryPage,
  type InstancePage,
} from './instances.js';
import {
  listVariables,
  patchVariables,
  revealVariable,
  type PatchOutcome,
  type RevealOutcome,
  type VariableView,
} from './variables.js';
import {
  advanceInstance,
  createAndStartInstance,
  getInstance,
  type AdvanceOutcome,
  type InstanceRow,
} from './advance.js';
import {
  listIncidents,
  listTimers,
  resolveIncident,
  retryIncident,
  type IncidentListItem,
  type IncidentResolveOutcome,
  type IncidentRetryOutcome,
  type TimerListItem,
} from './operate.js';
import {
  assignUserTask,
  claimUserTask,
  completeUserTask,
  getUserTask,
  listUserTasks,
  unclaimUserTask,
  type AssignOutcome,
  type ClaimOutcome,
  type CompleteTaskOutcome,
  type TaskViewer,
  type UnclaimOutcome,
  type UserTaskDetail,
  type UserTaskListItem,
} from './userTasks.js';
import {
  completeJob as completeJobRow,
  failJob as failJobRow,
  pauseJob as pauseJobRow,
  listJobs,
  lockJobs,
  type JobListItem,
  type JobRow,
} from './jobs.js';

export type JobOutcome =
  | { ok: true; instance: InstanceRow }
  | { ok: false; reason: 'notFound' | 'staleToken' | 'notLocked' | string; message: string };

export type FailOutcome =
  | { ok: true; status: 'available' | 'failed' }
  | { ok: false; reason: 'notFound' | 'staleToken' | 'notLocked'; message: string };

/**
 * Fachada do runtime consumida pela API e pelo worker — o HOST do engine
 * publicado. `clock` é injetável (testes determinísticos); produção usa o
 * relógio real (o `now` de todo evento vem DAQUI, nunca do kernel — D2).
 */
export interface PlatformRuntime {
  createAndStart(
    tenantId: string,
    options: { definitionRef?: string; businessKey?: string; variables?: Record<string, unknown> },
  ): Promise<AdvanceOutcome>;
  get(tenantId: string, instanceId: string): Promise<InstanceRow | undefined>;
  list(
    tenantId: string,
    options?: { cursor?: string; limit?: number; status?: string; definitionRef?: string; businessKey?: string },
  ): Promise<InstancePage>;
  history(
    tenantId: string,
    instanceId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<HistoryPage>;
  idempotency: {
    get(tenantId: string, key: string): Promise<IdempotentHit | undefined>;
    put(tenantId: string, key: string, requestHash: string, statusCode: number, response: unknown): Promise<void>;
  };
  operate: {
    timers(
      tenantId: string,
      options?: { cursor?: string; limit?: number; status?: string; instanceId?: string },
    ): Promise<{ items: TimerListItem[]; nextCursor: string | null }>;
    incidents(
      tenantId: string,
      options?: { cursor?: string; limit?: number; status?: string; kind?: string; instanceId?: string },
    ): Promise<{ items: IncidentListItem[]; nextCursor: string | null }>;
    retryIncident(tenantId: string, incidentId: string, actor: string): Promise<IncidentRetryOutcome>;
    resolveIncident(
      tenantId: string,
      incidentId: string,
      input: { reason: string; actor: string },
    ): Promise<IncidentResolveOutcome>;
  };
  userTasks: {
    list(
      tenantId: string,
      viewer: TaskViewer,
      options?: {
        cursor?: string;
        limit?: number;
        status?: string;
        instanceId?: string;
        filter?: 'mine' | 'role' | 'unassigned';
        includeGates?: boolean;
      },
    ): Promise<{ items: UserTaskListItem[]; nextCursor: string | null }>;
    get(tenantId: string, taskId: string, viewer: TaskViewer): Promise<UserTaskDetail | undefined>;
    claim(tenantId: string, taskId: string, user: string): Promise<ClaimOutcome>;
    unclaim(tenantId: string, taskId: string, user: string): Promise<UnclaimOutcome>;
    complete(
      tenantId: string,
      taskId: string,
      input: {
        claimToken: string;
        submission: Record<string, unknown>;
        user: string;
        decision?: string;
        expectedInstanceRevision?: number;
        requestId?: string;
      },
    ): Promise<CompleteTaskOutcome>;
    assign(
      tenantId: string,
      taskId: string,
      input: { assignee: string; reason: string; actor: string },
    ): Promise<AssignOutcome>;
  };
  jobs: {
    lock(
      tenantId: string,
      workerId: string,
      options?: { limit?: number; leaseMs?: number; types?: string[] },
    ): Promise<JobRow[]>;
    list(
      tenantId: string,
      options?: { cursor?: string; limit?: number; status?: string; type?: string; instanceId?: string },
    ): Promise<{ items: JobListItem[]; nextCursor: string | null }>;
  };
  variables: {
    list(tenantId: string, instanceId: string): Promise<VariableView[]>;
    reveal(
      tenantId: string,
      instanceId: string,
      name: string,
      context: { actor: string; reason: string },
    ): Promise<RevealOutcome>;
    patch(
      tenantId: string,
      instanceId: string,
      set: Record<string, unknown>,
      context: { actor: string },
    ): Promise<PatchOutcome>;
  };
  /** Motivo OBRIGATÓRIO (ADENDO-01 §2.3) — vai para history_events. */
  cancel(tenantId: string, instanceId: string, reason: string): Promise<AdvanceOutcome>;
  completeJob(
    tenantId: string,
    jobId: string,
    lockToken: string,
    now: string,
    result?: Record<string, unknown>,
  ): Promise<JobOutcome>;
  failJob(
    tenantId: string,
    jobId: string,
    lockToken: string,
    error: string,
    now: string,
  ): Promise<FailOutcome>;
  /** Parada honesta (§5): estaciona o job SEM incidente nem avanço da instância.
   * `pauseKind` (budget/kill-switch) discrimina a retomada (§5.2). */
  pauseJob(
    tenantId: string,
    jobId: string,
    lockToken: string,
    reason: string,
    pauseKind: string,
  ): Promise<PauseOutcome>;
  /** Retomada explícita (§5.2, budget) — o operador manda retomar. */
  resumeAgentJobs(
    tenantId: string,
    pauseKind: PauseKind,
    actor: AuditActor,
    motivo: string,
  ): Promise<ResumeResult>;
  /** Reproposta de gate (Q4) — ação explícita do operador, cap duro, fato na trilha. */
  reproposeGate(
    tenantId: string,
    instanceId: string,
    elementId: string,
    actor: AuditActor,
    motivo: string,
  ): Promise<ReproposeResult>;
}

export type PauseOutcome =
  | { ok: true; status: 'paused' }
  | { ok: false; reason: 'notFound' | 'staleToken' | 'notLocked'; message: string };

export function createRuntime(
  sql: Sql,
  clock: () => string = () => new Date().toISOString(),
  options: { keyProvider?: KeyProvider } = {},
): PlatformRuntime {
  // Costura LGPD (F2.6): com KeyProvider, campos `sensitive` persistem
  // cifrados (D20); sem ele, gravar um sensitive ABORTA (nunca plaintext).
  const cipher = options.keyProvider ? createFieldCipher(options.keyProvider) : undefined;
  return {
    createAndStart(tenantId, opts) {
      return createAndStartInstance(sql, tenantId, opts, clock(), cipher);
    },
    get(tenantId, instanceId) {
      return getInstance(sql, tenantId, instanceId);
    },
    list(tenantId, opts) {
      return listInstances(sql, tenantId, opts);
    },
    history(tenantId, instanceId, opts) {
      return listInstanceHistory(sql, tenantId, instanceId, opts);
    },
    idempotency: {
      get: (tenantId, key) => getIdempotentResponse(sql, tenantId, key),
      put: (tenantId, key, requestHash, statusCode, response) =>
        putIdempotentResponse(sql, tenantId, key, requestHash, statusCode, response),
    },
    operate: {
      timers: (tenantId, options) => listTimers(sql, tenantId, options),
      incidents: (tenantId, options) => listIncidents(sql, tenantId, options),
      retryIncident: (tenantId, incidentId, actor) => retryIncident(sql, tenantId, incidentId, actor),
      resolveIncident: (tenantId, incidentId, input) => resolveIncident(sql, tenantId, incidentId, input),
    },
    userTasks: {
      list: (tenantId, viewer, options) => listUserTasks(sql, tenantId, viewer, options),
      get: (tenantId, taskId, viewer) => getUserTask(sql, tenantId, taskId, viewer),
      claim: (tenantId, taskId, user) => claimUserTask(sql, tenantId, taskId, user),
      unclaim: (tenantId, taskId, user) => unclaimUserTask(sql, tenantId, taskId, user),
      complete: (tenantId, taskId, input) =>
        completeUserTask(sql, tenantId, taskId, { ...input, now: clock() }, cipher),
      assign: (tenantId, taskId, input) => assignUserTask(sql, tenantId, taskId, input),
    },
    jobs: {
      lock: (tenantId, workerId, options) => lockJobs(sql, tenantId, workerId, options),
      list: (tenantId, options) => listJobs(sql, tenantId, options),
    },
    variables: {
      list: (tenantId, instanceId) => listVariables(sql, tenantId, instanceId),
      reveal: (tenantId, instanceId, name, context) => {
        if (!cipher) {
          throw new Error('reveal de sensitive exige KeyProvider configurado (D20)');
        }
        return revealVariable(sql, tenantId, instanceId, name, { ...context, cipher });
      },
      patch: (tenantId, instanceId, set, context) =>
        patchVariables(sql, tenantId, instanceId, set, { ...context, cipher }),
    },
    cancel(tenantId, instanceId, reason) {
      // O engine emite CancelJob/CancelTimer/CloseUserTask para TODAS as
      // esperas abertas — o dispatcher fecha job/timer/task (aceite F2:
      // cancelamento fecha esperas).
      return advanceInstance(
        sql,
        tenantId,
        instanceId,
        { type: 'CancelInstance', now: clock(), variables: {}, reason },
        { cipher },
      );
    },
    async completeJob(tenantId, jobId, lockToken, now, result) {
      const conclusion = await completeJobRow(sql, tenantId, jobId, lockToken);
      if (!conclusion.ok) {
        return {
          ok: false,
          reason: conclusion.reason,
          message:
            conclusion.reason === 'staleToken'
              ? 'lock_token não é o vigente (lease reassumida por outro worker)'
              : conclusion.reason === 'notLocked'
                ? 'job não está locked (já concluído ou devolvido à fila)'
                : 'job não encontrado',
        };
      }
      const advanced = await advanceInstance(
        sql,
        tenantId,
        conclusion.job.instance_id,
        {
          type: 'JobCompleted',
          now,
          waitKey: conclusion.job.wait_key,
          variables: {},
          ...(result !== undefined ? { result } : {}),
        },
        { cipher },
      );
      if (!advanced.ok) return { ok: false, reason: advanced.reason, message: advanced.message };
      return { ok: true, instance: advanced.instance };
    },
    async failJob(tenantId, jobId, lockToken, error, now) {
      const conclusion = await failJobRow(sql, tenantId, jobId, lockToken, error);
      if (!conclusion.ok) {
        return {
          ok: false,
          reason: conclusion.reason,
          message: conclusion.reason === 'notFound' ? 'job não encontrado' : 'lock_token não é o vigente',
        };
      }
      if (conclusion.job.status === 'failed') {
        // Retries esgotados: o engine registra o incidente OPERACIONAL
        // (instância segue ativa; retry do operador re-dispara pela fila).
        await advanceInstance(
          sql,
          tenantId,
          conclusion.job.instance_id,
          { type: 'JobFailed', now, waitKey: conclusion.job.wait_key, variables: {}, error },
          { cipher },
        );
        return { ok: true, status: 'failed' };
      }
      return { ok: true, status: 'available' };
    },
    async pauseJob(tenantId, jobId, lockToken, reason, pauseKind) {
      // Parada honesta: estaciona o job. SEM advanceInstance (a instância NÃO
      // avança do agentTask — segue ativa, pausada), SEM incidente. O fato
      // agent:parada já foi gravado pelo worker; aqui só solta o job da fila.
      const conclusion = await pauseJobRow(sql, tenantId, jobId, lockToken, reason, pauseKind);
      if (!conclusion.ok) {
        return {
          ok: false,
          reason: conclusion.reason,
          message: conclusion.reason === 'notFound' ? 'job não encontrado' : 'lock_token não é o vigente',
        };
      }
      return { ok: true, status: 'paused' };
    },
    async resumeAgentJobs(tenantId, pauseKind, actor, motivo) {
      return resumeAgentJobsRow(sql, tenantId, pauseKind, actor, motivo);
    },
    async reproposeGate(tenantId, instanceId, elementId, actor, motivo) {
      return reproposeGateRow(sql, tenantId, instanceId, elementId, actor, motivo);
    },
  };
}
