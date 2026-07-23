import type { ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPROPOSAL_CAP,
  checkToolFresh,
  effectSelo,
  getGateState,
  recordGateProposal,
  requestReproposal,
  verifyProposalFresh,
} from '../src/agent/gate.js';
import { buildWorldDelta, deriveProcessConsequence } from '../src/agent/worldDelta.js';
import { deployToolDefinition, getToolDefinitionByRefTx } from '../src/registry/toolStore.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const sendEmail: ToolContract = {
  kind: 'ToolContract', id: 'tool:send-email', version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: '3 destinatários', authorization: 'gate',
  evidenceRequired: 'cópia enviada', simulation: 'fixture-obrigatoria',
};

/** gate → [após] onde `after` decide a consequência estrutural. */
function gateDiagram(after: 'timer' | 'userTask' | 'endEvent' | 'none', note?: string): BpmnDiagram {
  const d = createDiagram({ name: 'p' });
  const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 0, y: 0 });
  gate.properties.btvGate = true;
  if (note) gate.properties.consequenceNote = note;
  d.nodes.gate = gate;
  d.nodes.enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 200, y: 0 });
  d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gate', targetId: 'enviar' });
  if (after === 'timer') {
    const t = createNode({ id: 'prazo', type: 'intermediateCatchEvent', label: 'Prazo', x: 400, y: 0 });
    t.properties.timer = { kind: 'duration', expression: 'P5D' };
    d.nodes.prazo = t;
    d.edges.g2 = createEdge({ id: 'g2', sourceId: 'enviar', targetId: 'prazo' });
  } else if (after === 'userTask') {
    d.nodes.aguardar = createNode({ id: 'aguardar', type: 'userTask', label: 'Aguardar resposta', x: 400, y: 0 });
    d.edges.g2 = createEdge({ id: 'g2', sourceId: 'enviar', targetId: 'aguardar' });
  } else if (after === 'endEvent') {
    d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'fim', x: 400, y: 0 });
    d.edges.g2 = createEdge({ id: 'g2', sourceId: 'enviar', targetId: 'fim' });
  }
  return d;
}

describe('AG-2.2 etapa 5 slice 2 — world-delta + ciclo do gate (D31/D28)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('gate_runtime');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployToolDefinition(api, tenant, { contract: sendEmail });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('world-delta = contrato resolvido 1× + params + consequência (schema P1 congelado)', async () => {
    const tool = await withTenant(api, tenant, (tx) => getToolDefinitionByRefTx(tx, 'tool:send-email@2.0.1'));
    const consequence = deriveProcessConsequence(gateDiagram('timer'), 'gate');
    const wd = buildWorldDelta({
      toolRef: tool!.ref, capability: tool!.capability, effect: tool!.effect,
      authorization: tool!.authorization, dataScope: tool!.data_scope,
      evidenceRequired: tool!.contract.evidenceRequired, params: { to: ['a@x', 'b@y', 'c@z'] },
      processConsequence: consequence,
    });
    expect(wd).toMatchObject({
      tool: 'tool:send-email@2.0.1', effect: 'external-commitment', authorization: 'gate',
      dataScope: '3 destinatários', evidenceRequired: 'cópia enviada',
    });
    expect(wd.params).toEqual({ to: ['a@x', 'b@y', 'c@z'] });
  });

  it('consequência: anotada > estrutural (timer/userTask/endEvent) > degrade honesto (null)', () => {
    expect(deriveProcessConsequence(gateDiagram('timer', 'abre prazo de 5 dias úteis'), 'gate')).toMatchObject({
      source: 'annotated', description: 'abre prazo de 5 dias úteis',
    });
    expect(deriveProcessConsequence(gateDiagram('timer'), 'gate')).toMatchObject({ source: 'derived', kind: 'timer' });
    expect(deriveProcessConsequence(gateDiagram('userTask'), 'gate')).toMatchObject({ source: 'derived', kind: 'userTask' });
    expect(deriveProcessConsequence(gateDiagram('endEvent'), 'gate')).toMatchObject({ source: 'derived', kind: 'endEvent' });
    // sem regra estrutural nem anotação → null (nunca inferir consequência frouxa)
    expect(deriveProcessConsequence(gateDiagram('none'), 'gate')).toBeNull();
  });

  it('D28 re-verify: proposta fresca vs. expirada (a instância avançou)', async () => {
    await withTenant(api, tenant, (tx) => recordGateProposal(tx, tenant, instanceId, 'gate-a', 7));
    const state = await withTenant(api, tenant, (tx) => getGateState(tx, instanceId, 'gate-a'));
    expect(verifyProposalFresh(state!, 7).fresh).toBe(true);   // não avançou → vale
    expect(verifyProposalFresh(state!, 9).fresh).toBe(false);  // avançou → expirou (voz própria)
  });

  it('reproposta: ação explícita + CAP DURO por elemento (Q4)', async () => {
    await withTenant(api, tenant, (tx) => recordGateProposal(tx, tenant, instanceId, 'gate-b', 1));
    // reproposta explícita até o cap; cada uma re-abre com nova revisão
    for (let i = 1; i <= REPROPOSAL_CAP; i++) {
      const out = await withTenant(api, tenant, (tx) => requestReproposal(tx, tenant, instanceId, 'gate-b', 1 + i));
      expect(out).toMatchObject({ ok: true, count: i });
    }
    // estourou o cap → parada honesta (reavaliação manual), nunca laço infinito
    const over = await withTenant(api, tenant, (tx) => requestReproposal(tx, tenant, instanceId, 'gate-b', 99));
    expect(over).toMatchObject({ ok: false, reason: 'cap-exceeded' });
  });

  it('selo de procedência do efeito (gate id + ator + momento + tool/classe)', () => {
    const selo = effectSelo({
      gateId: 'gate-x', tool: 'tool:send-email@2.0.1', effectClass: 'external-commitment',
      actor: { type: 'user', id: 'aprovador@acme', requestId: 'req-1' }, approvedAt: '2026-07-24T10:00:00Z',
    });
    expect(selo).toMatchObject({ gateId: 'gate-x', tool: 'tool:send-email@2.0.1', effectClass: 'external-commitment' });
    expect(selo.actor).toMatchObject({ type: 'user', id: 'aprovador@acme' });
  });

  it('staleness de tool: aprovada mas despublicada/inexistente desde o aval → stale (4ª voz)', async () => {
    const fresh = await withTenant(api, tenant, (tx) => checkToolFresh(tx, 'tool:send-email@2.0.1'));
    expect(fresh.fresh).toBe(true);
    const stale = await withTenant(api, tenant, (tx) => checkToolFresh(tx, 'tool:fantasma@1.0.0'));
    expect(stale.fresh).toBe(false);
  });
});
