import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordGateProposal, REPROPOSAL_CAP } from '../src/agent/gate.js';
import { reproposeGate } from '../src/agent/repropose.js';
import { claimUserTask, completeUserTask } from '../src/runtime/userTasks.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * REPROPOSTA + PROPOSTA EXPIRADA (AG-2.2 etapa 5 slice 3 final, D31 Q4). Os dois
 * [ESCOPO] que entraram na etapa 5:
 *  - reproposta é AÇÃO EXPLÍCITA com CAP DURO — estourou = recusa com MOTIVO (não
 *    silêncio); cada reproposta grava FATO com ator (consumo de orçamento auditável);
 *  - proposta expirada (D28) é PERSISTIDA como incidente âmbar `agentProposalExpired`
 *    (a UI pinta a nota + a ação), não só o 409 do ato de aprovar.
 */
const NOW = () => '2026-07-24T12:00:00.000Z';

describe('reproposta (cap + fato) + proposta expirada persistida (Q4/D28)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;

  const actor = { type: 'user' as const, id: 'operador', requestId: 'req-repropor' };

  async function newInstance(revision: number): Promise<string> {
    return withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status, revision)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active', ${revision}) RETURNING id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('gate_repropose');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('reproposta: ação explícita até o cap; cada uma grava fato com ATOR; estourou = recusa com MOTIVO', async () => {
    const instanceId = await newInstance(5);
    await withTenant(api, tenant, (tx) => recordGateProposal(tx, tenant, instanceId, 'gate', 5));

    // repropõe até o CAP — cada reproposta ok, contagem sobe.
    for (let i = 1; i <= REPROPOSAL_CAP; i++) {
      const out = await reproposeGate(api, tenant, instanceId, 'gate', actor, `reavaliar ${i}`);
      expect(out).toMatchObject({ ok: true, count: i, cap: REPROPOSAL_CAP });
    }
    // estourou o cap → recusa NOMEANDO o motivo (não silêncio).
    const over = await reproposeGate(api, tenant, instanceId, 'gate', actor, 'reavaliar demais');
    expect(over).toMatchObject({ ok: false, reason: 'cap-exceeded', cap: REPROPOSAL_CAP });

    // CADA reproposta é UM fato na trilha com envelope de ator + momento + #N.
    const facts = await withTenant(api, tenant, (tx) =>
      tx`SELECT payload FROM history_events
         WHERE instance_id = ${instanceId} AND kind = 'agent:reproposta' ORDER BY seq`);
    expect(facts).toHaveLength(REPROPOSAL_CAP); // o do cap NÃO gravou fato (recusado)
    for (const [i, f] of facts.entries()) {
      expect(f.payload).toMatchObject({
        actor: { type: 'user', id: 'operador', requestId: 'req-repropor' },
        reproposta: i + 1,
        budget: 'novo-orçamento-consumido',
      });
    }
  });

  it('reproposta em gate que nunca propôs → no-gate-state (nunca finge)', async () => {
    const instanceId = await newInstance(1);
    const out = await reproposeGate(api, tenant, instanceId, 'gate-inexistente', actor, 'x');
    expect(out).toEqual({ ok: false, reason: 'no-gate-state' });
  });

  it('proposta expirada (D28) → incidente âmbar agentProposalExpired PERSISTIDO (não só 409)', async () => {
    const instanceId = await newInstance(7);
    // gate aberto na revisão 7; a instância AVANÇA para 8 (algo mexeu desde a proposta).
    await withTenant(api, tenant, async (tx) => {
      await recordGateProposal(tx, tenant, instanceId, 'gate', 7);
      await tx`INSERT INTO user_tasks (tenant_id, instance_id, element_id, wait_key, form_ref, is_gate)
        VALUES (${tenant}, ${instanceId}, 'gate', ${`w:${instanceId}:gate`}, '', true)`;
      await tx`UPDATE instances SET revision = 8 WHERE id = ${instanceId}`;
    });
    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT id FROM user_tasks WHERE instance_id = ${instanceId} AND element_id = 'gate'`);
    const claim = await claimUserTask(api, tenant, task.id as string, 'aprovador');
    if (!claim.ok) throw new Error('claim falhou');

    // aprova com a revisão VELHA (7) → D28 recusa: proposta expirada.
    const out = await completeUserTask(api, tenant, task.id as string, {
      claimToken: claim.claimToken, submission: {}, user: 'aprovador', now: NOW(),
      expectedInstanceRevision: 7,
    });
    expect(out).toMatchObject({ ok: false, reason: 'proposalExpired' });

    // PERSISTIDO: incidente âmbar consultável, com a semente para a UI (contagem/cap).
    const [inc] = await withTenant(api, tenant, (tx) =>
      tx`SELECT kind, payload FROM incidents WHERE instance_id = ${instanceId} AND kind = 'agentProposalExpired'`);
    expect(inc.kind).toBe('agentProposalExpired');
    expect(inc.payload).toMatchObject({ gateId: 'gate', expectedRevision: 7, currentRevision: 8, cap: REPROPOSAL_CAP });
  });
});
