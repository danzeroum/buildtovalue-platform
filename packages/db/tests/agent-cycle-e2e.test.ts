import { APPROVAL_GATE_AGENT, type AgentWorkflow, type Fixtures } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentJob, simulateWalker } from '../src/agent/agentRunner.js';
import { buildAgentFacts, persistAgentTrail } from '../src/agent/agentTrail.js';
import { upsertTenantAiConfig } from '../src/agent/tenantAiConfig.js';
import { deployAgentDefinition, getAgentDefinitionByRef } from '../src/registry/agentStore.js';
import { createRuntime } from '../src/runtime/facade.js';
import { classificationsForRef, deployProcessDefinition } from '../src/registry/store.js';
import { getInstance } from '../src/runtime/advance.js';
import { lockJobs } from '../src/runtime/jobs.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-23T18:00:00.000Z';

/**
 * FECHAMENTO DA ETAPA 4 (AG-2.2) — o ciclo COMPLETO com pin, ponta a ponta, contra
 * o engine@1.1.0-next.3 publicado. Até aqui cada peça foi provada isolada; aqui elas
 * correm JUNTAS:
 *   instância com agentTask → o ENGINE emite CreateJob(agent) → o despacho troca
 *   declaredRef por effectiveRef (do pin operacional) → o "worker" executa o grafo
 *   governado → a trilha GRANULAR (agent:*) com envelope de ator é gravada.
 */
function graphAt(id: string, version: string): AgentWorkflow {
  const g = structuredClone(APPROVAL_GATE_AGENT);
  g.id = id;
  g.version = version;
  return g;
}

/** start → classificar(agentTask, ref flutuante) → gate(btv:gate) → fim. O
 * btv:gate a jusante é EXIGIDO pelo lint (autonomia 1 → gate D31): o agente
 * PROPÕE, o processo faz o gate. Assim o e2e passa pela PORTA REAL (deploy). */
function processWithAgent(): BpmnDiagram {
  const d = createDiagram({ name: 'com-agente' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'start', x: 0, y: 0 });
  const agent = createNode({ id: 'classificar', type: 'agentTask', label: 'Classificar', x: 200, y: 0 });
  agent.properties.agentWorkflowRef = 'agnt-aprova';
  agent.properties.autonomyLevel = 1;
  d.nodes.classificar = agent;
  const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar ação', x: 400, y: 0 });
  gate.properties.btvGate = true;
  d.nodes.gate = gate;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'fim', x: 600, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'classificar' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'classificar', targetId: 'gate' });
  d.edges.e3 = createEdge({ id: 'e3', sourceId: 'gate', targetId: 'fim' });
  return d;
}

