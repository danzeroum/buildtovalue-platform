import { APPROVAL_GATE_AGENT, type AgentWorkflow } from '@buildtovalue/agentflow';
import { createDiagram, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployAgentDefinition, recordAgentPinsAtStart } from '../src/registry/agentStore.js';
import { effectKey } from '../src/runtime/effectKey.js';
import { dispatchOutboxOnce, insertEffects } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * AG-2.2 etapa 4 — SUBSTITUIÇÃO DO PIN no despacho do CreateJob(agent). O engine
 * emite a ref DECLARADA; o host a troca pela EFETIVA lida da tabela OPERACIONAL
 * `instance_agent_pins` (nunca a trilha). Grava as DUAS refs. Pin ausente →
 * incidente `agentPinMissing`, nunca resolução no despacho.
 */
function graphAt(id: string, version: string): AgentWorkflow {
  const g = structuredClone(APPROVAL_GATE_AGENT);
  g.id = id;
  g.version = version;
  return g;
}

function agentDiagram(elementId: string, ref: string): BpmnDiagram {
  const d = createDiagram({ name: 'com-agente' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'start', x: 0, y: 0 });
  const node = createNode({ id: elementId, type: 'agentTask', label: elementId, x: 200, y: 0 });
  node.properties.agentWorkflowRef = ref;
  node.properties.autonomyLevel = 1;
  d.nodes[elementId] = node;
  return d;
}

describe('AG-2.2 etapa 4 — substituição do pin no despacho (CreateJob agent)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;

  async function seedInstance(): Promise<string> {
    return withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version,
          state_schema_version, state, status)
        VALUES (${tenant}, 'com-agente@1', 'e', 1, '{}'::jsonb, 'active')
        RETURNING id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('agent_pin_dispatch');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    // registro do agente em duas versões (flutuante resolve p/ a maior)
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-aprova', '1.0.0') });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-aprova', '1.2.0') });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('pin resolvido → despacho substitui declared por effective (grava as DUAS)', async () => {
    const instance = await seedInstance();
    // start pina o agentTask (flutuante 'agnt-aprova' → efetivo '@1.2.0')
    await withTenant(api, tenant, (tx) =>
      recordAgentPinsAtStart(tx, tenant, instance, agentDiagram('classificar', 'agnt-aprova'), 'e'),
    );
    // o engine emitiria este efeito: CreateJob(agent) com a ref DECLARADA no payload
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 1, 0, 'CreateJob'),
          effect: {
            type: 'CreateJob',
            waitKey: `classificar:${instance}`,
            jobType: 'agent',
            payload: { elementId: 'classificar', agentRef: 'agnt-aprova' },
          },
        },
      ]),
    );
    const result = await dispatchOutboxOnce(api, tenant);
    expect(result.processed).toBe(1);
    const [job] = await withTenant(api, tenant, (tx) => tx`
      SELECT type, payload FROM jobs WHERE instance_id = ${instance}`);
    expect(job.type).toBe('agent');
    // as DUAS refs no payload: auditor vê "declarou agnt-aprova, rodou @1.2.0"
    expect(job.payload).toMatchObject({
      elementId: 'classificar',
      declaredRef: 'agnt-aprova',
      effectiveRef: 'agnt-aprova@1.2.0',
    });
    // a ref declarada CRUA do engine não sobrevive como agentRef (só as duas nomeadas)
    expect((job.payload as { agentRef?: unknown }).agentRef).toBeUndefined();
  });

  it('pin AUSENTE → incidente agentPinMissing, nenhum job (nunca resolve no despacho)', async () => {
    const instance = await seedInstance();
    // NÃO chamamos recordAgentPinsAtStart → sem pin operacional para 'orfao'
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instance, [
        {
          effectKey: effectKey(instance, 1, 0, 'CreateJob'),
          effect: {
            type: 'CreateJob',
            waitKey: `orfao:${instance}`,
            jobType: 'agent',
            payload: { elementId: 'orfao', agentRef: 'agnt-aprova' },
          },
        },
      ]),
    );
    await dispatchOutboxOnce(api, tenant);
    const jobs = await withTenant(api, tenant, (tx) => tx`
      SELECT 1 FROM jobs WHERE instance_id = ${instance}`);
    expect(jobs).toHaveLength(0); // nenhum job criado
    const [incident] = await withTenant(api, tenant, (tx) => tx`
      SELECT kind, message FROM incidents WHERE instance_id = ${instance}`);
    expect(incident.kind).toBe('agentPinMissing');
    expect(incident.message).toMatch(/orfao/);
  });
});
