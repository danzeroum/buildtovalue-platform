import { hashPassword, signAccessToken, type Role } from '@platform/auth';
import {
  createDb,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
  withTenant,
} from '@platform/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  seedTestUser,
  type TestDatabase,
} from '../../../packages/db/tests/helpers.js';
import { buildApp, type ZodApp } from '../src/app.js';
import { fakeDeps } from '../src/testing/fakes.js';

/**
 * AG-3.5 (ADENDO-04 §5, shape §6 passo 10): os aceites do dono nesta triagem —
 * lockout do último admin sobre o RESULTADO (não sobre quem pediu), a checagem
 * de `active` barrando um access token ainda criptograficamente válido, o gate
 * órfão voltando à fila (não só tarefa comum), `must_change_password` fechando
 * tudo exceto o allowlist, e o revoke-all nos dois pontos preservando só a
 * sessão do próprio pedido (`sid`).
 */
describe('admin — membros/perfil/senha (AG-3.5)', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let app: ZodApp;
  let runtime: ReturnType<typeof createRuntime>;
  let jwtSecret: string;

  beforeAll(async () => {
    db = await createTestDatabase('admin_api');
    sql = createDb(db.apiUrl, { max: 8 });
    runtime = createRuntime(sql);
    const deps = fakeDeps({ RATE_LIMIT_MAX: 100_000 });
    jwtSecret = deps.config.JWT_SECRET;
    app = await buildApp({
      config: deps.config,
      users: createUserRepository(sql),
      refreshTokens: createRefreshTokenRepository(sql),
      runtime,
      dbReady: async () => true,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  // cada teste cria seu PRÓPRIO tenant — o lockout e a desativação mutam estado
  // global do tenant (papel/active), então isolamento por teste evita contaminação.
  async function newTenant(slug: string): Promise<string> {
    const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES (${slug}, ${slug}) RETURNING id`;
    await migrator.end();
    return t.id as string;
  }

  // seedTestUser grava um hash inerte ('x') — suficiente para tudo que NÃO
  // exercita login/troca de senha de verdade. Onde o teste precisa autenticar
  // com senha real (login, /v1/me/password), este helper grava um hash scrypt de verdade.
  async function seedUserWithPassword(
    tenantId: string,
    input: { email: string; role: string; displayName?: string },
    password: string,
  ): Promise<string> {
    const hash = await hashPassword(password);
    return withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx`
        INSERT INTO users (tenant_id, email, password_hash, display_name, role)
        VALUES (${tenantId}, ${input.email}, ${hash}, ${input.displayName ?? input.email}, ${input.role})
        RETURNING id`;
      return row.id as string;
    });
  }

  async function tokenFor(userId: string, tenantId: string, role: Role, sid = 'test'): Promise<string> {
    const { accessToken } = await signAccessToken(
      { sub: userId, tenantId, role, sid },
      { secret: jwtSecret, accessTtlSeconds: 900 },
    );
    return accessToken;
  }

  it('lockout do último admin: auto-rebaixe via HTTP é recusado (422), papel não muda', async () => {
    const tenant = await newTenant('lockout-a');
    const adminId = await seedTestUser(sql, tenant, { email: 'sole@lockout-a.test', role: 'admin' });
    const token = await tokenFor(adminId, tenant, 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/members/${adminId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'business', reason: 'teste de lockout' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().title).toContain('último admin');
    const [row] = await withTenant(sql, tenant, (tx) => tx`SELECT role FROM users WHERE id = ${adminId}`);
    expect(row.role).toBe('admin');
  });

  it('lockout do último admin: auto-desativação via HTTP é recusada (422), continua ativo', async () => {
    const tenant = await newTenant('lockout-b');
    const adminId = await seedTestUser(sql, tenant, { email: 'sole@lockout-b.test', role: 'admin' });
    const token = await tokenFor(adminId, tenant, 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/members/${adminId}/active`,
      headers: { authorization: `Bearer ${token}` },
      payload: { active: false, reason: 'teste de lockout' },
    });
    expect(res.statusCode).toBe(422);
    const [row] = await withTenant(sql, tenant, (tx) => tx`SELECT active FROM users WHERE id = ${adminId}`);
    expect(row.active).toBe(true);
  });

  it('lockout é sobre o RESULTADO, não sobre quem pediu: ator arbitrário (não-admin, terceiro) também é recusado', async () => {
    const tenant = await newTenant('lockout-c');
    const adminId = await seedTestUser(sql, tenant, { email: 'sole@lockout-c.test', role: 'admin' });
    // ator FABRICADO — nem é o próprio admin, nem existe como linha em users. A
    // função de repositório não confia em "quem" pediu; só no efeito sobre o
    // conjunto de admins ativos. RBAC (só admin chama isto via HTTP) é outra
    // camada — este teste prova a garantia estrutural por baixo dela.
    const terceiro = { type: 'user' as const, id: 'nao-e-o-admin-nem-existe', requestId: 'req-terceiro' };
    const roleOutcome = await runtime.admin.updateMemberRole(tenant, adminId, 'business', terceiro, 'motivo');
    expect(roleOutcome).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    const activeOutcome = await runtime.admin.setMemberActive(tenant, adminId, false, terceiro, 'motivo');
    expect(activeOutcome).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    // confirma que nada mudou apesar das duas tentativas recusadas
    const [row] = await withTenant(sql, tenant, (tx) => tx`SELECT role, active FROM users WHERE id = ${adminId}`);
    expect(row).toMatchObject({ role: 'admin', active: true });
  });

  it('dois admins: desativar UM é permitido (o outro continua) — o invariante não é overzealous', async () => {
    const tenant = await newTenant('lockout-d');
    const adminA = await seedTestUser(sql, tenant, { email: 'a@lockout-d.test', role: 'admin' });
    const adminB = await seedTestUser(sql, tenant, { email: 'b@lockout-d.test', role: 'admin' });
    const tokenA = await tokenFor(adminA, tenant, 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/members/${adminB}/active`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { active: false, reason: 'saída do time' },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await withTenant(sql, tenant, (tx) => tx`SELECT active FROM users WHERE id = ${adminB}`);
    expect(row.active).toBe(false);
  });

  it('desativação desatribui tarefa comum E gate (mesma query); nenhuma é cancelada — a instância NÃO trava', async () => {
    const tenant = await newTenant('deact-gate');
    const adminId = await seedTestUser(sql, tenant, { email: 'admin@deact-gate.test', role: 'admin' });
    const targetId = await seedTestUser(sql, tenant, { email: 'alvo@deact-gate.test', role: 'business' });

    const instanceId = await withTenant(sql, tenant, async (tx) => {
      const [inst] = await tx`
        INSERT INTO instances (tenant_id, definition_ref, engine_version, state_schema_version, state, status)
        VALUES (${tenant}, 'p@1', 'e', 1, '{}'::jsonb, 'active') RETURNING id`;
      await tx`
        INSERT INTO user_tasks
          (tenant_id, instance_id, element_id, wait_key, form_ref, candidate_roles, assignee, claim_token, claimed_at, is_gate)
        VALUES
          (${tenant}, ${inst.id}, 'review', ${`w:${inst.id}:review`}, '', '{}', ${targetId}, gen_random_uuid(), now(), false)`;
      await tx`
        INSERT INTO user_tasks
          (tenant_id, instance_id, element_id, wait_key, form_ref, candidate_roles, assignee, claim_token, claimed_at, is_gate)
        VALUES
          (${tenant}, ${inst.id}, 'btvGate', ${`w:${inst.id}:gate`}, '', '{}', ${targetId}, gen_random_uuid(), now(), true)`;
      return inst.id as string;
    });

    const adminToken = await tokenFor(adminId, tenant, 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/members/${targetId}/active`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { active: false, reason: 'saiu do time' },
    });
    expect(res.statusCode).toBe(200);

    const tasks = await withTenant(sql, tenant, (tx) =>
      tx`SELECT is_gate, assignee, claim_token, status FROM user_tasks WHERE instance_id = ${instanceId} ORDER BY is_gate`);
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.assignee).toBeNull();
      expect(t.claim_token).toBeNull();
      // volta para a fila do papel — NUNCA cancelada; é isto que impede a
      // instância de travar esperando alguém que não existe mais.
      expect(t.status).toBe('open');
    }
    expect(tasks.some((t) => t.is_gate)).toBe(true);

    // fato POR TAREFA (não um resumo) — a história de quem lê a instância
    // sabe exatamente por que cada elemento ficou órfão, gate incluso.
    const auditRows = await withTenant(sql, tenant, (tx) =>
      tx`SELECT payload FROM history_events WHERE instance_id = ${instanceId} AND kind = 'taskUnassignedOnDeactivation' ORDER BY seq`);
    expect(auditRows).toHaveLength(2);
    const gateAudit = auditRows.find((r) => (r.payload as { isGate?: boolean }).isGate === true);
    expect(gateAudit).toBeDefined();
    expect(gateAudit!.payload).toMatchObject({ previousAssignee: targetId, isGate: true });
  });

  it('access token AINDA VÁLIDO de usuário recém-desativado é barrado na PRÓXIMA request (checagem de active, não só revoke)', async () => {
    const tenant = await newTenant('active-check');
    const adminId = await seedTestUser(sql, tenant, { email: 'admin@active-check.test', role: 'admin' });
    const targetId = await seedTestUser(sql, tenant, { email: 'alvo@active-check.test', role: 'business' });
    const adminToken = await tokenFor(adminId, tenant, 'admin');
    const targetToken = await tokenFor(targetId, tenant, 'business');

    const before = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${targetToken}` },
    });
    expect(before.statusCode).toBe(200);

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/members/${targetId}/active`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { active: false, reason: 'desligamento' },
    });
    expect(deactivate.statusCode).toBe(200);

    // MESMO access token, assinatura e expiração intactas — nenhum refresh
    // token está em jogo aqui. Só a checagem de `active` (§1.1) pode barrar.
    const after = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${targetToken}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().title).toContain('desativada');
  });

  it('must_change_password bloqueia tudo exceto /v1/me e /v1/me/password; a troca libera na MESMA sessão', async () => {
    const tenant = await newTenant('must-change');
    const userId = await seedUserWithPassword(
      tenant,
      { email: 'temp@must-change.test', role: 'business' },
      'senha-temp-inicial-1',
    );
    await withTenant(sql, tenant, (tx) => tx`UPDATE users SET must_change_password = true WHERE id = ${userId}`);
    // login de verdade (não `tokenFor`) — /v1/me/password precisa de um `sid`
    // REAL (o id da linha de refresh_tokens), não o placeholder 'test'.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'must-change', email: 'temp@must-change.test', password: 'senha-temp-inicial-1' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const blocked = await app.inject({ method: 'GET', url: '/v1/instances', headers: auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().title).toContain('Senha temporária');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);

    const wrongCurrent = await app.inject({
      method: 'PATCH',
      url: '/v1/me/password',
      headers: auth,
      payload: { currentPassword: 'senha-errada', newPassword: 'senha-nova-longa-1' },
    });
    expect(wrongCurrent.statusCode).toBe(403);

    const changed = await app.inject({
      method: 'PATCH',
      url: '/v1/me/password',
      headers: auth,
      payload: { currentPassword: 'senha-temp-inicial-1', newPassword: 'senha-nova-longa-1' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });

    // o MESMO access token — o servidor relê o estado do zero a cada request,
    // então o desbloqueio vale imediatamente, sem novo login.
    const unblocked = await app.inject({ method: 'GET', url: '/v1/instances', headers: auth });
    expect(unblocked.statusCode).toBe(200);
  });

  it('revoke-all nos DOIS pontos: troca de senha preserva só a sessão do próprio pedido; reset do admin mata TODAS', async () => {
    const tenant = await newTenant('revoke-all');
    const userId = await seedUserWithPassword(
      tenant,
      { email: 'multi@revoke-all.test', role: 'business' },
      'senha-original-longa-1',
    );
    const adminId = await seedTestUser(sql, tenant, { email: 'admin@revoke-all.test', role: 'admin' });

    // dois logins = duas sessões (dois dispositivos).
    const login1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'revoke-all', email: 'multi@revoke-all.test', password: 'senha-original-longa-1' },
    });
    expect(login1.statusCode).toBe(200);
    const login2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'revoke-all', email: 'multi@revoke-all.test', password: 'senha-original-longa-1' },
    });
    expect(login2.statusCode).toBe(200);
    const { accessToken: access1, refreshToken: refresh1 } = login1.json();
    const { refreshToken: refresh2 } = login2.json();

    // troca de senha NA SESSÃO 1 — preserva esta sessão via `sid` do próprio
    // access token (nunca reenviado pelo cliente); mata as demais.
    const changed = await app.inject({
      method: 'PATCH',
      url: '/v1/me/password',
      headers: { authorization: `Bearer ${access1}` },
      payload: { currentPassword: 'senha-original-longa-1', newPassword: 'senha-nova-longa-2' },
    });
    expect(changed.statusCode).toBe(200);

    // "continua conectado só aqui": sessão 1 sobrevive (rotação normal do refresh)...
    const refreshOk = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refresh1 },
    });
    expect(refreshOk.statusCode).toBe(200);
    // ...sessão 2 morreu no revoke-all da troca de senha.
    const refreshDead = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refresh2 },
    });
    expect(refreshDead.statusCode).toBe(401);

    // segundo ponto do revoke-all: reset de senha PELO ADMIN mata TODAS as
    // sessões sem exceção — nem a mais recente (pós-rotação acima) sobrevive.
    const { refreshToken: refresh1Rotated } = refreshOk.json();
    const adminToken = await tokenFor(adminId, tenant, 'admin');
    const reset = await app.inject({
      method: 'POST',
      url: `/v1/admin/members/${userId}/reset-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'usuário sem acesso ao segundo fator, redefinição manual' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().temporaryPassword).toHaveLength(16);

    const refreshAfterReset = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refresh1Rotated },
    });
    expect(refreshAfterReset.statusCode).toBe(401);
  });
});
