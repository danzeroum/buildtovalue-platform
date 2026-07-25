import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentFacts, persistAgentTrail, type Classifications } from '../src/agent/agentTrail.js';
import { listInstanceHistory } from '../src/runtime/instances.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Custo REAL na trilha do agente (AG-3.3, triagem do dono). Provas do aceite:
 *  - o objeto de custo grava com priceTableVersion+fxRate (imutável, D30-like);
 *  - grudado no fato 'acao' do nó que gerou o custo — AUSENTE (nunca zero) nos
 *    demais nós/fatos;
 *  - a reserva de RBAC (`operate:read`) é imposta NA PROJEÇÃO do SQL
 *    (`payload - 'cost'`), não só omitida depois — a chave nem existe na
 *    resposta para quem não tem a permissão.
 */
describe('custo do agente na trilha (AG-3.3)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  const classifications: Classifications = { valor: 'none' };
  const COST = {
    cents: 342,
    currency: 'BRL',
    priceTableVersion: 'deepseek-2026-07',
    fxRate: 5.3,
    usage: { inputTokens: 120, outputTokens: 40 },
  };

  beforeAll(async () => {
    db = await createTestDatabase('agent_cost');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ac', 'AgentCost') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'com-agente@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });

    // uma corrida com DOIS nós visitados; só 'llm-review' gerou chamada real.
    const facts = buildAgentFacts({
      io: { output: { aprovado: true } },
      visitedNodes: ['llm-review', 'dec-approve'],
      decisions: ['dec-approve'],
      complete: true,
      costByNode: { 'llm-review': COST },
    });
    await withTenant(api, tenant, (tx) =>
      persistAgentTrail(tx, {
        tenantId: tenant,
        instanceId,
        elementId: 'classificar',
        agentRef: 'agnt-aprova@1.0.0',
        actor: { type: 'agent', id: 'agnt-aprova@1.0.0', requestId: 'job-1' },
        facts,
        classifications,
        engineVersion: 'e',
        revision: 1,
      }),
    );
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('buildAgentFacts grudou o custo SÓ no fato acao do nó que custou', () => {
    const facts = buildAgentFacts({
      io: {},
      visitedNodes: ['llm-review', 'dec-approve'],
      complete: true,
      costByNode: { 'llm-review': COST },
    });
    const acao = facts.filter((f) => f.kind === 'acao');
    expect(acao).toHaveLength(2);
    expect(acao.find((f) => f.nodeId === 'llm-review')?.cost).toEqual(COST);
    // o nó que NÃO gerou custo real: AUSENTE, nunca zero.
    expect(acao.find((f) => f.nodeId === 'dec-approve')?.cost).toBeUndefined();
  });

  it('persistAgentTrail grava o custo no payload (metadado não-pessoal), não no agent_io', async () => {
    const rows = await withTenant(api, tenant, (tx) => tx`
      SELECT kind, payload, agent_io FROM history_events
      WHERE instance_id = ${instanceId} AND kind = 'agent:acao' AND payload->>'nodeId' = 'llm-review'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ cost: COST });
    // agent_io (coluna de I/O mascarado) NUNCA carrega custo — é campo diferente.
    expect(JSON.stringify(rows[0].agent_io ?? {})).not.toContain('priceTableVersion');
  });

  it('o nó sem custo real: o fato NÃO tem a chave cost (ausência honesta)', async () => {
    const [row] = await withTenant(api, tenant, (tx) => tx`
      SELECT payload FROM history_events
      WHERE instance_id = ${instanceId} AND kind = 'agent:acao' AND payload->>'nodeId' = 'dec-approve'`);
    expect('cost' in (row.payload as object)).toBe(false);
  });

  it('canSeeCost=true: listInstanceHistory devolve o custo', async () => {
    const page = await listInstanceHistory(api, tenant, instanceId, { canSeeCost: true });
    const acaoComCusto = page.items.find(
      (i) => i.kind === 'agent:acao' && (i.payload as Record<string, unknown>).nodeId === 'llm-review',
    );
    expect((acaoComCusto?.payload as Record<string, unknown>).cost).toEqual(COST);
  });

  it('canSeeCost=false (ou omitido): a PROJEÇÃO do SQL remove a chave — fail-closed por padrão', async () => {
    const withFalse = await listInstanceHistory(api, tenant, instanceId, { canSeeCost: false });
    const omitted = await listInstanceHistory(api, tenant, instanceId); // sem passar a opção
    for (const page of [withFalse, omitted]) {
      const acao = page.items.find(
        (i) => i.kind === 'agent:acao' && (i.payload as Record<string, unknown>).nodeId === 'llm-review',
      );
      // a chave NEM EXISTE — não é "cost: undefined" no objeto JS, é ausente no jsonb.
      expect('cost' in (acao!.payload as object)).toBe(false);
      expect(JSON.stringify(page.items)).not.toContain('priceTableVersion');
    }
  });
});
