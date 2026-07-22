import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEnvKeyProvider,
  createFieldCipher,
  isEncryptedField,
} from '../src/crypto/fieldCipher.js';
import { advanceInstance } from '../src/runtime/advance.js';
import { EXAMPLE_DEFINITION_REF } from '../src/runtime/definitions.js';
import { runtimeDepths } from '../src/runtime/depths.js';
import { createRuntime } from '../src/runtime/facade.js';
import { lockJobs } from '../src/runtime/jobs.js';
import { dispatchOutboxOnce } from '../src/runtime/outbox.js';
import { withTenant } from '../src/tenancy.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

const NOW = () => '2026-07-22T15:00:00.000Z';
const CPF = '123.456.789-00'; // sensitive — cifrado em repouso
const EMAIL = 'ana@titular.test'; // personal — em claro nas tabelas mutáveis

/**
 * Costura LGPD da F2 (plano §F2 itens 5/6 + ADR-0002): o conteúdo pessoal
 * vive nas tabelas MUTÁVEIS (variables/user_tasks.payload) — cifrado quando
 * `sensitive` (KeyProvider D20) — e o registro histórico/ledger só carrega
 * provas e referências. O teste do ledger abaixo é ENTREGÁVEL NOMEADO do
 * aceite da fase (exigência de materialização da aprovação do ADR-0002).
 */
