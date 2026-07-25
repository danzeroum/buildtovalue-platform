import type { ToolContract } from '@buildtovalue/agentflow';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealGatedEffectTx } from '../src/agent/gateFio.js';
import { deployProcessDefinition } from '../src/registry/store.js';
import { deployToolDefinition, listTenantTools, setTenantToolEnabled } from '../src/registry/toolStore.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * P5 (AG-3.4, shape `ag3-4-shape-proposta-p5-tools.md`). `tenant_tools.enabled`
 * não era lido em NENHUM lugar (achado §1) — o enforcement entra em DOIS
 * pontos (lint de deploy + runtime), decisão do dono. Aceite nomeado (§1.3):
 *  1. deploy que referencia tool desabilitada → recusado (EXEC_TOOL_DISABLED).
 *  2. tool desabilitada NO MEIO de uma instância em voo → o próximo efeito para
 *     honestamente (agentToolDisabled, âmbar, nunca vermelho, nunca silencioso).
 *  3. catálogo com enabled:false honesto (sem linha = false, não erro).
 *  5. D31 intacto: habilitar tool nunca muda effect/authorization.
 */
const sendEmail: ToolContract = {
  kind: 'ToolContract', id: 'tool:send-email', version: '2.0.1', name: 'send_email',
  capability: 'enviar e-mail ao cliente', inputSchema: { to: { type: 'string' } }, outputSchema: {},
  effect: 'external-commitment', dataScope: '3 destinatários', authorization: 'gate',
  evidenceRequired: 'cópia enviada', simulation: 'fixture-obrigatoria',
};

const forbiddenTool: ToolContract = {
  kind: 'ToolContract', id: 'tool:apagar-tudo', version: '1.0.0', name: 'apagar_tudo',
  capability: 'apagar dados do tenant', inputSchema: {}, outputSchema: {},
  effect: 'write-irreversible', dataScope: 'tudo', authorization: 'proibida',
  evidenceRequired: 'nenhuma', simulation: 'fixture-obrigatoria',
};

const actor = { type: 'user' as const, id: 'admin@acme', requestId: 'r1' };

/** enviar (serviceTask com toolRef pinado) → gate (btv:gate reachable a jusante, cobre EXEC_TOOL_EFFECT_UNGATED). */
function gateDiagram(toolRef: string): BpmnDiagram {
  const d = createDiagram({ name: 'p' });
  const enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 0, y: 0 });
  enviar.properties.jobType = 'tool';
  enviar.properties.toolRef = toolRef;
  d.nodes.enviar = enviar;
  const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 200, y: 0 });
  gate.properties.btvGate = true;
  d.nodes.gate = gate;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'fim', x: 400, y: 0 });
  d.edges.g1 = createEdge({ id: 'g1', sourceId: 'enviar', targetId: 'gate' });
  d.edges.g2 = createEdge({ id: 'g2', sourceId: 'gate', targetId: 'fim' });
  return d;
}

