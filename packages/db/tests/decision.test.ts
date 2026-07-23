import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintDiagram, lintBlocks, deriveDecisionRouting } from '../src/registry/lint.js';
import { deployFormDefinition, deployProcessDefinition } from '../src/registry/store.js';
import { createRuntime } from '../src/runtime/facade.js';
import { completeUserTask } from '../src/runtime/userTasks.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createEnvKeyProvider } from '../src/crypto/fieldCipher.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-23T12:00:00.000Z';

/** userTask 'review' (formRef df@1) → XOR lê `decisao` → aprova/reprova. */
function decisionDiagram(opts: { decisionVar?: string; gatewayReads?: string } = {}): BpmnDiagram {
  const d = createDiagram({ name: 'Decisão' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
  const review = createNode({ id: 'review', type: 'userTask', label: 'review', x: 200, y: 0 });
  review.properties.formRef = 'df@1';
  if (opts.decisionVar !== undefined) review.properties.decisionVar = opts.decisionVar;
  d.nodes.review = review;
  d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 400, y: 0 });
  d.nodes.endA = createNode({ id: 'endA', type: 'endEvent', label: 'aprov', x: 600, y: -50 });
  d.nodes.endR = createNode({ id: 'endR', type: 'endEvent', label: 'reprov', x: 600, y: 50 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'gw' });
  const readVar = opts.gatewayReads ?? 'decisao';
  d.edges.gA = createEdge({ id: 'gA', sourceId: 'gw', targetId: 'endA' });
  d.edges.gA.properties.condition = `${readVar} = "aprovar"`;
  d.edges.gR = createEdge({ id: 'gR', sourceId: 'gw', targetId: 'endR' });
  d.edges.gR.properties.condition = `${readVar} = "reprovar"`;
  return d;
}

const dfForm: FormSchema = {
  formId: 'df',
  version: 1,
  title: 'Decisão',
  fields: [{ key: 'obs', type: 'text', label: 'Obs', dataClassification: 'internal' }],
} as unknown as FormSchema;