describe('costura LGPD (F2.6) — cifra de campos e ledger sem conteúdo pessoal', () => {
  let db: TestDatabase;
  let api: postgres.Sql;
  let tenant: string;
  const keyProvider = createEnvKeyProvider('segredo-de-teste-livre', 'test-v1');

  beforeAll(async () => {
    db = await createTestDatabase('lgpd');
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('lgpd', 'LGPD') RETURNING id`;
    tenant = t.id as string;
    await migrator.end();
    api = postgres(db.apiUrl, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await api?.end();
    await db?.drop();
  });

  it('FieldCipher: roundtrip AES-256-GCM, IV por registro, chave desconhecida falha', async () => {
    const cipher = createFieldCipher(keyProvider);
    const a = await cipher.encrypt(CPF);
    const b = await cipher.encrypt(CPF);
    expect(isEncryptedField(a)).toBe(true);
    expect(a).not.toBe(b); // IV por registro: mesmo valor, criptogramas diferentes
    expect(a).not.toContain(CPF);
    expect(await cipher.decrypt(a)).toBe(CPF);
    const outro = createFieldCipher(createEnvKeyProvider('outro-segredo-qualquer', 'x-v9'));
    await expect(outro.decrypt(a)).rejects.toThrow(/desconhecida/);
  });

  it('sensitive persiste CIFRADA; personal em claro com classificação (alvo de anonimização)', async () => {
    const runtime = createRuntime(api, NOW, { keyProvider });
    const started = await runtime.createAndStart(tenant, {
      definitionRef: EXAMPLE_DEFINITION_REF,
      businessKey: 'lgpd-1',
      variables: { email: EMAIL },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.instance.id;
    await drain();

    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT wait_key FROM user_tasks WHERE instance_id = ${id} AND status = 'open'`);
    const done = await advanceInstance(
      api, tenant, id,
      {
        type: 'UserTaskCompleted', now: NOW(), waitKey: task.wait_key as string,
        variables: {}, submission: { approved: true, cpf: CPF },
      },
      { cipher: createFieldCipher(keyProvider) },
    );
    expect(done.ok).toBe(true);
    await drain();

    const vars = await withTenant(api, tenant, (tx) =>
      tx`SELECT name, value, classification FROM variables WHERE instance_id = ${id} ORDER BY name`);
    const byName = new Map(vars.map((v) => [v.name as string, v]));
    // sensitive: NUNCA em claro em repouso
    const cpfRow = byName.get('cpf')!;
    expect(cpfRow.classification).toBe('sensitive');
    expect(isEncryptedField(cpfRow.value)).toBe(true);
    expect(JSON.stringify(cpfRow.value)).not.toContain(CPF);
    // personal: em claro (mutável, apagável), marcada para o fluxo de exclusão
    const emailRow = byName.get('email')!;
    expect(emailRow.classification).toBe('personal');
    expect(emailRow.value).toBe(EMAIL);
    // o engine avaliou a condição com a visão DECIFRADA (rota aprovada)
    const jobs = await withTenant(api, tenant, (tx) =>
      tx`SELECT type FROM jobs WHERE instance_id = ${id}`);
    expect(jobs.map((j) => j.type)).toEqual(['http-call']);
  });

  it('sensitive SEM KeyProvider aborta a transação (nunca plaintext silencioso)', async () => {
    const semCipher = createRuntime(api, NOW); // sem keyProvider
    // erro de CONFIGURAÇÃO, não de negócio: a tx aborta e a chamada lança
    await expect(
      semCipher.createAndStart(tenant, {
        definitionRef: EXAMPLE_DEFINITION_REF,
        businessKey: 'lgpd-sem-chave',
        variables: { cpf: CPF },
      }),
    ).rejects.toThrow(/KeyProvider/);
    const rows = await withTenant(api, tenant, (tx) =>
      tx`SELECT id FROM instances WHERE business_key = 'lgpd-sem-chave'`);
    expect(rows).toHaveLength(0);
  });

  it('ledger nunca contém conteúdo pessoal', async () => {
    // ENTREGÁVEL NOMEADO da F2 (ADR-0002): dados pessoais atravessam o fluxo
    // inteiro (start → task → XOR → job → complete) e a varredura do registro
    // histórico/ledger-bound FALHA se qualquer valor aparecer em claro.
    const runtime = createRuntime(api, NOW, { keyProvider });
    const started = await runtime.createAndStart(tenant, {
      definitionRef: EXAMPLE_DEFINITION_REF,
      businessKey: 'lgpd-ledger',
      variables: { email: EMAIL },
    });
    if (!started.ok) throw new Error('start falhou');
    const id = started.instance.id;
    await drain();
    const [task] = await withTenant(api, tenant, (tx) =>
      tx`SELECT wait_key FROM user_tasks WHERE instance_id = ${id} AND status = 'open'`);
    await advanceInstance(
      api, tenant, id,
      {
        type: 'UserTaskCompleted', now: NOW(), waitKey: task.wait_key as string,
        variables: {}, submission: { approved: true, cpf: CPF },
      },
      { cipher: createFieldCipher(keyProvider) },
    );
    await drain();
    const locked = await lockJobs(api, tenant, 'w-lgpd', { limit: 50 });
    const job = locked.find((j) => j.instance_id === id)!;
    const completed = await runtime.completeJob(tenant, job.id, job.lock_token!, NOW(), { notified: true });
    expect(completed.ok).toBe(true);
    await drain();
    const [finalRow] = await withTenant(api, tenant, (tx) =>
      tx`SELECT status FROM instances WHERE id = ${id}`);
    expect(finalRow.status).toBe('completed');

    // varredura: TUDO que é registro de auditoria/histórico (ledger-bound)
    // serializado por inteiro — linha a linha, coluna a coluna.
    const ledgerBound = await withTenant(api, tenant, async (tx) => {
      const history = await tx`SELECT * FROM history_events WHERE instance_id = ${id}`;
      const incidents = await tx`SELECT * FROM incidents WHERE instance_id = ${id}`;
      const outbox = await tx`SELECT * FROM outbox WHERE instance_id = ${id}`;
      return [...history, ...incidents, ...outbox];
    });
    expect(ledgerBound.length).toBeGreaterThanOrEqual(3); // história real varrida
    const serialized = JSON.stringify(ledgerBound);
    expect(serialized).not.toContain(CPF);
    expect(serialized).not.toContain(EMAIL);
    // o ESTADO da instância (jsonb) também não carrega valores (D13):
    const [instanceRow] = await withTenant(api, tenant, (tx) =>
      tx`SELECT state FROM instances WHERE id = ${id}`);
    const stateJson = JSON.stringify(instanceRow.state);
    expect(stateJson).not.toContain(CPF);
    expect(stateJson).not.toContain(EMAIL);
  });

  it('runtimeDepths fotografa as filas por tenant (métricas 9.2)', async () => {
    const depths = await runtimeDepths(api, tenant, { now: NOW });
    expect(depths).toEqual({
      outboxPending: expect.any(Number),
      jobsAvailable: expect.any(Number),
      timersLate: expect.any(Number),
      incidentsOpen: expect.any(Number),
    });
    expect(depths.outboxPending).toBe(0); // tudo drenado nos testes acima
  });

  async function drain(): Promise<void> {
    for (;;) {
      const result = await dispatchOutboxOnce(api, tenant, { batch: 50 });
      if (result.processed === 0 && result.failed === 0) return;
    }
  }
});