describe('AG-2.2 etapa 4 — ciclo COMPLETO com pin (fecha a etapa)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  const actor = { type: 'user' as const, id: 'admin', requestId: 'r1' };
  const fixtures: Fixtures = { 'llm-review': { outputs: [{ approved: true, rationale: 'ok' }] } };

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await dispatchOutboxOnce(api, tenant);
  };

  beforeAll(async () => {
    db = await createTestDatabase('agent_cycle');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    // registro do agente: 1.0.0 + 1.2.0 (flutuante resolve p/ 1.2.0)
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-aprova', '1.0.0') });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-aprova', '1.2.0') });
    // definição de processo DEPLOYADA pela PORTA REAL (deployProcessDefinition):
    // passa pelo lint do gate (etapa 5) — o btv:gate a jusante do agentTask é
    // exigido. Inserir direto provaria menos do que parece (fora do lint).
    const deployed = await deployProcessDefinition(api, tenant, {
      name: 'com-agente', engineVersion: 'e', diagram: processWithAgent(),
    });
    if (!deployed.ok) throw new Error(`deploy falhou: ${JSON.stringify(deployed.issues)}`);
    await upsertTenantAiConfig(
      api, tenant,
      { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/ag/anthropic', budgetCents: 100 },
      actor,
    );
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('agentTask → CreateJob(agent) → substituição do pin → execução → trilha granular com ator', async () => {
    const runtime = createRuntime(api, NOW);

    // 1) START: o ENGINE (next.3) alcança o agentTask e emite CreateJob(agent); o pin
    //    é resolvido no start (flutuante → @1.2.0) e gravado na tabela operacional.
    const started = await runtime.createAndStart(tenant, { definitionRef: 'com-agente@1' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const instanceId = started.instance.id;
    expect(started.instance.status).toBe('active'); // pausou na espera do agente

    // pin operacional gravado (0008) + evidência na trilha
    const [pinRow] = await withTenant(api, tenant, (tx) => tx`
      SELECT declared_ref, effective_ref FROM instance_agent_pins
      WHERE instance_id = ${instanceId} AND element_id = 'classificar'`);
    expect(pinRow).toMatchObject({ declared_ref: 'agnt-aprova', effective_ref: 'agnt-aprova@1.2.0' });

    // 2) DESPACHO: troca declaredRef por effectiveRef no payload do job
    await drain();
    const [job] = await lockJobs(api, tenant, 'w-e2e', { limit: 10 });
    expect(job.type).toBe('agent');
    expect(job.payload).toMatchObject({
      elementId: 'classificar',
      declaredRef: 'agnt-aprova',
      effectiveRef: 'agnt-aprova@1.2.0',
    });

    // 3) WORKER (replicado): roda o grafo GOVERNADO pelo effectiveRef + grava a trilha.
    const effectiveRef = (job.payload as { effectiveRef: string }).effectiveRef;
    const outcome = await runAgentJob(
      api, tenant,
      { agentRef: effectiveRef, elementId: 'classificar', fixtures },
      {
        resolveGraph: async (i) => {
          const def = i.agentRef ? await getAgentDefinitionByRef(api, tenant, i.agentRef) : undefined;
          return def ? { graph: def.graph } : null;
        },
        walker: simulateWalker,
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const instance = await getInstance(api, tenant, instanceId);
    const classifications = await classificationsForRef(api, tenant, 'com-agente@1');
    const facts = buildAgentFacts({
      io: { output: outcome.walk.output ?? {} },
      visitedNodes: outcome.walk.visitedNodes,
      complete: outcome.walk.complete,
      decisions: outcome.walk.decisions,
    });
    await withTenant(api, tenant, (tx) =>
      persistAgentTrail(tx, {
        tenantId: tenant, instanceId, elementId: 'classificar', agentRef: effectiveRef,
        actor: { type: 'agent', id: effectiveRef, requestId: job.id },
        facts, classifications, engineVersion: instance!.engine_version, revision: instance!.revision,
      }),
    );

    // 4) CONCLUSÃO pelo contrato: JobCompleted → o engine retoma e roteia ao btv:gate
    //    a jusante. O agente PROPÔS; o processo agora AGUARDA o gate humano (D31): a
    //    instância segue ATIVA, com a tarefa de gate aberta — não completa sozinha.
    const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW(), outcome.result);
    expect(completed.ok).toBe(true);
    await drain();
    const final = await getInstance(api, tenant, instanceId);
    expect(final!.status).toBe('active'); // pausada no gate, não completa (o efeito exige aval)
    const [gateTask] = await withTenant(api, tenant, (tx) => tx`
      SELECT element_id, status FROM user_tasks WHERE instance_id = ${instanceId} AND element_id = 'gate'`);
    expect(gateTask).toMatchObject({ element_id: 'gate', status: 'open' });

    // 5) TRILHA GRANULAR (agent:*) com ENVELOPE DE ATOR — a cadeia D1 completa.
    const trail = await withTenant(api, tenant, (tx) => tx`
      SELECT kind, payload FROM history_events
      WHERE instance_id = ${instanceId} AND kind LIKE 'agent:%' ORDER BY seq`);
    const kinds = trail.map((r) => r.kind as string);
    expect(kinds).toContain('agent:pinResolved');       // evidência do pin (ator system)
    expect(kinds).toContain('agent:intencao');
    expect(kinds).toContain('agent:acao');
    expect(kinds).toContain('agent:io');
    expect(kinds).toContain('agent:decisao');           // elo derivado do trail
    expect(kinds).toContain('agent:evidencia');
    // ator gravado em CADA fato; o pin é ato do system, os fatos são do agente.
    const pinEv = trail.find((r) => r.kind === 'agent:pinResolved');
    expect((pinEv!.payload as { actor: { type: string } }).actor).toMatchObject({ type: 'system' });
    const factRows = trail.filter((r) => r.kind !== 'agent:pinResolved');
    for (const r of factRows) {
      expect((r.payload as { actor: { type: string; id: string } }).actor).toMatchObject({
        type: 'agent', id: 'agnt-aprova@1.2.0',
      });
    }
  });
});
