import { APPROVAL_GATE_AGENT, type AgentWorkflow, type Fixtures, type ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentJob, simulateWalker } from '../src/agent/agentRunner.js';
import { buildAgentFacts, persistAgentTrail } from '../src/agent/agentTrail.js';
import { executeGatedEffectTx } from '../src/agent/gateFio.js';
import { upsertTenantAiConfig } from '../src/agent/tenantAiConfig.js';
import { deployAgentDefinition, getAgentDefinitionByRef } from '../src/registry/agentStore.js';
import { classificationsForRef, deployProcessDefinition } from '../src/registry/store.js';
import { deployToolDefinition } from '../src/registry/toolStore.js';
import { createRuntime } from '../src/runtime/facade.js';
import { getInstance } from '../src/runtime/advance.js';
import { completeUserTask } from '../src/runtime/userTasks.js';
import { lockJobs } from '../src/runtime/jobs.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-24T10:00:00.000Z';

/**
 * FECHAMENTO DA ETAPA 5 (D31) — o ciclo do gate de tool PONTA A PONTA, pelas
 * PORTAS REAIS: deploy pelo lint (deployProcessDefinition), aprovação pela
 * conclusão fenced com expectedInstanceRevision (D28), efeito pelo despacho
 * normal (lockJobs + contrato de job). O agente PROPÕE → o gate abre com o
 * world-delta → o humano aprova → o efeito roda SOB SELO → a instância completa.
 * Os negativos rodam em INSTÂNCIAS PRÓPRIAS (não como continuação do feliz).
 */
function agentAt(id: string, version: string): AgentWorkflow {
  const g = structuredClone(APPROVAL_GATE_AGENT);
  g.id = id;
  g.version = version;
  return g;
}

const sendEmail = (id: string): ToolContract => ({
  kind: 'ToolContract', id, version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: '3 destinatários', authorization: 'gate',
  evidenceRequired: 'cópia enviada', simulation: 'fixture-obrigatoria',
});

/**
 * start → classificar(agentTask) → gate(btvGate, decisionVar, toolRef, proposalVar)
 * gate → gw(exclusiveGateway):
 *   [decisao="aprovar"] → enviar(serviceTask send-email, gatedBy=gate) → fim
 *   [decisao="reprovar"] → fimReprovado
 * O agente PROPÕE; o processo faz o GATE (lint EFFECT_NEEDS_GATE exige a rota de
 * reprovação DEFINIDA). O efeito roda a jusante do aprovar, sob selo.
 */
function gateProcess(name: string, toolRef: string): BpmnDiagram {
  const d = createDiagram({ name });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'start', x: 0, y: 0 });
  const agent = createNode({ id: 'classificar', type: 'agentTask', label: 'Classificar', x: 150, y: 0 });
  agent.properties.agentWorkflowRef = 'agnt-aprova';
  agent.properties.autonomyLevel = 1;
  d.nodes.classificar = agent;
  const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 300, y: 0 });
  gate.properties.btvGate = true;
  gate.properties.decisionVar = 'decisao';
  gate.properties.toolRef = toolRef;       // qual tool este gate governa (pinado)
  gate.properties.proposalVar = 'proposta'; // variável com os params propostos pelo agente
  d.nodes.gate = gate;
  d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 450, y: 0 });
  const enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 600, y: -40 });
  enviar.properties.jobType = 'send-email';
  enviar.properties.gatedBy = 'gate';       // o efeito sob gate (selado na execução)
  d.nodes.enviar = enviar;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'fim', x: 750, y: -40 });
  d.nodes.fimReprovado = createNode({ id: 'fimReprovado', type: 'endEvent', label: 'reprovado', x: 600, y: 60 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'classificar' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'classificar', targetId: 'gate' });
  d.edges.e3 = createEdge({ id: 'e3', sourceId: 'gate', targetId: 'gw' });
  d.edges.gA = createEdge({ id: 'gA', sourceId: 'gw', targetId: 'enviar' });
  d.edges.gA.properties.condition = 'decisao = "aprovar"';
  d.edges.gR = createEdge({ id: 'gR', sourceId: 'gw', targetId: 'fimReprovado' });
  d.edges.gR.properties.condition = 'decisao = "reprovar"';
  d.edges.eF = createEdge({ id: 'eF', sourceId: 'enviar', targetId: 'fim' });
  return d;
}

