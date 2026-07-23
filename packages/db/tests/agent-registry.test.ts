import { APPROVAL_GATE_AGENT, validateGraph, type AgentWorkflow } from '@buildtovalue/agentflow';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareSemver,
  deployAgentDefinition,
  getAgentDefinitionByRef,
  listAgentDefinitions,
  resolveAgentRef,
} from '../src/registry/agentStore.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Registry de AGENTES (AG-2.2 etapa 3 [GATE + MIGRAÇÃO]). Espelha o registry de
 * process/form: deploy IMUTÁVEL com `validateGraph` no gate, `ref` (id@version)
 * como PIN, resolução pinada vs. flutuante (latest-per-name por semver).
 */
function graphAt(id: string, version: string, mutate?: (g: AgentWorkflow) => void): AgentWorkflow {
  const g: AgentWorkflow = structuredClone(APPROVAL_GATE_AGENT);
  g.id = id;
  g.version = version;
  mutate?.(g);
  return g;
}

describe('AgentRegistry — deploy imutável + pin + resolução (AG-2.2 etapa 3)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase('agent_registry');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('compareSemver ordena numericamente (10.0.0 > 9.0.0, não lexical)', () => {
    expect(compareSemver('10.0.0', '9.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('deploy VÁLIDO grava com ref canônica; template passa no gate', async () => {
    const out = await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-aprova', '1.0.0') });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.definition.ref).toBe('agnt-aprova@1.0.0');
      expect(out.definition.agent_id).toBe('agnt-aprova');
      expect(out.definition.autonomy_level).toBe(APPROVAL_GATE_AGENT.autonomyLevel);
    }
  });

  it('GATE: grafo com issue de erro (validateGraph) → NADA gravado', async () => {
    // promptRef inválido → PROMPT_REF_INVALID (error) bloqueia a promoção.
    const bad = graphAt('agnt-ruim', '1.0.0', (g) => {
      const llm = g.nodes.find((n) => n.type === 'llm');
      if (llm && llm.type === 'llm') llm.config.promptRef = 'sem-arroba';
    });
    expect(validateGraph(bad).some((i) => i.severity === 'error')).toBe(true);
    const out = await deployAgentDefinition(api, tenant, { graph: bad });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.some((i) => i.severity === 'error')).toBe(true);
    // nada gravado: o id não resolve
    expect(await getAgentDefinitionByRef(api, tenant, 'agnt-ruim@1.0.0')).toBeUndefined();
  });

  it('IMUTÁVEL: re-deploy da MESMA versão é recusado (UNIQUE ref)', async () => {
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-imut', '1.0.0') });
    await expect(
      deployAgentDefinition(api, tenant, { graph: graphAt('agnt-imut', '1.0.0') }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('PIN: ref pinada resolve a versão exata verbatim', async () => {
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-rsch', '1.0.0') });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-rsch', '2.0.0') });
    const pinned = await resolveAgentRef(api, tenant, 'agnt-rsch@1.0.0');
    expect(pinned).not.toBeNull();
    expect(pinned?.floating).toBe(false);
    expect(pinned?.pinnedRef).toBe('agnt-rsch@1.0.0');
    expect(pinned?.definition.version).toBe('1.0.0');
  });

  it('FLUTUANTE: ref sem versão resolve latest-per-name por SEMVER', async () => {
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-flut', '1.0.0') });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-flut', '9.0.0') });
    await deployAgentDefinition(api, tenant, { graph: graphAt('agnt-flut', '10.0.0') });
    const resolved = await resolveAgentRef(api, tenant, 'agnt-flut');
    expect(resolved).not.toBeNull();
    expect(resolved?.floating).toBe(true);
    // 10.0.0 vence (semver, não lexical — lexical daria 9.0.0)
    expect(resolved?.pinnedRef).toBe('agnt-flut@10.0.0');
  });

  it('ref (pinada ou flutuante) de agente inexistente → null', async () => {
    expect(await resolveAgentRef(api, tenant, 'agnt-fantasma@1.0.0')).toBeNull();
    expect(await resolveAgentRef(api, tenant, 'agnt-fantasma')).toBeNull();
  });

  it('listAgentDefinitions traz UMA linha por id (a maior versão)', async () => {
    const list = await listAgentDefinitions(api, tenant);
    const flut = list.filter((d) => d.agent_id === 'agnt-flut');
    expect(flut).toHaveLength(1);
    expect(flut[0].version).toBe('10.0.0');
    // sem duplicatas de id no catálogo
    expect(new Set(list.map((d) => d.agent_id)).size).toBe(list.length);
  });

  it('IMUTABILIDADE por permissão: app_api não faz UPDATE/DELETE em agent_definitions', async () => {
    await expect(
      api.unsafe(`UPDATE agent_definitions SET name = name WHERE false`),
    ).rejects.toThrow(/permission denied/i);
    await expect(api.unsafe(`DELETE FROM agent_definitions WHERE false`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});
