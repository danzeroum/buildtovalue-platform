import type { ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatePayloadTx, revealGateParamsTx, setGatePayloadTx } from '../src/agent/gateFio.js';
import { maskWorldDelta } from '../src/agent/worldDelta.js';
import { deployToolDefinition } from '../src/registry/toolStore.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * PII no world-delta (AG-3.1). O gate carrega dado pessoal (destinatários,
 * conteúdo proposto). Prova que:
 *   1. a classificação é HERDADA da variável proposalVar (sensitive → mascarado);
 *   2. a VISÃO do aprovador esconde os VALORES sensíveis, mantendo nomes/contagem;
 *   3. revelar é AUDITADO (evento com NOMES, nunca o conteúdo) e só p/ sensível.
 * O world-delta NÃO é um caminho paralelo que escapa do D20.
 */
const sendEmail: ToolContract = {
  kind: 'ToolContract', id: 'tool:send-email', version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: 'pessoal', authorization: 'gate',
  evidenceRequired: 'cópia enviada', simulation: 'fixture-obrigatoria',
};

function gateDiagram(): BpmnDiagram {
  const d = createDiagram({ name: 'p' });
  const g = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 0, y: 0 });
  g.properties.btvGate = true;
  d.nodes.gate = g;
  d.nodes.enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 200, y: 0 });
  d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gate', targetId: 'enviar' });
  return d;
}

const SENSITIVE_PARAMS = { to: ['ana@x.com', 'bruno@y.com'], corpo: 'dados do cliente' };

describe('PII do world-delta (AG-3.1) — herança + máscara + reveal auditado', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('gate_pii');
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

  it('HERANÇA: proposalVar sensitive → world-delta.paramsClassification = sensitive', async () => {
    const wd = await withTenant(api, tenant, (tx) =>
      buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1', params: SENSITIVE_PARAMS,
        diagram: gateDiagram(), gateElementId: 'gate',
        paramsClassification: 'sensitive',
      }),
    );
    expect(wd!.paramsClassification).toBe('sensitive');
  });

  it('MÁSCARA: a visão do aprovador esconde os VALORES, mantém nomes + contagem', () => {
    const wd = {
      tool: 'tool:send-email@2.0.1', capability: 'x', effect: 'external-commitment' as const,
      authorization: 'gate' as const, dataScope: 'pessoal', evidenceRequired: 'e',
      params: SENSITIVE_PARAMS, processConsequence: null, paramsClassification: 'sensitive' as const,
    };
    const view = maskWorldDelta(wd);
    expect(view.paramsMasked).toBe(true);
    expect(view.paramsFields).toEqual(['to', 'corpo']); // nomes (estrutura) — seguros
    expect(view.delta.params).toEqual({}); // VALORES fora
    // o PII não aparece em lugar nenhum da visão mascarada
    expect(JSON.stringify(view)).not.toContain('ana@x.com');
    expect(JSON.stringify(view)).not.toContain('dados do cliente');
    // as dimensões não-PII seguem em claro
    expect(view.delta.effect).toBe('external-commitment');
  });

  it('NÃO-sensível sai em claro (personal/none não mascara)', () => {
    const wd = {
      tool: 't', capability: 'x', effect: 'read' as const, authorization: 'automatica' as const,
      dataScope: 'publico', evidenceRequired: 'e', params: { n: 3 }, processConsequence: null,
      paramsClassification: 'personal' as const,
    };
    const view = maskWorldDelta(wd);
    expect(view.paramsMasked).toBe(false);
    expect(view.delta.params).toEqual({ n: 3 });
  });

  it('REVEAL: só p/ sensível, AUDITADO com nomes (nunca o conteúdo), devolve os valores', async () => {
    // grava um gate com params sensíveis
    await withTenant(api, tenant, async (tx) => {
      await tx`INSERT INTO user_tasks (tenant_id, instance_id, element_id, wait_key, form_ref, is_gate)
        VALUES (${tenant}, ${instanceId}, 'gate', ${`w:${instanceId}:gate`}, '', true)`;
      const wd = await buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1', params: SENSITIVE_PARAMS,
        diagram: gateDiagram(), gateElementId: 'gate', paramsClassification: 'sensitive',
      });
      await setGatePayloadTx(tx, tenant, instanceId, 'gate', wd!);
    });

    const out = await withTenant(api, tenant, (tx) =>
      revealGateParamsTx(tx, tenant, instanceId, 'gate', { actor: 'aprovador@acme', reason: 'preciso ver os destinatários' }),
    );
    expect(out).toEqual({ ok: true, params: SENSITIVE_PARAMS });

    // evento de auditoria com NOMES apenas — o conteúdo revelado NÃO entra no evento.
    const [ev] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'gateWorldDeltaRevealed'`);
    expect(ev.kind).toBe('gateWorldDeltaRevealed');
    expect(ev.payload).toMatchObject({ gateId: 'gate', actor: 'aprovador@acme', reason: 'preciso ver os destinatários', fields: ['to', 'corpo'] });
    expect(JSON.stringify(ev.payload)).not.toContain('ana@x.com'); // evidência ≠ conteúdo
  });

  it('REVEAL recusa gate com params NÃO sensíveis (já saem em claro)', async () => {
    await withTenant(api, tenant, async (tx) => {
      await tx`INSERT INTO user_tasks (tenant_id, instance_id, element_id, wait_key, form_ref, is_gate)
        VALUES (${tenant}, ${instanceId}, 'gate-claro', ${`w:${instanceId}:gate-claro`}, '', true)`;
      const wd = await buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1', params: { n: 1 },
        diagram: gateDiagram(), gateElementId: 'gate-claro', paramsClassification: 'personal',
      });
      // grava manualmente no element certo
      await tx`UPDATE user_tasks SET payload = ${tx.json(wd as never)}
        WHERE instance_id = ${instanceId} AND element_id = 'gate-claro'`;
    });
    const out = await withTenant(api, tenant, (tx) =>
      revealGateParamsTx(tx, tenant, instanceId, 'gate-claro', { actor: 'x', reason: 'y' }),
    );
    expect(out).toMatchObject({ ok: false, reason: 'notMasked' });
  });
});
