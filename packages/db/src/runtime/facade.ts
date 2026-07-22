import type { Sql } from '../client.js';
import { createFieldCipher, type KeyProvider } from '../crypto/fieldCipher.js';
import {
  advanceInstance,
  createAndStartInstance,
  getInstance,
  type AdvanceOutcome,
  type InstanceRow,
} from './advance.js';
import { completeJob as completeJobRow, failJob as failJobRow } from './jobs.js';

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
  cancel(tenantId: string, instanceId: string, reason?: string): Promise<AdvanceOutcome>;
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
}

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
    cancel(tenantId, instanceId, reason) {
      // O engine emite CancelJob/CancelTimer/CloseUserTask para TODAS as
      // esperas abertas — o dispatcher fecha job/timer/task (aceite F2:
      // cancelamento fecha esperas).
      return advanceInstance(
        sql,
        tenantId,
        instanceId,
        {
          type: 'CancelInstance',
          now: clock(),
          variables: {},
          ...(reason !== undefined ? { reason } : {}),
        },
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
  };
}