describe('etapa 6 — lint D19 da decisionVar (estático)', () => {
  it('decisionVar SEM gateway a jusante que a leia = WARNING (não bloqueia)', () => {
    const issues = lintDiagram(decisionDiagram({ decisionVar: 'decisao', gatewayReads: 'outra' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_DECISION_VAR_NO_GATEWAY', severity: 'warning', elementId: 'review' }),
    );
    expect(lintBlocks(issues)).toBe(false);
  });

  it('decisionVar COM gateway a jusante lendo-a = sem o warning', () => {
    const issues = lintDiagram(decisionDiagram({ decisionVar: 'decisao', gatewayReads: 'decisao' }));
    expect(issues.filter((i) => i.code === 'EXEC_DECISION_VAR_NO_GATEWAY')).toEqual([]);
  });

  it('sem decisionVar declarada = nenhum warning de decisão', () => {
    const issues = lintDiagram(decisionDiagram());
    expect(issues.filter((i) => i.code === 'EXEC_DECISION_VAR_NO_GATEWAY')).toEqual([]);
  });

  it('deriveDecisionRouting extrai as OPÇÕES exatas do gateway a jusante', () => {
    const r = deriveDecisionRouting(decisionDiagram({ decisionVar: 'decisao', gatewayReads: 'decisao' }), 'review');
    expect(r.decisionVar).toBe('decisao');
    expect(r.readByGateway).toBe(true);
    expect(r.options).toEqual(['aprovar', 'reprovar']); // ordenadas, dedup
  });

  it('gateway lê a var mas sem literal string enumerável → texto livre + warning (degrada, não falha)', () => {
    const d = decisionDiagram({ decisionVar: 'nota', gatewayReads: 'nota' });
    // troca as condições string por numéricas (fora da enumeração de string)
    d.edges.gA.properties.condition = 'nota = 10';
    d.edges.gR.properties.condition = 'nota = 0';
    const r = deriveDecisionRouting(d, 'review');
    expect(r.readByGateway).toBe(true);
    expect(r.options).toBeNull(); // texto livre
    const issues = lintDiagram(d);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EXEC_DECISION_VAR_FREE_TEXT', severity: 'warning' }),
    );
    expect(lintBlocks(issues)).toBe(false);
  });
});

describe('etapa 6 — deploy: colisão da decisionVar (gate)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('decision_deploy');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('dc', 'Dec') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployFormDefinition(api, tenant, { formId: 'df', schema: dfForm });
    // form com um campo SENSITIVE para o teste de colisão
    await deployFormDefinition(api, tenant, {
      formId: 'sf',
      schema: {
        formId: 'sf',
        version: 1,
        title: 'Sens',
        fields: [{ key: 'cpf', type: 'text', label: 'CPF', dataClassification: 'sensitive' }],
      } as unknown as FormSchema,
    });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('decisionVar = value reservada → erro, nada gravado', async () => {
    const out = await deployProcessDefinition(api, tenant, {
      name: 'colide-value',
      diagram: decisionDiagram({ decisionVar: 'value', gatewayReads: 'value' }),
      engineVersion: 'test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issues).toContainEqual(
        expect.objectContaining({ code: 'EXEC_DECISION_VAR_RESERVED', severity: 'error' }),
      );
    }
  });

  it('decisionVar colidindo com campo sensitive do form → erro', async () => {
    // review usa o form sf@1 (campo cpf sensitive); decisionVar = 'cpf'
    const d = decisionDiagram({ decisionVar: 'cpf', gatewayReads: 'cpf' });
    d.nodes.review.properties.formRef = 'sf@1';
    const out = await deployProcessDefinition(api, tenant, { name: 'colide-sens', diagram: d, engineVersion: 'test' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issues).toContainEqual(
        expect.objectContaining({ code: 'EXEC_DECISION_VAR_SENSITIVE', severity: 'error', elementId: 'review' }),
      );
    }
  });

  it('decisionVar limpa (não value, não sensitive, com gateway) → publica', async () => {
    const out = await deployProcessDefinition(api, tenant, {
      name: 'decisao-ok',
      diagram: decisionDiagram({ decisionVar: 'decisao', gatewayReads: 'decisao' }),
      engineVersion: 'test',
    });
    expect(out.ok).toBe(true);
  });
});