describe('AG-2.2 etapa 5 — ciclo do gate ponta a ponta pelas portas reais (D31)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  const actor = { type: 'user' as const, id: 'admin', requestId: 'r1' };
  const fixtures: Fixtures = { 'llm-review': { outputs: [{ approved: true, rationale: 'ok' }] } };

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await dispatchOutboxOnce(api, tenant);
  };

  beforeAll(async () => {
    db = await createTestDatabase('agent_gate_e2e');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployAgentDefinition(api, tenant, { graph: agentAt('agnt-aprova', '1.0.0') });
    await deployToolDefinition(api, tenant, { contract: sendEmail('tool:send-email') });
    await deployToolDefinition(api, tenant, { contract: sendEmail('tool:stale-email') });
    const okDeploy = await deployProcessDefinition(api, tenant, {
      name: 'gate-proc', engineVersion: 'e', diagram: gateProcess('gate-proc', 'tool:send-email@2.0.1'),
    });
    if (!okDeploy.ok) throw new Error(`deploy gate-proc falhou: ${JSON.stringify(okDeploy.issues)}`);
    const staleDeploy = await deployProcessDefinition(api, tenant, {
      name: 'gate-stale', engineVersion: 'e', diagram: gateProcess('gate-stale', 'tool:stale-email@2.0.1'),
    });
    if (!staleDeploy.ok) throw new Error(`deploy gate-stale falhou: ${JSON.stringify(staleDeploy.issues)}`);
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

  /** Conduz start → agent job → conclusão → gate aberto (com world-delta). Devolve
   *  o instanceId, o id da tarefa de gate e a revisão vista no gate (para o D28). */
  async function driveToGate(definitionRef: string): Promise<{ instanceId: string; gateTaskId: string; gateRevision: number }> {
    const runtime = createRuntime(api, NOW);
    const started = await runtime.createAndStart(tenant, { definitionRef });
    if (!started.ok) throw new Error('start falhou');
    const instanceId = started.instance.id;
    await drain();
    // WORKER (replicado, como no e2e da etapa 4): roda o grafo governado + trilha.
    const [job] = await lockJobs(api, tenant, 'w', { limit: 10, types: ['agent'] });
    const outcome = await runAgentJob(
      api, tenant,
      { agentRef: (job.payload as { effectiveRef: string }).effectiveRef, elementId: 'classificar', fixtures },
      {
        resolveGraph: async (i) => {
          const def = i.agentRef ? await getAgentDefinitionByRef(api, tenant, i.agentRef) : undefined;
          return def ? { graph: def.graph } : null;
        },
        walker: simulateWalker,
      },
    );
    if (!outcome.ok) throw new Error('agente não concluiu');
    const inst = await getInstance(api, tenant, instanceId);
    const classifications = await classificationsForRef(api, tenant, definitionRef);
    const facts = buildAgentFacts({
      io: { output: outcome.walk.output ?? {} }, visitedNodes: outcome.walk.visitedNodes,
      complete: outcome.walk.complete, decisions: outcome.walk.decisions,
    });
    await withTenant(api, tenant, (tx) =>
      persistAgentTrail(tx, {
        tenantId: tenant, instanceId, elementId: 'classificar', agentRef: (job.payload as { effectiveRef: string }).effectiveRef,
        actor: { type: 'agent', id: (job.payload as { effectiveRef: string }).effectiveRef, requestId: job.id },
        facts, classifications, engineVersion: inst!.engine_version, revision: inst!.revision,
      }),
    );
    // conclusão pelo contrato — o `result` carrega a proposta do agente (os params
    // que o gate mostra). O host o persiste em `variables` (D13); o gate-open lê 'proposta'.
    const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW(), {
      ...outcome.result, proposta: { to: ['a@x', 'b@y', 'c@z'] },
    });
    if (!completed.ok) throw new Error('conclusão do job falhou');
    await drain(); // o engine roteia ao gate → OpenUserTask (enriquecido com world-delta)
    const [gateTask] = await withTenant(api, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${instanceId} AND element_id = 'gate' AND status = 'open'`);
    const atGate = await getInstance(api, tenant, instanceId);
    return { instanceId, gateTaskId: gateTask.id as string, gateRevision: atGate!.revision };
  }

  it('FELIZ: propõe → gate abre com world-delta → aprova (expectedInstanceRevision) → efeito com selo → completa', async () => {
    const { instanceId, gateTaskId, gateRevision } = await driveToGate('gate-proc@1');
    const runtime = createRuntime(api, NOW);

    // gate aberto com o WORLD-DELTA no payload (fio do item 2, agora automático).
    const [gate] = await withTenant(api, tenant, (tx) =>
      tx`SELECT is_gate, payload FROM user_tasks WHERE id = ${gateTaskId}`);
    expect(gate.is_gate).toBe(true);
    expect(gate.payload).toMatchObject({
      tool: 'tool:send-email@2.0.1', effect: 'external-commitment', authorization: 'gate',
      dataScope: '3 destinatários', evidenceRequired: 'cópia enviada',
    });
    expect(gate.payload.params).toEqual({ to: ['a@x', 'b@y', 'c@z'] }); // params PROPOSTOS pelo agente

    // APROVAÇÃO pela porta real (conclusão fenced + D28 expectedInstanceRevision).
    const claim = await runtime.userTasks.claim(tenant, gateTaskId, 'aprovador');
    if (!claim.ok) throw new Error('claim falhou');
    const approved = await completeUserTask(api, tenant, gateTaskId, {
      claimToken: claim.claimToken, submission: {}, user: 'aprovador', now: NOW(),
      decision: 'aprovar', expectedInstanceRevision: gateRevision, requestId: 'req-aprova',
    });
    expect(approved.ok).toBe(true);
    await drain(); // roteia ao serviceTask 'enviar' → CreateJob (com gatedBy injetado)

    // EFEITO pelo despacho normal: lock + SELO (staleness ok) + conclusão.
    const [effectJob] = await lockJobs(api, tenant, 'w-eff', { limit: 10, types: ['send-email'] });
    expect(effectJob.payload).toMatchObject({ gatedBy: 'gate', elementId: 'enviar' });
    const inst = await getInstance(api, tenant, instanceId);
    const seal = await withTenant(api, tenant, (tx) =>
      executeGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate',
        revision: inst!.revision, engineVersion: inst!.engine_version,
      }),
    );
    expect(seal).toMatchObject({ executed: true });
    const completed = await runtime.completeJob(tenant, effectJob.id, effectJob.lock_token!, NOW(), { httpStub: true });
    expect(completed.ok).toBe(true);
    await drain();

    // a instância COMPLETA; o SELO está na linha agent:acao do efeito.
    const final = await getInstance(api, tenant, instanceId);
    expect(final!.status).toBe('completed');
    const [acao] = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND effect_key = ${`host:gate-effect:${instanceId}:gate`}`);
    expect(acao.payload.selo).toEqual({
      gateId: 'gate', tool: 'tool:send-email@2.0.1', effectClass: 'external-commitment',
      actor: { type: 'user', id: 'aprovador', requestId: 'req-aprova' }, approvedAt: NOW(),
    });
  });

  it('NEGATIVO reprovar: roteia pela aresta definida, o efeito NÃO executa, a instância segue à rota de reprovação', async () => {
    const { instanceId, gateTaskId, gateRevision } = await driveToGate('gate-proc@1');
    const runtime = createRuntime(api, NOW);
    const claim = await runtime.userTasks.claim(tenant, gateTaskId, 'aprovador');
    if (!claim.ok) throw new Error('claim falhou');
    const rejected = await completeUserTask(api, tenant, gateTaskId, {
      claimToken: claim.claimToken, submission: {}, user: 'aprovador', now: NOW(),
      decision: 'reprovar', expectedInstanceRevision: gateRevision,
    });
    expect(rejected.ok).toBe(true);
    await drain();

    // roteou para fimReprovado → instância completa SEM efeito.
    const final = await getInstance(api, tenant, instanceId);
    expect(final!.status).toBe('completed');
    // NENHUM job de efeito criado; NENHUMA linha agent:acao de efeito.
    const effJobs = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM jobs WHERE instance_id = ${instanceId} AND type = 'send-email'`);
    expect(effJobs).toHaveLength(0);
    const effAcao = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-effect:${instanceId}:gate`}`);
    expect(effAcao).toHaveLength(0);
  });

  it('NEGATIVO staleness: tool alterada entre aprovar e executar → agentToolStale, efeito não executa, gate aprovado na trilha', async () => {
    const { instanceId, gateTaskId, gateRevision } = await driveToGate('gate-stale@1');
    const runtime = createRuntime(api, NOW);
    const claim = await runtime.userTasks.claim(tenant, gateTaskId, 'aprovador');
    if (!claim.ok) throw new Error('claim falhou');
    const approved = await completeUserTask(api, tenant, gateTaskId, {
      claimToken: claim.claimToken, submission: {}, user: 'aprovador', now: NOW(),
      decision: 'aprovar', expectedInstanceRevision: gateRevision, requestId: 'req-stale',
    });
    expect(approved.ok).toBe(true);
    await drain();
    const [effectJob] = await lockJobs(api, tenant, 'w-stale', { limit: 10, types: ['send-email'] });
    expect(effectJob.payload).toMatchObject({ gatedBy: 'gate' });

    // ENTRE aprovar e executar: a tool é DESABILITADA (removida do registry).
    // Com contexto de tenant (FORCE RLS) para o DELETE casar a política.
    await withTenant(migrator, tenant, (tx) =>
      tx`DELETE FROM tool_definitions WHERE ref = 'tool:stale-email@2.0.1'`);

    const inst = await getInstance(api, tenant, instanceId);
    const seal = await withTenant(api, tenant, (tx) =>
      executeGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate',
        revision: inst!.revision, engineVersion: inst!.engine_version,
      }),
    );
    expect(seal).toEqual({ executed: false, reason: 'tool-stale' });

    // incidente agentToolStale; o efeito NÃO executou (sem linha agent:acao de efeito).
    const [inc] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, message FROM incidents WHERE instance_id = ${instanceId} AND kind = 'agentToolStale'`);
    expect(inc.kind).toBe('agentToolStale');
    expect(inc.message).toContain('tool:stale-email@2.0.1');
    const effAcao = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-effect:${instanceId}:gate`}`);
    expect(effAcao).toHaveLength(0);

    // o GATE APROVADO permanece visível na trilha (o humano aprovou de boa-fé).
    const [dec] = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'taskDecision'`);
    expect(dec.payload).toMatchObject({ elementId: 'gate', decision: 'aprovar' });
  });
});
