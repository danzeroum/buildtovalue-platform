import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFormDefinition, deployProcessDefinition } from '../src/registry/store.js';
import { createRuntime } from '../src/runtime/facade.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-25T09:00:00.000Z';

/**
 * AG-3.3 ponto 3 (correção de dados, antes da timeline UI): claim/unclaim de
 * user task NÃO deixavam NENHUM rastro em `history_events` — nem string, nem
 * envelope. A "timeline unificada humano+agente" (assinatura da AG-3) não
 * podia mostrar quem reivindicou/desistiu de uma tarefa. Prova aqui que os
 * dois eventos novos (`taskClaimed`/`taskUnclaimed`) gravam o MESMO envelope
 * {type,id,requestId} dos fatos de agente, consultável pela mesma projeção
 * `payload->'actor'->>'type'`.
 */
function plainDiagram(): BpmnDiagram {
  const d = createDiagram({ name: 'Plain' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
  const review = createNode({ id: 'review', type: 'userTask', label: 'review', x: 200, y: 0 });
  review.properties.formRef = 'df@1';
  d.nodes.review = review;
  d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'e', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'end' });
  return d;
}

const dfForm: FormSchema = {
  formId: 'df',
  version: 1,
  title: 'Form',
  fields: [{ key: 'obs', type: 'text', label: 'Obs', dataClassification: 'internal' }],
} as unknown as FormSchema;

describe('AG-3.3 ponto 3 — claim/unclaim gravam ator no MESMO formato dos fatos de agente', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('human_actor_trail');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('hat', 'HumanActorTrail') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployFormDefinition(api, tenant, { formId: 'df', schema: dfForm });
    await deployProcessDefinition(api, tenant, { name: 'plain', diagram: plainDiagram(), engineVersion: 'test' });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  const runtime = () => createRuntime(api, NOW);

  async function drain(): Promise<void> {
    for (;;) {
      const r = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) return;
    }
  }

  async function startAndOpen(): Promise<{ instanceId: string; taskId: string }> {
    const started = await runtime().createAndStart(tenant, {
      definitionRef: 'plain@1',
      businessKey: `plain-${Math.random()}`.slice(0, 40),
    });
    if (!started.ok) throw new Error('start falhou');
    await drain(); // OpenUserTask só materializa a linha após o dispatch do outbox
    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${started.instance.id} AND status = 'open'`);
    return { instanceId: started.instance.id, taskId: task.id as string };
  }

  it('claim: ANTES não deixava rastro nenhum — agora grava taskClaimed com envelope', async () => {
    const { instanceId, taskId } = await startAndOpen();
    const claim = await runtime().userTasks.claim(tenant, taskId, 'diana', 'req-claim-1');
    expect(claim.ok).toBe(true);

    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskClaimed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      elementId: 'review',
      actor: { type: 'user', id: 'diana', requestId: 'req-claim-1' },
    });
    const [byProjection] = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload->'actor'->>'type' AS actor_type FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'taskClaimed'`);
    expect(byProjection.actor_type).toBe('user');
  });

  it('re-claim do MESMO usuário (rotação de token): grava outra linha taskClaimed', async () => {
    const { instanceId, taskId } = await startAndOpen();
    await runtime().userTasks.claim(tenant, taskId, 'diana', 'req-1');
    await runtime().userTasks.claim(tenant, taskId, 'diana', 'req-2');
    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskClaimed' ORDER BY seq`);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.payload as { actor: { requestId: string } }).actor.requestId)).toEqual(['req-1', 'req-2']);
  });

  it('unclaim: ANTES não deixava rastro nenhum — agora grava taskUnclaimed com envelope', async () => {
    const { instanceId, taskId } = await startAndOpen();
    const claim = await runtime().userTasks.claim(tenant, taskId, 'eduardo', 'req-claim');
    if (!claim.ok) throw new Error('claim falhou');
    const unclaim = await runtime().userTasks.unclaim(tenant, taskId, 'eduardo', 'req-unclaim');
    expect(unclaim.ok).toBe(true);

    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskUnclaimed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      elementId: 'review',
      actor: { type: 'user', id: 'eduardo', requestId: 'req-unclaim' },
    });
  });

  it('unclaim recusado (não é o dono do claim) → NENHUM taskUnclaimed gravado (nunca finge)', async () => {
    const { instanceId, taskId } = await startAndOpen();
    const claim = await runtime().userTasks.claim(tenant, taskId, 'fernanda', 'req-claim');
    if (!claim.ok) throw new Error('claim falhou');
    const outcome = await runtime().userTasks.unclaim(tenant, taskId, 'outro-usuario', 'req-x');
    expect(outcome).toMatchObject({ ok: false, reason: 'notOwner' });
    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskUnclaimed'`);
    expect(rows).toHaveLength(0);
  });
});
