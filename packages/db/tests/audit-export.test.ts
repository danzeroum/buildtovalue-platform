import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/tenancy.js';
import { recordTenantAuditEvent } from '../src/audit/tenantAudit.js';
import {
  canonicalJson,
  computeDigest,
  exportAudit,
  normalizeActor,
  recordsToCsv,
  verifyAudit,
  type AuditExportRecord,
  type NormalizedActor,
} from '../src/audit/export.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

/**
 * Export de auditoria (AG-2.3, D36/D35) — o aceite nomeado do shape aprovado:
 * normalização das DUAS formas físicas, determinismo do digest, ato-do-motor
 * (actor:null [A]), recibo que declara garantia [B], auditoria que carrega
 * digest+intervalo+filtros [C], verificação honesta, e — sobretudo — evidência
 * NUNCA é conteúdo (o export só carrega procedência).
 */
describe('audit export + verify (D36/D35)', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;
  let instanceId: string;
  const PERSONAL = 'cpf-999.888.777-66'; // sentinela: se vazar no export, o teste falha
  const generatedBy: NormalizedActor = { type: 'user', id: 'auditor@acme', requestId: 'req-x' };

  beforeAll(async () => {
    db = await createTestDatabase('audit_export');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME') RETURNING id`;
    tenant = t.id as string;
    // Instância para ancorar os history_events (FK).
    await withTenant(migrator, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'proc@1', '1.1.0', 1, '{}'::jsonb, 'active') RETURNING id`;
      instanceId = inst.id as string;
      // Evento de instância COM ator (agente) + I/O que NÃO pode vazar.
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, agent_io, engine_version, effect_key)
        VALUES (${tenant}, ${instanceId}, 700010, 'agent:acao',
                ${tx.json({ actor: { type: 'agent', id: 'ag:1', requestId: 'r1' }, elementId: 'Task_A', message: 'agiu' })},
                ${tx.json({ input: { doc: PERSONAL } })}, '1.1.0',
                ${'k1:' + instanceId})`;
      // Evento com MOTIVO (reatribuição) — motivo é metadado seguro.
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
        VALUES (${tenant}, ${instanceId}, 700020, 'taskReassigned',
                ${tx.json({ actor: { type: 'user', id: 'ana' }, motivo: 'férias' })}, '1.1.0',
                ${'k2:' + instanceId})`;
      // Evento PURO do engine — SEM ator (ato do motor [A]).
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key)
        VALUES (${tenant}, ${instanceId}, 700030, 'instanceCompleted',
                ${tx.json({})}, '1.1.0', ${'k3:' + instanceId})`;
    });
    await migrator.end();
    api = postgres(db.apiUrl, { max: 3, onnotice: () => {} });
    // Eventos de tenant (governança, sem instância) via o repo real.
    await recordTenantAuditEvent(api, tenant, { type: 'user', id: 'ana', requestId: 'rq' }, {
      eventType: 'config.ai.updated',
      resourceType: 'ai_config',
      resourceId: tenant,
      motivo: 'trocou provider',
      payload: { provider: 'anthropic' },
    });
    await recordTenantAuditEvent(api, tenant, { type: 'system', id: 'killswitch' }, {
      eventType: 'agent.killswitch.toggled',
      resourceType: 'ai_config',
      resourceId: tenant,
    });
  }, 60_000);

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('normalizeActor: idêntico das DUAS formas físicas (colunas × jsonb)', () => {
    // tenant: campos-coluna
    expect(normalizeActor('tenant', { actorType: 'user', actorId: 'ana', requestId: 'rq' })).toEqual({
      type: 'user',
      id: 'ana',
      requestId: 'rq',
    });
    // instance: payload->actor
    expect(
      normalizeActor('instance', { payloadActor: { type: 'agent', id: 'ag:1', requestId: 'r1' } }),
    ).toEqual({ type: 'agent', id: 'ag:1', requestId: 'r1' });
    // [A] instância SEM ator → null ("ato do motor, sem ator")
    expect(normalizeActor('instance', { payloadActor: null })).toBeNull();
    expect(normalizeActor('instance', {})).toBeNull();
    // requestId ausente normaliza para null (não undefined) nas duas formas
    expect(normalizeActor('tenant', { actorType: 'system', actorId: 'k' })?.requestId).toBeNull();
  });

  it('canonicalJson é estável independentemente da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });

  it('[A] evento de instância sem ator vira actor:null no export', async () => {
    const { records } = await exportAudit(api, tenant, { source: 'instance' }, generatedBy, iso());
    const completed = records.find((r) => r.eventType === 'instanceCompleted');
    expect(completed).toBeDefined();
    expect(completed!.actor).toBeNull();
    // e o evento de agente traz o envelope completo
    const acao = records.find((r) => r.eventType === 'agent:acao');
    expect(acao!.actor).toEqual({ type: 'agent', id: 'ag:1', requestId: 'r1' });
    // motivo de instância vem do payload
    const reass = records.find((r) => r.eventType === 'taskReassigned');
    expect(reass!.motivo).toBe('férias');
    expect(reass!.seq).toBe(700020);
  });

  it('export determinístico: mesma consulta → mesmo digest; ordem total estável', async () => {
    const a = await exportAudit(api, tenant, {}, generatedBy, iso());
    const b = await exportAudit(api, tenant, {}, generatedBy, iso());
    expect(a.receipt.digest).toBe(b.receipt.digest);
    expect(a.receipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // ordem total: `at` asc; empate → instance antes de tenant; recompoível
    expect(computeDigest(a.records)).toBe(a.receipt.digest);
    // ambas as trilhas presentes (source both)
    expect(a.records.some((r) => r.source === 'instance')).toBe(true);
    expect(a.records.some((r) => r.source === 'tenant')).toBe(true);
  });

  it('[B] recibo declara o próprio nível de garantia + âncora coerente', async () => {
    const { receipt } = await exportAudit(api, tenant, {}, generatedBy, iso());
    expect(receipt.assurance).toBe('self-recorded');
    expect(receipt.assuranceNote).toMatch(/notarização externa/i);
    expect(receipt.algorithm).toBe('sha256');
    expect(receipt.generatedBy).toEqual(generatedBy);
    // âncora v1 = digest + intervalo, recuperável
    expect(receipt.anchorRef).toContain(receipt.digest);
    expect(receipt.anchorRef).toContain('to=');
  });

  it('[C] a auditoria do export carrega digest + intervalo + filtros', async () => {
    const filters = { eventType: 'config.ai.updated' as const, source: 'tenant' as const };
    const { receipt } = await exportAudit(api, tenant, filters, generatedBy, iso());
    const rows = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT payload, anchor_ref, actor_id FROM tenant_audit_events
                 WHERE event_type = 'audit.export' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    const p = rows[0].payload as { digest: string; count: number; interval: unknown; filters: { eventType: string } };
    expect(p.digest).toBe(receipt.digest);
    expect(p.interval).toBeDefined();
    expect(p.filters.eventType).toBe('config.ai.updated');
    expect(rows[0].anchor_ref).toBe(receipt.anchorRef);
    expect(rows[0].actor_id).toBe('auditor@acme'); // o auditor é auditado
  });

  it('meta-eventos (audit.export/verify) NÃO entram no próprio export', async () => {
    // dois exports geram dois audit.export; um terceiro export não os inclui
    await exportAudit(api, tenant, {}, generatedBy, iso());
    const { records } = await exportAudit(api, tenant, {}, generatedBy, iso());
    expect(records.some((r) => r.eventType === 'audit.export')).toBe(false);
    expect(records.some((r) => r.eventType === 'audit.verify')).toBe(false);
  });

  it('verify casa recibo→digest; a verificação fica na própria trilha', async () => {
    const { receipt } = await exportAudit(api, tenant, {}, generatedBy, iso());
    const ok = await verifyAudit(
      api,
      tenant,
      { expectedDigest: receipt.digest, filters: receipt.filters },
      generatedBy,
      iso(),
    );
    expect(ok.matches).toBe(true);
    expect(ok.actualDigest).toBe(receipt.digest);
    const rows = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT payload FROM tenant_audit_events WHERE event_type = 'audit.verify' ORDER BY id DESC LIMIT 1`,
    );
    expect((rows[0].payload as { matches: boolean }).matches).toBe(true);
  });

  it('verify devolve matches:false (honesto) quando o digest esperado diverge', async () => {
    const { receipt } = await exportAudit(api, tenant, {}, generatedBy, iso());
    const bad = await verifyAudit(
      api,
      tenant,
      { expectedDigest: 'sha256:' + '0'.repeat(64), filters: receipt.filters },
      generatedBy,
      iso(),
    );
    expect(bad.matches).toBe(false);
    expect(bad.expectedDigest).not.toBe(bad.actualDigest);
  });

  it('verify pega a trilha que MUDOU no intervalo (detecção de adulteração)', async () => {
    const { receipt } = await exportAudit(api, tenant, {}, generatedBy, iso());
    // insere um evento RETRODATADO dentro da janela pinada do recibo
    const backdated = receipt.filters.to!;
    await withTenant(api, tenant, async (tx) => {
      await tx`INSERT INTO history_events
          (tenant_id, instance_id, seq, kind, payload, engine_version, effect_key, occurred_at)
        VALUES (${tenant}, ${instanceId}, 700005, 'variablesUpdated',
                ${tx.json({ actor: { type: 'user', id: 'ana' } })}, '1.1.0',
                ${'k-tamper:' + instanceId}, ${backdated})`;
    });
    const after = await verifyAudit(
      api,
      tenant,
      { expectedDigest: receipt.digest, filters: receipt.filters },
      generatedBy,
      iso(),
    );
    expect(after.matches).toBe(false);
  });

  it('EVIDÊNCIA NUNCA É CONTEÚDO: nenhum valor pessoal aparece no export', async () => {
    const { records } = await exportAudit(api, tenant, {}, generatedBy, iso());
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(PERSONAL); // agent_io/payload cru fora do export
    // CSV achatado idem
    expect(recordsToCsv(records)).not.toContain(PERSONAL);
    // o export carrega procedência, não conteúdo: campos permitidos apenas
    const keys = new Set(records.flatMap((r) => Object.keys(r)));
    expect([...keys].sort()).toEqual(
      ['actor', 'anchorRef', 'at', 'eventType', 'motivo', 'resourceId', 'resourceType', 'seq', 'source'].sort(),
    );
  });

  it('CSV achata o actor em três colunas (mesma sequência do JSON canônico)', async () => {
    const records: AuditExportRecord[] = [
      {
        source: 'tenant',
        at: '2026-07-24T10:00:00.000Z',
        actor: { type: 'user', id: 'ana', requestId: 'rq' },
        eventType: 'config.ai.updated',
        resourceType: 'ai_config',
        resourceId: 't1',
        motivo: 'x',
        seq: null,
        anchorRef: null,
      },
    ];
    const csv = recordsToCsv(records);
    const [header, row] = csv.split('\n');
    expect(header).toContain('actor_type,actor_id,actor_request_id');
    expect(row).toContain('user,ana,rq');
  });

  it('migração 0015: papel `auditor` é aceito no CHECK de users.role', async () => {
    await withTenant(api, tenant, async (tx) => {
      await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenant}, 'aud@acme.test', 'x', 'Auditor', 'auditor')`;
    });
    const rows = await withTenant(
      api,
      tenant,
      (tx) => tx`SELECT role FROM users WHERE email = 'aud@acme.test'`,
    );
    expect(rows[0].role).toBe('auditor');
  });
});

/** Relógio de teste = agora real: os eventos seedados usam `now()` do banco, então
 * o `to` pinado precisa ser >= o momento deles. O determinismo do digest não vem
 * do `to` (que varia) e sim do CONJUNTO de registros — estável entre chamadas
 * enquanto nenhum evento de negócio novo é inserido. */
function iso(): string {
  return new Date().toISOString();
}
