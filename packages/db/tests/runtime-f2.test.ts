import type { InstanceState } from '@buildtovalue/engine';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  advanceInstance,
  runStateMigrations,
  type StateMigration,
} from '../src/runtime/advance.js';
import { EXAMPLE_DEFINITION_REF, conditionEvaluator } from '../src/runtime/definitions.js';
import { effectKey } from '../src/runtime/effectKey.js';
import { createRuntime } from '../src/runtime/facade.js';
import { lockJobs } from '../src/runtime/jobs.js';
import {
  dispatchOutboxOnce,
  historySeq,
  insertEffects,
  outboxDepth,
  OUTBOX_CHANNEL,
} from '../src/runtime/outbox.js';
import { sweepDueTimersOnce } from '../src/runtime/timers.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-22T12:00:00.000Z';

/**
 * F2.1 — runtime completo (migração 0003): dispatcher aplicando o catálogo
 * inteiro de efeitos do ADR-0001, história com seq monotônico + effect_key
 * (G-DAD-2), StateMigrator encadeado ("antiga demais" → incidente), varredura
 * de timers e o processo exemplo do aceite (user task + service task + timer
 * boundary + XOR) fim-a-fim nas três rotas.
 */
describe('runtime F2 — efeitos, história, timers e migrador (migração 0003)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  async function seedInstance(stateSchemaVersion = 1, state: object = {}): Promise<string> {
    return withTenant(api, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version,
          state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'test', ${stateSchemaVersion},
          ${tx.json(state as never)}, 'active')
        RETURNING id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('runtime_f2');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`
      INSERT INTO tenants (slug, name) VALUES ('f2', 'F2') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  // -------------------------------------------------------------------------
  it('dispatcher aplica o catálogo F2: timer, user task, história e incidente', async () => {
    const instance = await seedInstance();
    const meta = { revision: 1, engineVersion: 'eng-test' };
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 1, 0, 'EmitHistory'),
          effect: { type: 'EmitHistory', kind: 'instanceStarted', payload: { elementId: 'start' } },
          index: 0,
        },
        {
          effectKey: effectKey(instance, 1, 1, 'ScheduleTimer'),
          effect: { type: 'ScheduleTimer', waitKey: `bt:${instance}`, elementId: 'bt', fireAt: '2027-01-01T00:00:00.000Z' },
          index: 1,
        },
        {
          effectKey: effectKey(instance, 1, 2, 'OpenUserTask'),
          effect: { type: 'OpenUserTask', waitKey: `u:${instance}`, elementId: 'u', formRef: 'f@1', candidates: ['operator'] },
          index: 2,
        },
        {
          effectKey: effectKey(instance, 1, 3, 'RaiseIncident'),
          effect: { type: 'RaiseIncident', kind: 'unsupportedElement', message: 'x' },
          index: 3,
        },
      ], meta),
    );
    const result = await dispatchOutboxOnce(api, tenant, { batch: 10 });
    expect(result.processed).toBe(4);
    expect(await outboxDepth(api, tenant)).toBe(0);

    const [timer] = await withTenant(api, tenant, (tx) => tx`SELECT * FROM timers WHERE instance_id = ${instance}`);
    expect(timer).toMatchObject({ status: 'armed', element_id: 'bt' });
    const [task] = await withTenant(api, tenant, (tx) => tx`SELECT * FROM user_tasks WHERE instance_id = ${instance}`);
    expect(task).toMatchObject({ status: 'open', form_ref: 'f@1', candidate_roles: ['operator'] });
    const [hist] = await withTenant(api, tenant, (tx) => tx`SELECT * FROM history_events WHERE instance_id = ${instance}`);
    expect(hist).toMatchObject({ kind: 'instanceStarted', engine_version: 'eng-test' });
    expect(Number(hist.seq)).toBe(historySeq(1, 0));
    const [incident] = await withTenant(api, tenant, (tx) => tx`SELECT * FROM incidents WHERE instance_id = ${instance}`);
    expect(incident).toMatchObject({ kind: 'unsupportedElement', status: 'open' });
  });

  it('crash no meio do lote → re-dispatch SEM duplicar história/incidente (seq determinístico)', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 2, 0, 'EmitHistory'),
          effect: { type: 'EmitHistory', kind: 'flowRouted', payload: { edgeId: 'e3' } },
          index: 0,
        },
        {
          effectKey: effectKey(instance, 2, 1, 'RaiseIncident'),
          effect: { type: 'RaiseIncident', kind: 'k', message: 'm' },
          index: 1,
        },
      ], { revision: 2, engineVersion: 'eng-test' }),
    );
    // worker morre DEPOIS de aplicar a história, ANTES de commitar o lote
    await expect(
      dispatchOutboxOnce(api, tenant, {
        batch: 10,
        onCrash: (_row, index) => {
          if (index === 1) throw new Error('kill -9');
        },
      }),
    ).rejects.toThrow('kill -9');
    expect(await outboxDepth(api, tenant)).toBe(2); // rollback total

    await dispatchOutboxOnce(api, tenant, { batch: 10 });
    const hist = await withTenant(api, tenant, (tx) => tx`SELECT seq FROM history_events WHERE instance_id = ${instance}`);
    expect(hist).toHaveLength(1); // exatamente uma linha, mesmo seq
    expect(Number(hist[0].seq)).toBe(historySeq(2, 0));
    const incidents = await withTenant(api, tenant, (tx) => tx`SELECT id FROM incidents WHERE instance_id = ${instance}`);
    expect(incidents).toHaveLength(1);
  });

  it('CancelTimer/CancelJob/CloseUserTask fecham as esperas correspondentes', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        { effectKey: effectKey(instance, 3, 0, 'ScheduleTimer'), effect: { type: 'ScheduleTimer', waitKey: `t2:${instance}`, elementId: 't2', fireAt: '2026-07-23T00:00:00.000Z' }, index: 0 },
        { effectKey: effectKey(instance, 3, 1, 'CreateJob'), effect: { type: 'CreateJob', waitKey: `j2:${instance}`, jobType: 'noop', payload: {} }, index: 1 },
        { effectKey: effectKey(instance, 3, 2, 'OpenUserTask'), effect: { type: 'OpenUserTask', waitKey: `u2:${instance}`, elementId: 'u2', formRef: 'f@1', candidates: [] }, index: 2 },
      ], { revision: 3, engineVersion: 'eng-test' }),
    );
    await dispatchOutboxOnce(api, tenant, { batch: 10 });
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        { effectKey: effectKey(instance, 4, 0, 'CancelTimer'), effect: { type: 'CancelTimer', waitKey: `t2:${instance}` }, index: 0 },
        { effectKey: effectKey(instance, 4, 1, 'CancelJob'), effect: { type: 'CancelJob', waitKey: `j2:${instance}` }, index: 1 },
        { effectKey: effectKey(instance, 4, 2, 'CloseUserTask'), effect: { type: 'CloseUserTask', waitKey: `u2:${instance}` }, index: 2 },
      ], { revision: 4, engineVersion: 'eng-test' }),
    );
    await dispatchOutboxOnce(api, tenant, { batch: 10 });

    const [timer] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM timers WHERE wait_key = ${`t2:${instance}`}`);
    expect(timer.status).toBe('cancelled');
    const [job] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM jobs WHERE wait_key = ${`j2:${instance}`}`);
    expect(job.status).toBe('cancelled');
    const [task] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM user_tasks WHERE wait_key = ${`u2:${instance}`}`);
    expect(task.status).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  describe('StateMigrator (D14) — encadeado, tooOld → incidente, tooNew → abort', () => {
    const base = (version: number): InstanceState => ({
      stateSchemaVersion: version,
      engineVersion: 'e',
      definitionRef: { registryRef: 'r', bpmnVersion: '1' },
      tokens: [],
      waits: [],
      joinArrivals: {},
      sequence: 0,
      status: 'active',
    });

    it('encadeia migrações puras até o formato vigente', () => {
      const migrations = new Map<number, StateMigration>([
        [0, (s) => ({ ...s, stateSchemaVersion: 1 })],
        [1, (s) => ({ ...s, stateSchemaVersion: 2, sequence: s.sequence + 100 })],
      ]);
      const outcome = runStateMigrations(base(0), migrations, 2);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.state.stateSchemaVersion).toBe(2);
        expect(outcome.state.sequence).toBe(100);
      }
    });

    it('sem cadeia a partir da versão gravada = tooOld; acima do vigente = tooNew', () => {
      const semCadeia = runStateMigrations(base(0), new Map(), 1);
      expect(semCadeia).toMatchObject({ ok: false, kind: 'tooOld' });
      const doFuturo = runStateMigrations(base(3), new Map(), 1);
      expect(doFuturo).toMatchObject({ ok: false, kind: 'tooNew' });
    });

    it('integração: state_schema_version antiga demais → instância em INCIDENTE (dedupe)', async () => {
      const instance = await seedInstance(0, { ...baseState(), stateSchemaVersion: 0 });
      const outcome = await advanceInstance(api, tenant, instance, {
        type: 'CancelInstance', now: NOW(), variables: {},
      });
      expect(outcome).toMatchObject({ ok: false, reason: 'stateTooOld' });
      const [row] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM instances WHERE id = ${instance}`);
      expect(row.status).toBe('incident');
      const incidents = await withTenant(api, tenant, (tx) =>
        tx`SELECT kind FROM incidents WHERE instance_id = ${instance}`);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].kind).toBe('stateSchemaTooOld');

      // re-tentativa NÃO duplica o incidente (chave host: determinística)
      await advanceInstance(api, tenant, instance, { type: 'CancelInstance', now: NOW(), variables: {} });
      const again = await withTenant(api, tenant, (tx) =>
        tx`SELECT id FROM incidents WHERE instance_id = ${instance}`);
      expect(again).toHaveLength(1);
    });

    it('integração: state_schema_version do FUTURO aborta (defeito de deploy, nunca incidente)', async () => {
      const instance = await seedInstance(99, { ...baseState(), stateSchemaVersion: 99 });
      await expect(
        advanceInstance(api, tenant, instance, { type: 'CancelInstance', now: NOW(), variables: {} }),
      ).rejects.toThrow(/desatualizado/);
      const [row] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM instances WHERE id = ${instance}`);
      expect(row.status).toBe('active'); // tx abortada: nada mudou
    });

    function baseState(): InstanceState {
      return {
        stateSchemaVersion: 1,
        engineVersion: 'e',
        definitionRef: { registryRef: 'skeleton@1', bpmnVersion: '1' },
        tokens: [],
        waits: [],
        joinArrivals: {},
        sequence: 0,
        status: 'active',
      };
    }
  });

  // -------------------------------------------------------------------------
  describe('processo exemplo example@1 (aceite F2) — fim-a-fim pelas 3 rotas', () => {
    it('rota aprovada: task → submission roteia o XOR → job http-call → completed', async () => {
      const runtime = createRuntime(api, NOW);
      const started = await runtime.createAndStart(tenant, {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'ex-aprovada',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const id = started.instance.id;

      await drainOutbox();
      const [task] = await withTenant(api, tenant, (tx) =>
        tx`SELECT wait_key, status, form_ref FROM user_tasks WHERE instance_id = ${id}`);
      expect(task).toMatchObject({ status: 'open', form_ref: 'review@1' });
      const [timer] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status, fire_at FROM timers WHERE instance_id = ${id}`);
      expect(timer.status).toBe('armed');
      // fireAt determinístico: now + PT1H
      expect(new Date(timer.fire_at as string).toISOString()).toBe('2026-07-22T13:00:00.000Z');

      // usuário conclui a task com approved=true — o XOR decide NO MESMO avanço
      const done = await advanceInstance(api, tenant, id, {
        type: 'UserTaskCompleted', now: NOW(), waitKey: task.wait_key as string,
        variables: {}, submission: { approved: true },
      });
      expect(done.ok).toBe(true);
      await drainOutbox();

      // boundary cancelado; task não é fechada de novo (concluída pelo usuário na F3)
      const [timerAfter] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM timers WHERE instance_id = ${id}`);
      expect(timerAfter.status).toBe('cancelled');

      // job http-call criado; conclui com result → variável persistida (D13)
      const [job] = await lockJobs(api, tenant, 'w1', { limit: 10 });
      expect(job.type).toBe('http-call');
      const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW(), { notified: true });
      expect(completed.ok).toBe(true);
      await drainOutbox();

      const [finalRow] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM instances WHERE id = ${id}`);
      expect(finalRow.status).toBe('completed');
      const vars = await withTenant(api, tenant, (tx) =>
        tx`SELECT name, value FROM variables WHERE instance_id = ${id} ORDER BY name`);
      expect(vars.map((v) => v.name)).toEqual(['approved', 'notified']);

      // história: seq estritamente crescente por instância (G-DAD-2)
      const hist = await withTenant(api, tenant, (tx) =>
        tx`SELECT seq, kind FROM history_events WHERE instance_id = ${id} ORDER BY seq`);
      const seqs = hist.map((h) => Number(h.seq));
      expect(seqs.length).toBeGreaterThanOrEqual(3); // started, flowRouted, completed
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(hist.map((h) => h.kind)).toContain('instanceCompleted');
    });

    it('rota timeout: varredura dispara o boundary → task some, job send-email, completed', async () => {
      const runtime = createRuntime(api, NOW);
      const started = await runtime.createAndStart(tenant, {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'ex-timeout',
      });
      if (!started.ok) throw new Error('start falhou');
      const id = started.instance.id;
      await drainOutbox();

      // ainda não venceu (fire_at = 13:00): varredura às 12:00 não dispara
      const before = await sweepDueTimersOnce(api, tenant, { now: NOW });
      expect(before.fired).toBe(0);

      // o tempo passa: o relógio INJETADO cruza o fire_at (D2 — nada de
      // relógio do banco; o mesmo instante decide vencimento e carimba o evento)
      const swept = await sweepDueTimersOnce(api, tenant, { now: () => '2026-07-22T13:00:01.000Z' });
      expect(swept.fired).toBe(1);
      await drainOutbox();

      // boundary interruptivo: a task SOME da Tasklist (aceite F2)
      const [task] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM user_tasks WHERE instance_id = ${id}`);
      expect(task.status).toBe('cancelled');
      const [timer] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM timers WHERE instance_id = ${id}`);
      expect(timer.status).toBe('fired');

      // varredura de novo NÃO re-dispara (exatamente-uma-vez)
      const again = await sweepDueTimersOnce(api, tenant, { now: () => '2026-07-22T13:00:02.000Z' });
      expect(again.due).toBe(0);

      const [job] = await lockJobs(api, tenant, 'w2', { limit: 10 });
      expect(job.type).toBe('send-email');
      const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW());
      expect(completed.ok).toBe(true);
      const [finalRow] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM instances WHERE id = ${id}`);
      expect(finalRow.status).toBe('completed');
    });

    it('cancelamento fecha TODAS as esperas: task some e timer não dispara (aceite F2)', async () => {
      const runtime = createRuntime(api, NOW);
      const started = await runtime.createAndStart(tenant, {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'ex-cancel',
      });
      if (!started.ok) throw new Error('start falhou');
      const id = started.instance.id;
      await drainOutbox();

      const cancelled = await runtime.cancel(tenant, id, 'pedido do operador');
      expect(cancelled.ok).toBe(true);
      await drainOutbox();

      const [row] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM instances WHERE id = ${id}`);
      expect(row.status).toBe('cancelled');
      const [task] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM user_tasks WHERE instance_id = ${id}`);
      expect(task.status).toBe('cancelled');
      const [timer] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM timers WHERE instance_id = ${id}`);
      expect(timer.status).toBe('cancelled');

      // mesmo com o relógio além do fire_at, timer cancelado NÃO dispara
      const swept = await sweepDueTimersOnce(api, tenant, { now: () => '2026-07-22T14:00:00.000Z' });
      expect(swept.due).toBe(0);
    });

    it('rota rejeitada: submission sem approved cai no default do XOR', async () => {
      const runtime = createRuntime(api, NOW);
      const started = await runtime.createAndStart(tenant, {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'ex-rejeitada',
      });
      if (!started.ok) throw new Error('start falhou');
      const id = started.instance.id;
      await drainOutbox();
      const [task] = await withTenant(api, tenant, (tx) =>
        tx`SELECT wait_key FROM user_tasks WHERE instance_id = ${id} AND status = 'open'`);
      const done = await advanceInstance(api, tenant, id, {
        type: 'UserTaskCompleted', now: NOW(), waitKey: task.wait_key as string,
        variables: {}, submission: { approved: false },
      });
      expect(done.ok).toBe(true);
      await drainOutbox();
      const [row] = await withTenant(api, tenant, (tx) =>
        tx`SELECT status FROM instances WHERE id = ${id}`);
      expect(row.status).toBe('completed'); // endRejected, sem job http-call
      const jobs = await withTenant(api, tenant, (tx) =>
        tx`SELECT id FROM jobs WHERE instance_id = ${id}`);
      expect(jobs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  it('efeito defeituoso: SAVEPOINT isola a linha, backoff, e dead-letter → incidents (F2.2)', async () => {
    const instance = await seedInstance();
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          // CreateJob SEM waitKey: viola NOT NULL ao aplicar — defeito de
          // dado, não crash do worker.
          effectKey: effectKey(instance, 9, 0, 'CreateJob'),
          effect: { type: 'CreateJob', jobType: 'noop' },
          index: 0,
        },
        {
          effectKey: effectKey(instance, 9, 1, 'EmitHistory'),
          effect: { type: 'EmitHistory', kind: 'ok', payload: {} },
          index: 1,
        },
      ], { revision: 9, engineVersion: 'eng-test' }),
    );
    const first = await dispatchOutboxOnce(api, tenant, { batch: 10, maxAttempts: 2 });
    // a linha boa do MESMO lote passa; a defeituosa ganha backoff
    expect(first).toMatchObject({ processed: 1, failed: 1, deadLettered: 0 });
    expect(await outboxDepth(api, tenant)).toBe(1);
    const hist = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind FROM history_events WHERE instance_id = ${instance}`);
    expect(hist.map((h) => h.kind)).toEqual(['ok']);

    // com backoff, a linha NÃO é re-tentada antes do next_attempt_at…
    const tooSoon = await dispatchOutboxOnce(api, tenant, { batch: 10, maxAttempts: 2 });
    expect(tooSoon).toMatchObject({ processed: 0, failed: 0, deadLettered: 0 });
    // …o teste vence o backoff manualmente e a 2ª tentativa dead-lettera
    await withTenant(api, tenant, (tx) =>
      tx`UPDATE outbox SET next_attempt_at = now() WHERE instance_id = ${instance}`);
    const second = await dispatchOutboxOnce(api, tenant, { batch: 10, maxAttempts: 2 });
    expect(second).toMatchObject({ processed: 0, failed: 0, deadLettered: 1 });
    expect(await outboxDepth(api, tenant)).toBe(0); // saiu da fila
    const incidents = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, message FROM incidents WHERE instance_id = ${instance}`);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe('effectDispatchFailed');
    expect(incidents[0].message).toContain('CreateJob');
  });

  it('avanço com efeitos emite pg_notify no COMMIT (canal da outbox, payload = tenant)', async () => {
    const runtime = createRuntime(api, NOW);
    const notified: string[] = [];
    const listener = postgres(db.apiUrl, { max: 1, onnotice: () => {} });
    await listener.listen(OUTBOX_CHANNEL, (payload) => {
      notified.push(payload);
    });
    try {
      const started = await runtime.createAndStart(tenant, { businessKey: 'notify-1' });
      expect(started.ok).toBe(true);
      await vi.waitFor(() => {
        expect(notified).toContain(tenant);
      }, { timeout: 5_000 });
    } finally {
      await listener.end({ timeout: 5 });
    }
  });

  it('avaliador de condição v1: igualdade de literais; fora disso, erro explícito', () => {
    expect(conditionEvaluator.evaluate('approved = true', { approved: true })).toEqual({ value: true });
    expect(conditionEvaluator.evaluate('valor = 42', { valor: 42 })).toEqual({ value: true });
    expect(conditionEvaluator.evaluate('nome = "ana"', { nome: 'ana' })).toEqual({ value: true });
    expect(conditionEvaluator.evaluate('approved = true', {})).toEqual({ value: false });
    expect(conditionEvaluator.evaluate('valor > 100', { valor: 200 })).toMatchObject({
      error: expect.stringContaining('não suportada'),
    });
  });

  async function drainOutbox(): Promise<void> {
    for (;;) {
      const result = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (result.processed === 0) return;
    }
  }
});
