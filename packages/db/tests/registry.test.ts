import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintBlocks, lintDiagram } from '../src/registry/lint.js';
import {
  classificationsForRef,
  deployFormDefinition,
  deployProcessDefinition,
  engineForRef,
  getFormDefinitionByRef,
  listProcessDefinitions,
  listStartableDefinitions,
} from '../src/registry/store.js';
import { createRuntime } from '../src/runtime/facade.js';
import { advanceInstance } from '../src/runtime/advance.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-22T18:00:00.000Z';

/** Diagrama base VÁLIDO: start → review(userTask form@1) → decisão → fim. */
function validDiagram(mutate?: (d: BpmnDiagram) => void): BpmnDiagram {
  const d = createDiagram({ name: 'Aprovação' });
  const node = (id: string, type: string, x: number) => {
    d.nodes[id] = createNode({ id, type, label: id, x, y: 0 });
    return d.nodes[id];
  };
  node('start', 'startEvent', 0);
  const review = node('review', 'userTask', 200);
  review.properties.formRef = 'aprova@1';
  const notify = node('notify', 'serviceTask', 400);
  notify.properties.jobType = 'noop';
  node('end', 'endEvent', 600);
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'notify' });
  d.edges.e3 = createEdge({ id: 'e3', sourceId: 'notify', targetId: 'end' });
  mutate?.(d);
  return d;
}

// schema conforme F0b.5: formId/version próprios (o registry re-carimba a
// versão atribuída); classificação no QUARTETO dos forms.
const validForm: FormSchema = {
  formId: 'aprova',
  version: 1,
  title: 'Aprovação',
  fields: [
    { key: 'approved', type: 'checkbox', label: 'Aprovado?', dataClassification: 'internal' },
    { key: 'cpf', type: 'text', label: 'CPF', dataClassification: 'sensitive' },
  ],
} as unknown as FormSchema;

