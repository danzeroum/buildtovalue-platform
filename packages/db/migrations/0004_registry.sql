-- Migração 0004 — registries do MVP (F3.1, shape /v1 aprovado 22/07 §1/§2b)
-- + idempotency_keys (convenção §0). Forward-only.

-- Definições de PROCESSO: imutáveis (D6/D10). registry_ref = name@version é
-- a referência que instances.definition_ref (TEXT, decisão de autonomia §2.2
-- da 0002) passa a apontar. Re-deploy do mesmo name = versão nova.
CREATE TABLE process_definitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid  NOT NULL REFERENCES tenants(id),
  name           text  NOT NULL,
  version        int   NOT NULL,
  registry_ref   text  NOT NULL,
  diagram        jsonb NOT NULL,
  engine_version text  NOT NULL,
  bpmn_version   text  NOT NULL DEFAULT '1',
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version),
  UNIQUE (tenant_id, registry_ref)
);
CREATE INDEX process_definitions_name_idx ON process_definitions (tenant_id, name, version DESC);

-- Definições de FORMULÁRIO (F0b.5): schema validado no deploy (value
-- reservada + dataClassification obrigatório — validateSchema é o gate).
-- ref = form_id@version; a Tasklist renderiza SEMPRE pelo ref exato pinado.
CREATE TABLE form_definitions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid  NOT NULL REFERENCES tenants(id),
  form_id    text  NOT NULL,
  version    int   NOT NULL,
  ref        text  NOT NULL,
  schema     jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, form_id, version),
  UNIQUE (tenant_id, ref)
);
CREATE INDEX form_definitions_id_idx ON form_definitions (tenant_id, form_id, version DESC);

-- Idempotency-Key (convenção §0): chave por tenant, retenção 24h (varrida
-- pelo worker), replay devolve a resposta original.
CREATE TABLE idempotency_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_keys_age_idx ON idempotency_keys (created_at);

-- RLS em TUDO, sempre (D7) — padrão NULLIF.
ALTER TABLE process_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY process_definitions_tenant_isolation ON process_definitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE form_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY form_definitions_tenant_isolation ON form_definitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON process_definitions, form_definitions, idempotency_keys
  TO app_api;
