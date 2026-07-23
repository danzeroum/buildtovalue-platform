import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertEffects, dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { listUserTasks, type TaskViewer } from '../src/runtime/userTasks.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * MARCADOR DE GATE consultável + FILTRO da Tasklist (AG-2.2 etapa 5 slice 3,
 * item 1, D31). Duas provas:
 *
 *  1. o marcador is_gate é RESOLVIDO no despacho do OpenUserTask contra a
 *     DEFINIÇÃO PINADA da instância (btvGate do nó) — não se infere no query;
 *  2. o gate de tool NÃO aparece como tarefa comum na Tasklist de negócio
 *     (o modo-agente da fila é AG-3); só volta com includeGates=true (Operate).
 */

/** processo com um GATE (btvGate) e uma userTask COMUM (triagem). */
function twoTaskDiagram(): BpmnDiagram {
  const d = createDiagram({ name: 'gateproc' });
  const triagem = createNode({ id: 'triagem', type: 'userTask', label: 'Triagem', x: 0, y: 0 });
  triagem.properties.formRef = 'form:triagem@1'; // comum: tem form, NÃO é gate
  d.nodes.triagem = triagem;
  const gate = createNode({ id: 'gate', type: 'userTask', label: 'Aprovar envio', x: 200, y: 0 });
  gate.properties.btvGate = true; // GATE de tool
  d.nodes.gate = gate;
  d.nodes.enviar = createNode({ id: 'enviar', type: 'serviceTask', label: 'Enviar', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'triagem', targetId: 'gate' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'gate', targetId: 'enviar' });
  return d;
}

describe('marcador de gate + filtro da Tasklist (D31, item 1)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  // operador enxerga tudo (Operate); a visibilidade por papel não mascara aqui.
  const operator: TaskViewer = { sub: 'op', role: 'operator', seesAll: true };

  beforeAll(async () => {
    db = await createTestDatabase('gate_tasklist');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    await withTenant(migrator, tenant, async (tx) => {
      // DEFINIÇÃO PINADA: registry_ref = 'gateproc@1' (a instância aponta para ela).
      await tx`INSERT INTO process_definitions
          (tenant_id, name, version, registry_ref, diagram, engine_version)
        VALUES (${tenant}, 'gateproc', 1, 'gateproc@1', ${tx.json(twoTaskDiagram() as never)}, 'e')`;
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'gateproc@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('is_gate é resolvido no despacho contra a definição pinada (btvGate do nó)', async () => {
    // despacha os dois OpenUserTask pela outbox — o mesmo caminho de produção.
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, instanceId, [
        { effectKey: `k:${instanceId}:triagem`, effect: { type: 'OpenUserTask', elementId: 'triagem', waitKey: `w:${instanceId}:triagem`, formRef: 'form:triagem@1', candidates: [] } },
        { effectKey: `k:${instanceId}:gate`, effect: { type: 'OpenUserTask', elementId: 'gate', waitKey: `w:${instanceId}:gate`, formRef: '', candidates: [] } },
      ]),
    );
    await dispatchOutboxOnce(api, tenant);

    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT element_id, is_gate FROM user_tasks WHERE instance_id = ${instanceId} ORDER BY element_id`);
    const byId = Object.fromEntries(rows.map((r) => [r.element_id, r.is_gate]));
    expect(byId).toEqual({ gate: true, triagem: false }); // btvGate → true; comum → false
  });

  it('a Tasklist de negócio EXCLUI o gate; includeGates=true traz de volta (Operate)', async () => {
    // padrão: gate some da fila comum — só a triagem aparece.
    const common = await listUserTasks(api, tenant, operator, {});
    expect(common.items.map((i) => i.element_id).sort()).toEqual(['triagem']);
    expect(common.items.every((i) => i.is_gate === false)).toBe(true);

    // Operate/superfície de gate: includeGates=true traz o gate também.
    const withGates = await listUserTasks(api, tenant, operator, { includeGates: true });
    expect(withGates.items.map((i) => i.element_id).sort()).toEqual(['gate', 'triagem']);
    const gateItem = withGates.items.find((i) => i.element_id === 'gate');
    expect(gateItem?.is_gate).toBe(true);
  });

  it('degrade honesto: definição embutida (sem registry) → is_gate false (sem gate ali)', async () => {
    // instância de definição embutida (skeleton@1 não está no process_definitions):
    // a resolução não acha linha → COALESCE false, nunca erro.
    const otherInstance = await withTenant(api, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'skeleton@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    await withTenant(api, tenant, (tx) =>
      insertEffects(tx, tenant, otherInstance, [
        { effectKey: `k:${otherInstance}:t`, effect: { type: 'OpenUserTask', elementId: 't', waitKey: `w:${otherInstance}:t`, formRef: 'form:x@1', candidates: [] } },
      ]),
    );
    await dispatchOutboxOnce(api, tenant);
    const [row] = await withTenant(api, tenant, (tx) =>
      tx`SELECT is_gate FROM user_tasks WHERE instance_id = ${otherInstance}`);
    expect(row.is_gate).toBe(false);
  });
});
