-- Migração 0001 — tenancy + base de auth, COM RLS DESDE A ORIGEM (D7).
-- Forward-only (plano §7): reversão = fix-forward; emergência = restore ensaiado.
--
-- Papéis (separação exigida pelo gate 8.4):
--   app_migrator — dono do schema; SÓ ele roda migrações (DATABASE_MIGRATION_URL).
--   app_api      — papel da aplicação; LOGIN, SEM BYPASSRLS; nunca é dono de tabela.
-- As senhas abaixo são DEV-ONLY (bootstrap local/CI). Produção provisiona os
-- papéis fora de banda com secret manager (docs/runbooks/database.md).

-- EXCEPTION: papéis são objetos de CLUSTER — migrações rodando em paralelo
-- (bancos de teste concorrentes) podem correr no IF-NOT-EXISTS; o estado
-- desejado ("papel existe") é atingido de qualquer forma.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api LOGIN PASSWORD 'app_api_dev' NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;

-- ---------------------------------------------------------------- tenants
-- Metadados de tenant (não são dados de cliente). app_api só LÊ — criação de
-- tenant é operação administrativa (migrator/ops) na v1.
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
-- Leitura liberada (resolução slug->id pré-auth no login); escrita: nenhuma
-- policy => negada para app_api mesmo com GRANT.
CREATE POLICY tenants_read ON tenants FOR SELECT USING (true);
CREATE POLICY tenants_admin ON tenants USING (current_user = 'app_migrator')
  WITH CHECK (current_user = 'app_migrator');

-- ------------------------------------------------------------------ users
-- Papéis v1 (personas do plano G-UX-2 + admin): admin, analyst, business, operator.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'analyst', 'business', 'operator')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_tenant_email_idx ON users (tenant_id, lower(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- Sem contexto de tenant, NENHUMA linha é visível — o default é o isolamento.
-- NULLIF é obrigatório: depois que a GUC existe na sessão, um SET LOCAL
-- revertido a devolve como '' (não NULL) — ''::uuid explodiria a query.
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- --------------------------------------------------------- refresh_tokens
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id, expires_at);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------- grants
GRANT USAGE ON SCHEMA public TO app_api;
GRANT SELECT ON tenants TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, refresh_tokens TO app_api;
