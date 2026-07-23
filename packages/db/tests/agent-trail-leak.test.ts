import { MASKED_VALUE } from '@buildtovalue/agentflow';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAgentFacts,
  conservativeMaskingPolicy,
  maskIo,
  persistAgentTrail,
  type Classifications,
} from '../src/agent/agentTrail.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const CPF = '123.456.789-00'; // sensitive — NUNCA na coluna agent_io
const EMAIL = 'ana@exemplo.com'; // personal — idem
const SEGREDO = 'chave-nao-classificada-42'; // desconhecido → conservador mascara

/**
 * TESTE DE VAZAMENTO da trilha de agente (AG-2.2 etapa 3 §2 — "o requisito mais
 * importante da etapa"). Equivalente ao "ledger sem conteúdo pessoal" da F2: um
 * valor `sensitive`/`personal`/DESCONHECIDO NUNCA aparece em claro na coluna
 * `history_events.agent_io`. Máscara CONSERVADORA: só passa o que é declarado
 * `none`.
 */
describe('trilha de agente — TESTE DE VAZAMENTO em agent_io (etapa 3 §2)', () => {
  let db: TestDatabase;
  let migrator: postgres.Sql;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;

  const classifications: Classifications = {
    cpf: 'sensitive',
    email: 'personal',
    valor: 'none', // declarado não-pessoal → passa
    // `segredo` ausente de propósito: desconhecido → conservador mascara
  };

  beforeAll(async () => {
    db = await createTestDatabase('agent_trail');
    migrator = postgres(db.migratorUrl, { max: 2, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('ag', 'Agente') RETURNING id`;
    tenant = t.id as string;
    instanceId = await withTenant(migrator, tenant, async (tx) => {
      const [row] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version,
          state_schema_version, state, status)
        VALUES (${tenant}, 'com-agente@1', 'e', 1, '{}'::jsonb, 'active')
        RETURNING id`;
      return row.id as string;
    });
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await migrator?.end();
    await db?.drop();
  });

  it('máscara conservadora: só `none` passa; sensitive/personal/desconhecido redigem', () => {
    const policy = conservativeMaskingPolicy(classifications);
    const masked = maskIo(
      { input: { cpf: CPF, email: EMAIL, valor: 5000, segredo: SEGREDO }, output: { cpf: CPF } },
      policy,
    );
    expect(masked.input).toEqual({
      cpf: MASKED_VALUE,
      email: MASKED_VALUE,
      valor: 5000, // 'none' passa
      segredo: MASKED_VALUE, // desconhecido → conservador
    });
    expect(masked.output).toEqual({ cpf: MASKED_VALUE });
  });

  it('persistAgentTrail: agent_io NUNCA contém valor sensitive/personal/desconhecido em claro', async () => {
    // Fatos com PII no I/O — o pior caso: dado pessoal atravessa a corrida.
    const facts = buildAgentFacts({
      io: { input: { cpf: CPF, email: EMAIL, valor: 5000, segredo: SEGREDO }, output: { aprovado: true } },
      visitedNodes: ['llm-review', 'dec-approve'],
      complete: true,
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

    // VARREDURA leak-fail: a trilha de agente serializada por inteiro.
    const rows = await withTenant(api, tenant, (tx) => tx`
      SELECT kind, payload, agent_io FROM history_events
      WHERE instance_id = ${instanceId} AND kind LIKE 'agent:%'`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(CPF);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(SEGREDO);
    // campo estrutural não classificado também é conservador → mascarado; o que
    // importa é que NADA pessoal vaza. A máscara aparece:
    expect(serialized).toContain(MASKED_VALUE);
    // o valor 'none' declarado sobrevive (utilidade da trilha preservada):
    const io = rows.find((r) => r.agent_io)?.agent_io as { input?: Record<string, unknown> };
    expect(io.input?.valor).toBe(5000);

    // (a) UM FATO POR LINHA: a cadeia intenção→ação→io→evidência, kind por linha.
    const kinds = rows.map((r) => r.kind as string);
    expect(kinds).toContain('agent:intencao');
    expect(kinds).toContain('agent:acao');
    expect(kinds).toContain('agent:io');
    expect(kinds).toContain('agent:evidencia');
    // duas ações (llm-review, dec-approve) → duas linhas distintas
    expect(kinds.filter((k) => k === 'agent:acao')).toHaveLength(2);

    // (b) ENVELOPE DE ATOR {type,id,requestId} em CADA fato, consultável por jsonb.
    for (const r of rows) {
      const actor = (r.payload as { actor?: { type: string; id: string; requestId?: string } }).actor;
      expect(actor).toMatchObject({ type: 'agent', id: 'agnt-aprova@1.0.0', requestId: 'job-1' });
    }
    // consulta por caminho jsonb (prova de "consultável" sem coluna nova):
    const byActor = await withTenant(api, tenant, (tx) => tx`
      SELECT count(*)::int AS n FROM history_events
      WHERE instance_id = ${instanceId} AND payload->'actor'->>'type' = 'agent'`);
    expect(byActor[0].n).toBe(rows.length);
  });

  it('parada honesta vira fato de trilha (walk parcial → agentIo com error)', async () => {
    const facts = buildAgentFacts({
      io: { input: { cpf: CPF }, output: {} },
      visitedNodes: ['llm-review'],
      complete: false,
      stopReason: 'kill-switch EM EXECUÇÃO',
    });
    expect(facts.some((f) => f.kind === 'parada' && f.error)).toBe(true);
    await withTenant(api, tenant, (tx) =>
      persistAgentTrail(tx, {
        tenantId: tenant,
        instanceId,
        elementId: 'parou',
        agentRef: 'agnt-aprova@1.0.0',
        actor: { type: 'agent', id: 'agnt-aprova@1.0.0', requestId: 'job-2' },
        facts,
        classifications,
        engineVersion: 'e',
        revision: 2,
      }),
    );
    const rows = await withTenant(api, tenant, (tx) => tx`
      SELECT kind, payload FROM history_events
      WHERE instance_id = ${instanceId} AND kind LIKE 'agent:%'
        AND payload->>'elementId' = 'parou'`);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(CPF);
    // a parada honesta é sua PRÓPRIA linha (kind = agent:parada, error=true)
    expect(rows.map((r) => r.kind)).toContain('agent:parada');
  });
});