describe('lint D19 (shape §2 — severidades da pré-triagem)', () => {
  it('diagrama válido: zero issues', () => {
    expect(lintDiagram(validDiagram())).toEqual([]);
  });

  it('issue #2: boundary sobre atividade que NÃO espera = EXEC_BOUNDARY_HOST_NOT_WAITING (error)', () => {
    // caso 1 da issue: boundary sobre task instantânea
    const overTask = validDiagram((d) => {
      d.nodes.instant = createNode({ id: 'instant', type: 'task', label: 'x', x: 300, y: 100 });
      d.edges.ei = createEdge({ id: 'ei', sourceId: 'start', targetId: 'instant' });
      d.edges.eo = createEdge({ id: 'eo', sourceId: 'instant', targetId: 'end' });
      const bt = createNode({ id: 'bt', type: 'boundaryEvent', label: 'bt', x: 320, y: 120 });
      bt.properties.attachedToRef = 'instant';
      bt.properties.eventDefinition = 'timer';
      bt.properties.timer = { kind: 'duration', expression: 'PT1H' };
      d.nodes.bt = bt;
    });
    const issues = lintDiagram(overTask);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_BOUNDARY_HOST_NOT_WAITING', severity: 'error', elementId: 'bt' }),
    );
    expect(lintBlocks(issues)).toBe(true);

    // caso 2: boundary sobre gateway
    const overGateway = validDiagram((d) => {
      d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 300, y: 100 });
      const bt = createNode({ id: 'bt2', type: 'boundaryEvent', label: 'bt2', x: 320, y: 120 });
      bt.properties.attachedToRef = 'gw';
      bt.properties.eventDefinition = 'timer';
      bt.properties.timer = { kind: 'duration', expression: 'PT1H' };
      d.nodes.bt2 = bt;
    });
    expect(lintDiagram(overGateway)).toContainEqual(
      expect.objectContaining({ code: 'EXEC_BOUNDARY_HOST_NOT_WAITING', elementId: 'bt2' }),
    );

    // contraprova: sobre userTask é VÁLIDO
    const overUserTask = validDiagram((d) => {
      const bt = createNode({ id: 'bt3', type: 'boundaryEvent', label: 'bt3', x: 220, y: 120 });
      bt.properties.attachedToRef = 'review';
      bt.properties.eventDefinition = 'timer';
      bt.properties.timer = { kind: 'duration', expression: 'PT1H' };
      d.nodes.bt3 = bt;
      d.edges.ebt = createEdge({ id: 'ebt', sourceId: 'bt3', targetId: 'end' });
    });
    expect(lintDiagram(overUserTask).filter((i) => i.code === 'EXEC_BOUNDARY_HOST_NOT_WAITING')).toEqual([]);
  });

  it('elemento fora do subset e timer inválido = error', () => {
    const bad = validDiagram((d) => {
      d.nodes.sub = createNode({ id: 'sub', type: 'subProcess', label: 's', x: 1, y: 1 });
      d.nodes.t = createNode({ id: 't', type: 'intermediateCatchEvent', label: 't', x: 2, y: 2 });
      d.nodes.t.properties.eventDefinition = 'timer';
      d.nodes.t.properties.timer = { kind: 'duration', expression: 'P1M' }; // meses: calendário
    });
    const issues = lintDiagram(bad);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_UNSUPPORTED_ELEMENT', elementId: 'sub' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_TIMER_EXPRESSION_INVALID', elementId: 't' }),
    );
  });

  it('XOR: todo-condicional = WARNING (não bloqueia); dois defaults = error; condição fora do suportado = error', () => {
    const xor = validDiagram((d) => {
      d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 300, y: 100 });
      d.nodes.alt = createNode({ id: 'alt', type: 'endEvent', label: 'alt', x: 500, y: 100 });
      d.edges.g0 = createEdge({ id: 'g0', sourceId: 'start', targetId: 'gw' });
      d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gw', targetId: 'end' });
      d.edges.g1.properties.condition = 'approved = true';
      d.edges.g2 = createEdge({ id: 'g2', sourceId: 'gw', targetId: 'alt' });
      d.edges.g2.properties.condition = 'approved = false';
    });
    const issues = lintDiagram(xor);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_XOR_NO_DEFAULT', severity: 'warning' }),
    );
    expect(lintBlocks(issues)).toBe(false); // warning NÃO bloqueia deploy

    const twoDefaults = validDiagram((d) => {
      d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 300, y: 100 });
      d.nodes.alt = createNode({ id: 'alt', type: 'endEvent', label: 'alt', x: 500, y: 100 });
      d.edges.g0 = createEdge({ id: 'g0', sourceId: 'start', targetId: 'gw' });
      d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gw', targetId: 'end' });
      d.edges.g2 = createEdge({ id: 'g2', sourceId: 'gw', targetId: 'alt' });
    });
    expect(lintDiagram(twoDefaults)).toContainEqual(
      expect.objectContaining({ code: 'EXEC_XOR_MULTIPLE_DEFAULTS', severity: 'error' }),
    );

    const badCondition = validDiagram((d) => {
      d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 300, y: 100 });
      d.nodes.alt = createNode({ id: 'alt', type: 'endEvent', label: 'alt', x: 500, y: 100 });
      d.edges.g0 = createEdge({ id: 'g0', sourceId: 'start', targetId: 'gw' });
      d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gw', targetId: 'end' });
      d.edges.g1.properties.condition = 'valor > 100'; // fora do avaliador v1
      d.edges.g2 = createEdge({ id: 'g2', sourceId: 'gw', targetId: 'alt' });
    });
    expect(lintDiagram(badCondition)).toContainEqual(
      expect.objectContaining({ code: 'EXEC_CONDITION_UNSUPPORTED', edgeId: 'g1' }),
    );
  });

  it('userTask sem formRef, serviceTask sem jobType, nó inalcançável (warning)', () => {
    const bad = validDiagram((d) => {
      delete d.nodes.review.properties.formRef;
      delete d.nodes.notify.properties.jobType;
      d.nodes.orfao = createNode({ id: 'orfao', type: 'task', label: 'o', x: 9, y: 9 });
    });
    const issues = lintDiagram(bad);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'EXEC_FORM_REF_MISSING', elementId: 'review' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'EXEC_JOB_TYPE_MISSING', elementId: 'notify' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_GRAPH_UNREACHABLE', severity: 'warning', elementId: 'orfao' }),
    );
  });
});

