import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFormDefinition, deployProcessDefinition } from '../src/registry/store.js';
import { createRuntime } from '../src/runtime/facade.js';
import { listUserTasks } from '../src/runtime/userTasks.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createEnvKeyProvider } from '../src/crypto/fieldCipher.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-28T12:00:00.000Z';

const form: FormSchema = {
  formId: 'lf',
  version: 1,
  title: 'Rótulo',
  fields: [{ key: 'obs', type: 'text', label: 'Obs', dataClassification: 'internal' }],
} as unknown as FormSchema;

/** start → userTask(id, label) → end. `label: undefined` = elemento sem nome. */
function diagram(name: string, taskId: string, label: string | undefined): BpmnDiagram {
  const d = createDiagram({ name });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'Início', x: 0, y: 0 });
  const t = createNode({ id: taskId, type: 'userTask', label: label ?? '', x: 200, y: 0 });
  t.properties.formRef = 'lf@1';
  t.properties.candidateRoles = ['business'];
  d.nodes[taskId] = t;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'Fim', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: taskId });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: taskId, targetId: 'fim' });
  return d;
}

/**
 * Integração da 0022: o rótulo humano é PINADO na criação da tarefa, contra a
 * definição pinada da instância — o mesmo caminho do `form_ref` e do `is_gate`.
 * O que se prova aqui é a GRAVAÇÃO (o que fica na trilha para sempre), não a
 * renderização — essa é de `apps/console/tests/tasks-label.test.tsx`.
 */
describe('user_tasks.element_label — pinado na criação (0022)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('user_task_label');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('lb', 'Label') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployFormDefinition(api, tenant, { formId: 'lf', schema: form });
    for (const [nome, id, label] of [
      ['rotulada', 't1', 'Etapa 1'],
      ['sem-rotulo', 't2', undefined],
      ['hostil', 'xss', '<script>alert("xss")</script>'],
    ] as const) {
      const out = await deployProcessDefinition(api, tenant, {
        name: nome,
        diagram: diagram(nome, id, label),
        engineVersion: 'test',
      });
      if (!out.ok) throw new Error(`deploy ${nome} rejeitado: ${JSON.stringify(out.issues)}`);
    }
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  const runtime = () => createRuntime(api, NOW, { keyProvider: createEnvKeyProvider('seg-rotulo-teste-ok') });

  async function drain(): Promise<void> {
    for (;;) {
      const r = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) return;
    }
  }

  async function startAndRead(ref: string): Promise<{ element_id: string; element_label: string | null }> {
    const started = await runtime().createAndStart(tenant, { definitionRef: ref, businessKey: `${ref}-bk` });
    if (!started.ok) throw new Error('start falhou');
    await drain();
    const [row] = await withTenant(api, tenant, (tx) =>
      tx`SELECT element_id, element_label FROM user_tasks WHERE instance_id = ${started.instance.id}`);
    return row as unknown as { element_id: string; element_label: string | null };
  }

  it('elemento com nome → element_label gravado verbatim', async () => {
    const row = await startAndRead('rotulada@1');
    expect(row.element_id).toBe('t1');
    expect(row.element_label).toBe('Etapa 1');
  });

  it('elemento sem nome → element_label NULL (nunca string vazia)', async () => {
    const row = await startAndRead('sem-rotulo@1');
    expect(row.element_id).toBe('t2');
    expect(row.element_label).toBeNull();
  });

  it('rótulo hostil é gravado COMO ESTÁ — a trilha diz o nome real do elemento', async () => {
    const row = await startAndRead('hostil@1');
    expect(row.element_label).toBe('<script>alert("xss")</script>');
  });

  it('a projeção da lista devolve o rótulo junto do id', async () => {
    const page = await listUserTasks(api, tenant, { sub: 'ana', role: 'business', seesAll: false });
    const porId = new Map(page.items.map((i) => [i.element_id, i.element_label]));
    expect(porId.get('t1')).toBe('Etapa 1');
    expect(porId.get('t2')).toBeNull();
    expect(porId.get('xss')).toBe('<script>alert("xss")</script>');
  });

  it('tarefa criada ANTES da migração continua listada, com rótulo nulo', async () => {
    // Simula a linha legada: a coluna existe mas nunca foi preenchida. É o que
    // acontece de fato com as tarefas que já rodaram na VPS — sem backfill,
    // porque inventar rótulo retroativo seria fabricar evidência.
    const started = await runtime().createAndStart(tenant, {
      definitionRef: 'rotulada@1',
      businessKey: 'legada-bk',
    });
    if (!started.ok) throw new Error('start falhou');
    await drain();
    await withTenant(api, tenant, (tx) =>
      tx`UPDATE user_tasks SET element_label = NULL WHERE instance_id = ${started.instance.id}`);
    const page = await listUserTasks(api, tenant, { sub: 'ana', role: 'business', seesAll: false });
    const legada = page.items.find((i) => i.instance_id === started.instance.id);
    expect(legada).toBeDefined();
    expect(legada!.element_label).toBeNull();
    expect(legada!.element_id).toBe('t1');
  });
});