describe('P5 (AG-3.4) — catálogo + enforcement (deploy-lint + runtime) de tools por tenant', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  beforeAll(async () => {
    db = await createTestDatabase('tool_enablement');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('tl', 'ToolCo') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
    await deployToolDefinition(api, tenant, { contract: sendEmail });
    await deployToolDefinition(api, tenant, { contract: forbiddenTool });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('catálogo: sem linha em tenant_tools = enabled:false HONESTO (não erro); requiresGate computado ao vivo', async () => {
    const items = await listTenantTools(api, tenant);
    const email = items.find((i) => i.toolId === 'tool:send-email')!;
    expect(email).toMatchObject({ enabled: false, requiresGate: true, effect: 'external-commitment', authorization: 'gate' });
  });

  it('deploy que referencia tool DESABILITADA → recusado (EXEC_TOOL_DISABLED)', async () => {
    const out = await deployProcessDefinition(api, tenant, {
      name: 'p-tool-desabilitada', engineVersion: 'e', diagram: gateDiagram('tool:send-email@2.0.1'),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.some((i) => i.code === 'EXEC_TOOL_DISABLED')).toBe(true);
  });

  it('habilitando a tool, o MESMO deploy passa a ser aceito', async () => {
    const enabled = await setTenantToolEnabled(api, tenant, 'tool:send-email', true, actor, 'habilitada para o piloto');
    expect(enabled).toMatchObject({ ok: true, tool: { toolId: 'tool:send-email', enabled: true } });

    const out = await deployProcessDefinition(api, tenant, {
      name: 'p-tool-habilitada', engineVersion: 'e', diagram: gateDiagram('tool:send-email@2.0.1'),
    });
    expect(out.ok).toBe(true);

    // D31 intacto: habilitar NÃO mudou effect/authorization do contrato.
    const items = await listTenantTools(api, tenant);
    expect(items.find((i) => i.toolId === 'tool:send-email')).toMatchObject({
      enabled: true, effect: 'external-commitment', authorization: 'gate', requiresGate: true,
    });
  });

  it("D31: ligar tool 'proibida' → TOOL_FORBIDDEN (invariante da plataforma, não decisão de tenant)", async () => {
    const out = await setTenantToolEnabled(api, tenant, 'tool:apagar-tudo', true, actor, 'preciso mesmo assim');
    expect(out).toEqual({ ok: false, code: 'TOOL_FORBIDDEN' });
    const items = await listTenantTools(api, tenant);
    expect(items.find((i) => i.toolId === 'tool:apagar-tudo')).toMatchObject({ enabled: false, authorization: 'proibida' });
  });

  it('toolId inexistente → TOOL_NOT_FOUND', async () => {
    const out = await setTenantToolEnabled(api, tenant, 'tool:fantasma', true, actor, 'x');
    expect(out).toEqual({ ok: false, code: 'TOOL_NOT_FOUND' });
  });

  it('RUNTIME: tool desabilitada NO MEIO de uma instância em voo → próximo efeito para HONESTAMENTE (agentToolDisabled, âmbar, sem efeito)', async () => {
    // simula "gate aprovado" na trilha (o humano aprovou de boa-fé, ANTES da desabilitação).
    await withTenant(api, tenant, (tx) =>
      tx`INSERT INTO history_events (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
         VALUES (${tenant}, ${instanceId}, 54000, 'agent:acao',
                 ${tx.json({ elementId: 'gate-live', message: 'gate aprovado', actor } as never)}, 'e',
                 ${`host:gate-approved:${instanceId}:gate-live`})`);

    // tool:send-email está HABILITADA (teste anterior) — desabilita agora, "no meio do voo".
    await setTenantToolEnabled(api, tenant, 'tool:send-email', false, actor, 'integração comprometida — desabilitando por segurança');

    const seal = await withTenant(api, tenant, (tx) =>
      sealGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate-live', toolRef: 'tool:send-email@2.0.1',
        actor, approvedAt: '2026-07-24T10:00:00Z', revision: 1, engineVersion: 'e',
      }),
    );
    expect(seal).toEqual({ executed: false, reason: 'tool-disabled' });

    // incidente PRÓPRIO agentToolDisabled (âmbar — nunca reaproveita agentToolStale).
    const [inc] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, message, payload FROM incidents
         WHERE instance_id = ${instanceId} AND kind = 'agentToolDisabled'`);
    expect(inc.kind).toBe('agentToolDisabled');
    expect(inc.message).toContain('tool:send-email@2.0.1');
    expect(inc.payload).toMatchObject({ toolRef: 'tool:send-email@2.0.1', gateId: 'gate-live' });

    // o efeito NÃO executou: nenhuma linha agent:acao do efeito.
    const effect = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-effect:${instanceId}:gate-live`}`);
    expect(effect).toHaveLength(0);

    // o gate APROVADO permanece visível na trilha (a falha é posterior ao aval de boa-fé).
    const approved = await withTenant(api, tenant, (tx) =>
      tx`SELECT 1 FROM history_events WHERE effect_key = ${`host:gate-approved:${instanceId}:gate-live`}`);
    expect(approved).toHaveLength(1);
  });

  it('reabilitando a tool, o MESMO efeito passa a executar (retryable pelo mecanismo já existente)', async () => {
    await setTenantToolEnabled(api, tenant, 'tool:send-email', true, actor, 'integração restaurada');
    const seal = await withTenant(api, tenant, (tx) =>
      sealGatedEffectTx(tx, {
        tenantId: tenant, instanceId, gateElementId: 'gate-live', toolRef: 'tool:send-email@2.0.1',
        actor, approvedAt: '2026-07-24T10:00:00Z', revision: 1, engineVersion: 'e',
      }),
    );
    expect(seal).toMatchObject({ executed: true });
  });
});