describe('registry (migração 0004) — deploy imutável e engine do registry', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('registry');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('reg', 'Registry') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('form: schema inválido é rejeitado (value reservada / classificação ausente); válido versiona', async () => {
    const invalid = await deployFormDefinition(api, tenant, {
      formId: 'aprova',
      schema: {
        formId: 'aprova',
        version: 1,
        title: 'x',
        fields: [{ key: 'value', type: 'text', label: 'v', dataClassification: 'internal' }],
      } as unknown as FormSchema,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(JSON.stringify(invalid.issues)).toContain('FIELD_KEY_RESERVED');

    const v1 = await deployFormDefinition(api, tenant, { formId: 'aprova', schema: validForm });
    expect(v1.ok && v1.form.ref).toBe('aprova@1');
    const v2 = await deployFormDefinition(api, tenant, { formId: 'aprova', schema: validForm });
    expect(v2.ok && v2.form.ref).toBe('aprova@2');
    const byRef = await getFormDefinitionByRef(api, tenant, 'aprova@1');
    expect(byRef?.version).toBe(1); // v1 IMUTÁVEL, intocada pelo v2
  });

  it('process: lint bloqueia com issues (nada gravado); formRef resolve contra o registry', async () => {
    const semJobType = await deployProcessDefinition(api, tenant, {
      name: 'aprovacao',
      diagram: validDiagram((d) => {
        delete d.nodes.notify.properties.jobType;
      }),
      engineVersion: 'test',
    });
    expect(semJobType.ok).toBe(false);
    const page0 = await listProcessDefinitions(api, tenant, {});
    expect(page0.items).toHaveLength(0); // NADA gravado

    const formRefInexistente = await deployProcessDefinition(api, tenant, {
      name: 'aprovacao',
      diagram: validDiagram((d) => {
        d.nodes.review.properties.formRef = 'nao-existe@9';
      }),
      engineVersion: 'test',
    });
    expect(formRefInexistente.ok).toBe(false);
    if (!formRefInexistente.ok) {
      expect(formRefInexistente.issues).toContainEqual(
        expect.objectContaining({ code: 'EXEC_FORM_REF_MISSING' }),
      );
    }

    const ok = await deployProcessDefinition(api, tenant, {
      name: 'aprovacao',
      diagram: validDiagram(),
      engineVersion: 'test',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.definition.registry_ref).toBe('aprovacao@1');
      expect(ok.warnings).toEqual([]);
    }
    const again = await deployProcessDefinition(api, tenant, {
      name: 'aprovacao',
      diagram: validDiagram(),
      engineVersion: 'test',
    });
    expect(again.ok && again.definition.registry_ref).toBe('aprovacao@2');
  });

  it('listStartable: projeção {id,name,version} SEM diagrama; cursor estável (etapa 5)', async () => {
    // já há aprovacao@1 e @2 do teste anterior; publica um 2º nome para paginar
    await deployProcessDefinition(api, tenant, { name: 'onboarding', diagram: validDiagram(), engineVersion: 'test' });

    const page1 = await listStartableDefinitions(api, tenant, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    // projeção MÍNIMA: só id/name/version — NADA de diagrama/registry_ref/xml
    for (const item of page1.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'version']);
      expect(item).not.toHaveProperty('diagram');
    }
    expect(page1.nextCursor).not.toBeNull();

    // cursor avança sem repetir a linha de fronteira
    const page2 = await listStartableDefinitions(api, tenant, { limit: 2, cursor: page1.nextCursor! });
    const ids1 = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) expect(ids1.has(item.id)).toBe(false);
  });

  it('fim-a-fim: definição DEPLOYADA roda no engine do registry, com classificações do FORM', async () => {
    const runtime = createRuntime(api, NOW, {
      keyProvider: (await import('../src/crypto/fieldCipher.js')).createEnvKeyProvider('segredo-de-registry-ok'),
    });
    const engine = await engineForRef(api, tenant, 'aprovacao@1');
    expect(engine).toBeDefined();
    const classifications = await classificationsForRef(api, tenant, 'aprovacao@1');
    expect(classifications).toMatchObject({ cpf: 'sensitive', approved: 'none' });

    const started = await runtime.createAndStart(tenant, {
      definitionRef: 'aprovacao@1',
      businessKey: 'reg-e2e',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.instance.id;
    await drain();
    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT wait_key, form_ref, status FROM user_tasks WHERE instance_id = ${id}`);
    expect(task).toMatchObject({ status: 'open', form_ref: 'aprova@1' }); // pinado

    const done = await advanceInstance(
      api, tenant, id,
      {
        type: 'UserTaskCompleted', now: NOW(), waitKey: task.wait_key as string,
        variables: {}, submission: { approved: true, cpf: '111.222.333-44' },
      },
      { cipher: (await import('../src/crypto/fieldCipher.js')).createFieldCipher(
        (await import('../src/crypto/fieldCipher.js')).createEnvKeyProvider('segredo-de-registry-ok'),
      ) },
    );
    expect(done.ok).toBe(true);
    await drain();

    // classificação veio do FORM deployado: cpf cifrado em repouso
    const [cpfRow] = await withTenant(api, tenant, (tx) =>
      tx`SELECT value, classification FROM variables WHERE instance_id = ${id} AND name = 'cpf'`);
    expect(cpfRow.classification).toBe('sensitive');
    expect(JSON.stringify(cpfRow.value)).not.toContain('111.222.333-44');

    // conclui o job noop e a instância completa
    const { lockJobs } = await import('../src/runtime/jobs.js');
    const jobs = await lockJobs(api, tenant, 'w-reg', { limit: 10 });
    const job = jobs.find((j) => j.instance_id === id)!;
    const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW());
    expect(completed.ok).toBe(true);
    await drain();
    const [finalRow] = await withTenant(api, tenant, (tx) =>
      tx`SELECT status FROM instances WHERE id = ${id}`);
    expect(finalRow.status).toBe('completed');
  });

  async function drain(): Promise<void> {
    for (;;) {
      const result = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (result.processed === 0 && result.failed === 0) return;
    }
  }
});
