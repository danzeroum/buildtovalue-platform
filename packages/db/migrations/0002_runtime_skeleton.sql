-- Migração 0002 — núcleo do runtime para o walking skeleton (F1.8).
-- Subconjunto do DDL da F2 (plano §5/F2, SEM particionamento — D16r); a F2
-- adiciona as demais tabelas (variables, timers, user_tasks, incidents,
-- history_events) em migrações novas. Forward-only.
--
-- Nota: definition_ref é texto (ex.: 'skeleton@1') até a F2 introduzir
-- process_definitions/registry — registrado aqui de propósito.

CREATE TABLE instances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  definition_ref       text NOT NULL,
  engine_version       text NOT NULL,
  state_schema_version int  NOT NULL,
  state                jsonb NOT NULL,
  revision             int  NOT NULL DEFAULT 0,
  status               text NOT NULL CHECK (status IN ('active','completed','cancelled','incident')),
  business_key         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instances_status_idx ON instances (tenant_id, status, created_at);

-- Outbox: fila EFÊMERA (linhas despachadas são DELETADAS — D16r/Anexo C.6).
-- effect_key determinística do host (D11): dedupe é a UNIQUE.
CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid  NOT NULL REFERENCES tenants(id),
  instance_id     uuid  NOT NULL REFERENCES instances(id),
  effect          jsonb NOT NULL,
  effect_key      text  NOT NULL UNIQUE,
  status          text  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
  attempts        int   NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready_idx ON outbox (status, next_attempt_at, created_at);

-- Jobs: lease + fencing (D12). wait_key é o elo waitKey↔effect_key do host;
-- UNIQUE = criação exatamente-uma-vez sob re-dispatch (crash test).
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid  NOT NULL REFERENCES tenants(id),
  instance_id  uuid  NOT NULL REFERENCES instances(id),
  wait_key     text  NOT NULL UNIQUE,
  type         text  NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text  NOT NULL DEFAULT 'available'
               CHECK (status IN ('available','locked','completed','failed')),
  locked_by    text,
  lock_until   timestamptz,
  lock_token   uuid,
  retries_left int   NOT NULL DEFAULT 3,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_available_idx ON jobs (status, lock_until, created_at);

-- RLS em TUDO, sempre (D7) — mesmo padrão NULLIF da 0001.
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE instances FORCE ROW LEVEL SECURITY;
CREATE POLICY instances_tenant_isolation ON instances
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant_isolation ON outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant_isolation ON jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON instances, outbox, jobs TO app_api;
