import { APPROVAL_GATE_AGENT, type AgentWorkflow, type Fixtures } from '@buildtovalue/agentflow';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isHonestStop,
  runAgentJob,
  simulateWalker,
  type AgentGraphResolver,
  type AgentWalker,
} from '../src/agent/agentRunner.js';
import { setKillSwitch, upsertTenantAiConfig } from '../src/agent/tenantAiConfig.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * AgentRunner etapa 2: CAMINHA o grafo agentflow (simulate no CI), parada honesta
 * EM EXECUÇÃO (kill-switch entre passos, §5.2) + budget, com trilha PARCIAL
 * sempre preservada. Grafo GOVERNADO por resolver injetado (registry, etapa 3 —
 * o caminho de grafo-em-payload foi deletado). Determinístico — o CI nunca
 * chama LLM real (D27).
 */
describe('AgentRunner — walk + parada honesta em execução (AG-2.2 etapa 2)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;
  const actor = { type: 'user' as const, id: 'admin', requestId: 'r1' };

  // fixtures determinísticas do template (llm-review devolve saída estruturada)
  const fixtures: Fixtures = { 'llm-review': { outputs: [{ approved: true, rationale: 'ok' }] } };
  const graph = APPROVAL_GATE_AGENT;
  // Resolver GOVERNADO (etapa 3): o grafo vem do "registry" (aqui o template,
  // via closure) — o caminho de grafo-em-payload foi deletado (§2.10).
  const governedResolver: AgentGraphResolver = async () => ({ graph });

  async function configWith(budgetCents?: number): Promise<void> {
    await upsertTenantAiConfig(
      api,
      tenant,
      { provider: 'anthropic', model: 'claude', keyRef: 'secret://kms/ag/anthropic', budgetCents },
      actor,
    );
  }

  beforeAll(async () => {
    db = await createTestDatabase('agent_runner');
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

  it('walk completo (simulate + fixtures) → resultado determinístico + trilha', async () => {
    await configWith();
    const out = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-approval-gate@1.0.0', fixtures, elementId: 'classificar' },
      { resolveGraph: governedResolver, walker: simulateWalker },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.walk.complete).toBe(true);
      expect(out.walk.visitedNodes).toContain('llm-review');
      expect(out.result).toMatchObject({ approved: true });
    }
  });

  it('BUDGET: unidade travada — budget_cents/100 = maxCostBRL, precificado em BRL', async () => {
    // DEFAULT_COST_MODEL: 1 chamada llm = 1000 tokens = 0,05 BRL = 5 centavos.
    // 3 centavos (0,03 BRL) < 0,05 → parada honesta de budget no nó llm.
    await configWith(3);
    const tight = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-approval-gate@1.0.0', fixtures, elementId: 'classificar' },
      { resolveGraph: governedResolver, walker: simulateWalker },
    );
    expect(tight).toMatchObject({ ok: false, blocked: 'budget' });
    if (!tight.ok) {
      expect(tight.message).toMatch(/budget/i);
      expect(tight.walk.blocked?.cell).toBe('budget');
    }
    // 10 centavos (0,10 BRL) > 0,05 → completa. Confirma a unidade (não 100x errado).
    await configWith(10);
    const ample = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-approval-gate@1.0.0', fixtures, elementId: 'classificar' },
      { resolveGraph: governedResolver, walker: simulateWalker },
    );
    expect(ample.ok).toBe(true);
  });

  it('§5.2 kill-switch EM EXECUÇÃO (run passo-a-passo): walk para, trilha PARCIAL preservada', async () => {
    await configWith();
    // walker fake passo-a-passo: checa shouldStop ENTRE passos e, após o 1º nó,
    // um operador aciona o kill-switch (interleave real). O 2º shouldStop lê a
    // config viva → 'kill-switch' → para honesto com a trilha do que já rodou.
    const stepwise: AgentWalker = async (wf: AgentWorkflow, opts) => {
      const visited: string[] = [];
      for (let i = 0; i < wf.nodes.length; i++) {
        const stop = await opts.shouldStop();
        if (stop) return { visitedNodes: visited, steps: visited.length, stopped: stop, blocked: null, complete: false };
        visited.push(wf.nodes[i].id);
        if (i === 0) await setKillSwitch(api, tenant, true, actor, 'custo anômalo em execução');
      }
      return { visitedNodes: visited, steps: visited.length, stopped: null, blocked: null, complete: true, output: {} };
    };
    const out = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-approval-gate@1.0.0', elementId: 'classificar' },
      { resolveGraph: governedResolver, walker: stepwise },
    );
    expect(out).toMatchObject({ ok: false, blocked: 'kill-switch' });
    // trilha PARCIAL preservada: o 1º nó rodou antes do kill-switch
    expect(out.walk.visitedNodes).toEqual(['llm-review']);
    if (!out.ok) {
      expect(out.message).toMatch(/EM EXECUÇÃO/);
      // §5: kill-switch é PARADA HONESTA (âmbar, estaciona), não falha (incidente).
      expect(isHonestStop(out.blocked)).toBe(true);
    }
    // limpa p/ os próximos casos
    await setKillSwitch(api, tenant, false, actor, 'liberado');
  });

  it('kill-switch ANTES de iniciar → nem começa (parada honesta imediata)', async () => {
    await configWith();
    await setKillSwitch(api, tenant, true, actor, 'pausa');
    const out = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-approval-gate@1.0.0', elementId: 'classificar' },
      { resolveGraph: governedResolver, walker: simulateWalker },
    );
    expect(out).toMatchObject({ ok: false, blocked: 'kill-switch' });
    expect(out.walk.visitedNodes).toEqual([]);
    await setKillSwitch(api, tenant, false, actor, 'liberado');
  });

  it('ref sem grafo no registry → parada honesta no-graph (agente não publicado)', async () => {
    await configWith();
    const out = await runAgentJob(
      api,
      tenant,
      { agentRef: 'agnt-fantasma@1.0.0', elementId: 'classificar' },
      { resolveGraph: async () => null, walker: simulateWalker },
    );
    expect(out).toMatchObject({ ok: false, blocked: 'no-graph' });
  });

  it('sem config de inteligência → bloqueio no-config', async () => {
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t2] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag2', 'SemIA') RETURNING id`;
    const tenant2 = t2.id as string;
    await migrator.end();
    const out = await runAgentJob(
      api,
      tenant2,
      { agentRef: 'agnt-approval-gate@1.0.0' },
      { resolveGraph: governedResolver, walker: simulateWalker },
    );
    expect(out).toMatchObject({ ok: false, blocked: 'no-config' });
  });
});
