import type { ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployToolDefinition, getToolDefinitionByRef, validateToolContract } from '../src/registry/toolStore.js';
import { deployProcessDefinition } from '../src/registry/store.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * AG-2.2 etapa 5 (D31) slice 1 — registry de tool contracts + lint de deploy do
 * gate. O contrato declara effect+authorization; o deploy trava a coerência
 * (irreversível/external NUNCA `automatica`). O lint de processo exige um btv:gate
 * a jusante de agentTask (autonomia→gate) e de serviceTask com tool gated.
 */
function toolContract(over: Partial<ToolContract> = {}): ToolContract {
  return {
    kind: 'ToolContract',
    id: 'tool:send-email',
    version: '1.0.0',
    name: 'send_email',
    capability: 'enviar e-mail ao cliente',
    inputSchema: { to: { type: 'string' } },
    outputSchema: {},
    effect: 'external-commitment',
    dataScope: 'contato-cliente',
    authorization: 'gate',
    evidenceRequired: 'nenhuma',
    simulation: 'fixture-obrigatoria',
    ...over,
  };
}

/** start → [alvo] → (gate?) → end. `withGate` insere um btv:gate userTask antes do fim. */
function diagram(target: { id: string; type: string; props?: Record<string, unknown> }, withGate: boolean): BpmnDiagram {
  const d = createDiagram({ name: 'p' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'start', x: 0, y: 0 });
  const node = createNode({ id: target.id, type: target.type, label: target.id, x: 200, y: 0 });
  Object.assign(node.properties, target.props ?? {});
  d.nodes[target.id] = node;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'fim', x: 600, y: 0 });
  if (withGate) {
    const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar', x: 400, y: 0 });
    gate.properties.btvGate = true;
    d.nodes.gate = gate;
    d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: target.id });
    d.edges.e2 = createEdge({ id: 'e2', sourceId: target.id, targetId: 'gate' });
    d.edges.e3 = createEdge({ id: 'e3', sourceId: 'gate', targetId: 'fim' });
  } else {
    d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: target.id });
    d.edges.e2 = createEdge({ id: 'e2', sourceId: target.id, targetId: 'fim' });
  }
  return d;
}

describe('AG-2.2 etapa 5 slice 1 — registry de tool + lint do gate (D31)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('tool_gate');
    migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployToolDefinition(api, tenant, { contract: toolContract() }); // tool:send-email@1.0.0 (gate)
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('validateToolContract: irreversível/external + automatica → TOOL_EFFECT_AUTOMATICA_GATED', () => {
    const issues = validateToolContract(toolContract({ authorization: 'automatica' }));
    expect(issues.some((i) => i.code === 'TOOL_EFFECT_AUTOMATICA_GATED')).toBe(true);
    // read + automatica é coerente (efeito não exige gate)
    expect(validateToolContract(toolContract({ effect: 'read', authorization: 'automatica' }))).toHaveLength(0);
  });

  it('deploy VÁLIDO grava com ref canônica; re-deploy da versão é imutável', async () => {
    const out = await deployToolDefinition(api, tenant, { contract: toolContract({ id: 'tool:notificar', version: '1.0.0' }) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.tool.ref).toBe('tool:notificar@1.0.0');
    await expect(
      deployToolDefinition(api, tenant, { contract: toolContract({ id: 'tool:notificar', version: '1.0.0' }) }),
    ).rejects.toThrow(/duplicate key|unique/i);
    expect(await getToolDefinitionByRef(api, tenant, 'tool:send-email@1.0.0')).toBeDefined();
  });

  it('deploy do contrato incoerente é RECUSADO (nada gravado)', async () => {
    const out = await deployToolDefinition(api, tenant, {
      contract: toolContract({ id: 'tool:cobrar', authorization: 'automatica' }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues[0].code).toBe('TOOL_EFFECT_AUTOMATICA_GATED');
    expect(await getToolDefinitionByRef(api, tenant, 'tool:cobrar@1.0.0')).toBeUndefined();
  });

  it('agentTask autonomia≤3 SEM btv:gate a jusante → EXEC_AGENT_GATE_MISSING (bloqueia deploy)', async () => {
    const semGate = await deployProcessDefinition(api, tenant, {
      name: 'p-agente-sem-gate', engineVersion: 'e',
      diagram: diagram({ id: 'classificar', type: 'agentTask', props: { agentWorkflowRef: 'agnt-x', autonomyLevel: 1 } }, false),
    });
    expect(semGate.ok).toBe(false);
    if (!semGate.ok) expect(semGate.issues.some((i) => i.code === 'EXEC_AGENT_GATE_MISSING')).toBe(true);

    const comGate = await deployProcessDefinition(api, tenant, {
      name: 'p-agente-com-gate', engineVersion: 'e',
      diagram: diagram({ id: 'classificar', type: 'agentTask', props: { agentWorkflowRef: 'agnt-x', autonomyLevel: 1 } }, true),
    });
    expect(comGate.ok).toBe(true);
  });

  it('serviceTask com tool de efeito gated SEM btv:gate → EXEC_TOOL_EFFECT_UNGATED', async () => {
    const semGate = await deployProcessDefinition(api, tenant, {
      name: 'p-tool-sem-gate', engineVersion: 'e',
      diagram: diagram({ id: 'enviar', type: 'serviceTask', props: { jobType: 'tool', toolRef: 'tool:send-email@1.0.0' } }, false),
    });
    expect(semGate.ok).toBe(false);
    if (!semGate.ok) expect(semGate.issues.some((i) => i.code === 'EXEC_TOOL_EFFECT_UNGATED')).toBe(true);

    const comGate = await deployProcessDefinition(api, tenant, {
      name: 'p-tool-com-gate', engineVersion: 'e',
      diagram: diagram({ id: 'enviar', type: 'serviceTask', props: { jobType: 'tool', toolRef: 'tool:send-email@1.0.0' } }, true),
    });
    expect(comGate.ok).toBe(true);
  });
});