describe('etapa 6 — completion: a decisão NUNCA é ignorada em silêncio (fim-a-fim)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('decision_e2e');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('de', 'DecE2E') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 6, onnotice: () => {} });
    await deployFormDefinition(api, tenant, { formId: 'df', schema: dfForm });
    // proc COM decisionVar; proc SEM decisionVar (userTask simples)
    await deployProcessDefinition(api, tenant, {
      name: 'com-decisao',
      diagram: decisionDiagram({ decisionVar: 'decisao', gatewayReads: 'decisao' }),
      engineVersion: 'test',
    });
    const plain = createDiagram({ name: 'Plain' });
    plain.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
    const r = createNode({ id: 'review', type: 'userTask', label: 'r', x: 200, y: 0 });
    r.properties.formRef = 'df@1';
    plain.nodes.review = r;
    plain.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'e', x: 400, y: 0 });
    plain.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
    plain.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'end' });
    await deployProcessDefinition(api, tenant, { name: 'sem-decisao', diagram: plain, engineVersion: 'test' });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  const runtime = () => createRuntime(api, NOW, { keyProvider: createEnvKeyProvider('seg-decisao-teste-ok') });

  async function drain(): Promise<void> {
    for (;;) {
      const r = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (r.processed === 0 && r.failed === 0) return;
    }
  }

  async function startAndOpen(ref: string): Promise<{ instanceId: string; taskId: string }> {
    const started = await runtime().createAndStart(tenant, { definitionRef: ref, businessKey: `${ref}-${Math.random()}`.slice(0, 40) });
    if (!started.ok) throw new Error('start falhou');
    await drain();
    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${started.instance.id} AND status = 'open'`);
    return { instanceId: started.instance.id, taskId: task.id as string };
  }

  it('task COM decisionVar + conclusão SEM decision → 422 decisionRequired (task segue aberta)', async () => {
    const { taskId } = await startAndOpen('com-decisao@1');
    const claim = await runtime().userTasks.claim(tenant, taskId, 'ana');
    if (!claim.ok) throw new Error('claim falhou');
    const out = await completeUserTask(api, tenant, taskId, { claimToken: claim.claimToken, submission: {}, user: 'ana', now: NOW() });
    expect(out).toMatchObject({ ok: false, reason: 'decisionRequired' });
    const [still] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM user_tasks WHERE id = ${taskId}`);
    expect(still.status).toBe('open'); // nada foi concluído
  });

  it('task SEM decisionVar + decision no corpo → 422 decisionUnexpected (nunca aceitar-e-descartar)', async () => {
    const { taskId } = await startAndOpen('sem-decisao@1');
    const claim = await runtime().userTasks.claim(tenant, taskId, 'ana');
    if (!claim.ok) throw new Error('claim falhou');
    const out = await completeUserTask(api, tenant, taskId, { claimToken: claim.claimToken, submission: {}, user: 'ana', now: NOW(), decision: 'aprovar' });
    expect(out).toMatchObject({ ok: false, reason: 'decisionUnexpected' });
  });

  it('DESENCONTRO DE VALOR: decision fora das opções do gateway → 422 (aprovação inócua evitada)', async () => {
    const { taskId } = await startAndOpen('com-decisao@1');
    const claim = await runtime().userTasks.claim(tenant, taskId, 'ana');
    if (!claim.ok) throw new Error('claim falhou');
    // "Aprovar" (maiúsculo) não casa `decisao = "aprovar"` — o default engoliria
    const out = await completeUserTask(api, tenant, taskId, {
      claimToken: claim.claimToken,
      submission: {},
      user: 'ana',
      now: NOW(),
      decision: 'Aprovar',
    });
    expect(out).toMatchObject({ ok: false, reason: 'decisionInvalid' });
    if (!out.ok && 'message' in out) expect(out.message).toMatch(/aprovar.*reprovar|rota válida/i);
    const [still] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM user_tasks WHERE id = ${taskId}`);
    expect(still.status).toBe('open');
  });

  it('decision válida: roteia pelo gateway + grava em variables E em history_events (quem decidiu o quê)', async () => {
    const { instanceId, taskId } = await startAndOpen('com-decisao@1');
    const claim = await runtime().userTasks.claim(tenant, taskId, 'bruno');
    if (!claim.ok) throw new Error('claim falhou');
    const out = await completeUserTask(api, tenant, taskId, {
      claimToken: claim.claimToken,
      submission: {},
      user: 'bruno',
      now: NOW(),
      decision: 'aprovar',
    });
    expect(out.ok).toBe(true);
    await drain();

    // 1) variables: a decisão sob a decisionVar
    const [v] = await withTenant(api, tenant, (tx) =>
      tx`SELECT value FROM variables WHERE instance_id = ${instanceId} AND name = 'decisao'`);
    expect(JSON.stringify(v.value)).toContain('aprovar');

    // 2) history_events: evento taskDecision com quem decidiu o quê
    const [h] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, payload FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskDecision'`);
    expect(h).toBeDefined();
    expect(h.payload).toMatchObject({ decisionVar: 'decisao', decision: 'aprovar', actor: 'bruno' });

    // 3) roteou de fato: a instância completou pelo ramo aprovar
    const [inst] = await withTenant(api, tenant, (tx) => tx`SELECT status FROM instances WHERE id = ${instanceId}`);
    expect(inst.status).toBe('completed');
  });
});
