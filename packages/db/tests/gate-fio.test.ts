import type { ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatePayloadTx, sealGatedEffectTx, setGatePayloadTx } from '../src/agent/gateFio.js';
import { deployToolDefinition } from '../src/registry/toolStore.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * O FIO do gate (AG-2.2 etapa 5 slice 3 item 2, D31): world-delta → payload →
 * selo. Além do caminho feliz, os três aceites nomeados pelo dono:
 *   1. degrade: processConsequence null → só as duas dimensões da tool (nunca inferir);
 *   2. selo COMPLETO na linha agent:acao do efeito (prova de auditoria D31);
 *   3. staleness: tool alterada/desabilitada entre aprovar e executar → agentToolStale,
 *      o efeito NÃO executa, e o gate aprovado permanece na trilha.
 */

const sendEmail: ToolContract = {
  kind: 'ToolContract', id: 'tool:send-email', version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: '3 destinatários', authorization: 'gate',
  evidenceRequired: 'cópia enviada', simulation: 'fixture-obrigatoria',
};

/** gate → enviar → [prazo?]. Sem prazo/userTask/end a jusante → consequência null. */
function gateDiagram(withTimer: boolean): BpmnDiagram {
  const d = createDiagram({ name: 'p' });
  d.nodes.gate = (() => {
    const g = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 0, y: 0 });
    g.properties.btvGate = true;
    return g;
  })();
  d.nodes.enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 200, y: 0 });
  d.edges.g1 = createEdge({ id: 'g1', sourceId: 'gate', targetId: 'enviar' });
  if (withTimer) {
    const t = createNode({ id: 'prazo', type: 'intermediateCatchEvent', label: 'Prazo', x: 400, y: 0 });
    t.properties.timer = { kind: 'duration', expression: 'P5D' };
    d.nodes.prazo = t;
    d.edges.g2 = createEdge({ id: 'g2', sourceId: 'enviar', targetId: 'prazo' });
  }
  return d;
}

describe('fio do gate — world-delta → payload → selo (item 2, D31)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  const actor = { type: 'user' as const, id: 'aprovador@acme', requestId: 'req-1' };

  beforeAll(async () => {
    db = await createTestDatabase('gate_fio');
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

  it('caminho feliz: world-delta = contrato resolvido + params + consequência derivada', async () => {
    const wd = await withTenant(api, tenant, (tx) =>
      buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1',
        params: { to: ['a@x', 'b@y', 'c@z'] },
        diagram: gateDiagram(true),
        gateElementId: 'gate',
      }),
    );
    expect(wd).toMatchObject({
      tool: 'tool:send-email@2.0.1', capability: 'enviar e-mail ao cliente',
      effect: 'external-commitment', authorization: 'gate',
      dataScope: '3 destinatários', evidenceRequired: 'cópia enviada',
    });
    expect(wd!.params).toEqual({ to: ['a@x', 'b@y', 'c@z'] });
    expect(wd!.processConsequence).toMatchObject({ source: 'derived', kind: 'timer' });
  });

  it('DEGRADE: processConsequence null → só as duas dimensões da tool (nunca inferir)', async () => {
    const wd = await withTenant(api, tenant, (tx) =>
      buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1',
        params: { to: ['a@x'] },
        diagram: gateDiagram(false), // sem prazo/userTask/end a jusante
        gateElementId: 'gate',
      }),
    );
    // as duas dimensões da tool seguem presentes; a 3ª linha NÃO é inventada.
    expect(wd).toMatchObject({ tool: 'tool:send-email@2.0.1', effect: 'external-commitment' });
    expect(wd!.processConsequence).toBeNull();
  });

  it('setGatePayloadTx grava o world-delta no payload da tarefa de gate', async () => {
    // abre a tarefa de gate (is_gate=true) e injeta o world-delta.
    await withTenant(api, tenant, async (tx) => {
      await tx`INSERT INTO user_tasks (tenant_id, instance_id, element_id, wait_key, form_ref, is_gate)
        VALUES (${tenant}, ${instanceId}, 'gate', ${`w:${instanceId}:gate`}, '', true)`;
      const wd = await buildGatePayloadTx(tx, {
        toolRef: 'tool:send-email@2.0.1', params: { to: ['a@x'] },
        diagram: gateDiagram(true), gateElementId: 'gate',
      });
      await setGatePayloadTx(tx, tenant, instanceId, 'gate', wd!);
    });
    const [row] = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM user_tasks WHERE instance_id = ${instanceId} AND element_id = 'gate'`);
    expect(row.payload).toMatchObject({ tool: 'tool:send-email@2.0.1', authorization: 'gate' });
  });

  it('SELO: efeito fresco → linha agent:acao com selo completo {gateId, tool, effectClass, actor, approvedAt}', async () => {
    const out = await withTenant(api, tenant, (tx) =>
      sealGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate', toolRef: 'tool:send-email@2.0.1',
        actor, approvedAt: '2026-07-24T10:00:00Z', revision: 1, engineVersion: 'e',
      }),
    );
    expect(out).toMatchObject({ executed: true });

    const [row] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'agent:acao'
           AND effect_key = ${`host:gate-effect:${instanceId}:gate`}`);
    expect(row.kind).toBe('agent:acao');
    // o selo é a prova D31 — completo, não enfeite.
    expect(row.payload.selo).toEqual({
      gateId: 'gate', tool: 'tool:send-email@2.0.1', effectClass: 'external-commitment',
      actor: { type: 'user', id: 'aprovador@acme', requestId: 'req-1' },
      approvedAt: '2026-07-24T10:00:00Z',
    });
  });

  it('STALENESS: tool inexistente no aval → agentToolStale (incidente), efeito NÃO executa, gate aprovado permanece', async () => {
    // simula "gate aprovado" na trilha ANTES da execução (o humano aprovou de boa-fé).
    await withTenant(api, tenant, (tx) =>
      tx`INSERT INTO history_events (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
         VALUES (${tenant}, ${instanceId}, 54000, 'agent:acao',
                 ${tx.json({ elementId: 'gate2', message: 'gate aprovado', actor } as never)}, 'e',
                 ${`host:gate-approved:${instanceId}:gate2`})`);

    const out = await withTenant(api, tenant, (tx) =>
      sealGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate2',
        toolRef: 'tool:fantasma@9.9.9', // NÃO existe no registry → stale
        actor, approvedAt: '2026-07-24T11:00:00Z', revision: 1, engineVersion: 'e',
      }),
    );
    expect(out).toEqual({ executed: false, reason: 'tool-stale' });

    // incidente agentToolStale (vermelho), com o ref da tool na mensagem.
    const [inc] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, message, payload FROM incidents
         WHERE instance_id = ${instanceId} AND kind = 'agentToolStale'`);
    expect(inc.kind).toBe('agentToolStale');
    expect(inc.message).toContain('tool:fantasma@9.9.9');
    expect(inc.payload).toMatchObject({ toolRef: 'tool:fantasma@9.9.9', gateId: 'gate2' });

    // o efeito NÃO executou: nenhuma linha agent:acao do efeito para gate2.
    const effect = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-effect:${instanceId}:gate2`}`);
    expect(effect).toHaveLength(0);

    // o gate APROVADO permanece visível na trilha (a falha é posterior ao aval).
    const approved = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-approved:${instanceId}:gate2`}`);
    expect(approved).toHaveLength(1);
  });
});
