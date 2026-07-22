-- Migração 0003 — runtime completo da F2 (plano §5/F2; SEM particionamento — D16r).
-- Completa o DDL do runtime: variables, variable_search_keys, timers,
-- user_tasks, incidents, history_events; e prepara a outbox para carregar os
-- metadados de despacho (revision + effect_index + engine_version) de que a
-- história precisa para derivar `seq` deterministicamente sob re-dispatch.
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Outbox: metadados do avanço que produziu o efeito. `seq` da história é
-- derivado de (revision, effect_index) — determinístico: o re-dispatch após
-- crash produz o MESMO seq e deduplica por effect_key (G-DAD-2).
ALTER TABLE outbox
  ADD COLUMN revision       int  NOT NULL DEFAULT 0,
  ADD COLUMN effect_index   int  NOT NULL DEFAULT 0,
  ADD COLUMN engine_version text NOT NULL DEFAULT '';

-- Jobs ganham o estado terminal 'cancelled' (efeito CancelJob: boundary
-- interruptivo/cancelamento — o job não conclui; conclusão tardia = 409).
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('available','locked','completed','failed','cancelled'));

-- ---------------------------------------------------------------------------
-- Variáveis da instância (D13: o engine NUNCA devolve variáveis — o host
-- persiste e fornece a visão imutável a cada avanço). `classification` segue
-- o dataClassification dos forms; 'sensitive' será cifrada pelo middleware
-- com KeyProvider (D20) — a coluna já existe para a costura da F2.6.
CREATE TABLE variables (
  tenant_id      uuid  NOT NULL REFERENCES tenants(id),
  instance_id    uuid  NOT NULL REFERENCES instances(id),
  name           text  NOT NULL,
  value          jsonb NOT NULL,
  classification text  NOT NULL DEFAULT 'none'
                 CHECK (classification IN ('none','personal','sensitive')),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, name)
);

-- Busca lateral (D16r): populada pelo worker para chaves DECLARADAS por
-- processo (F3/F4); built-ins buscáveis são colunas nativas.
CREATE TABLE variable_search_keys (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  instance_id uuid NOT NULL REFERENCES instances(id),
  name        text NOT NULL,
  value_text  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, name)
);
CREATE INDEX variable_search_idx ON variable_search_keys (tenant_id, name, value_text);

-- Timers: wait_key UNIQUE é a âncora do exatamente-uma-vez sob re-dispatch
-- (mesmo padrão de jobs.wait_key). Varredura por timers_due_idx.
CREATE TABLE timers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  instance_id uuid NOT NULL REFERENCES instances(id),
  element_id  text NOT NULL,
  wait_key    text NOT NULL UNIQUE,
  fire_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'armed'
              CHECK (status IN ('armed','fired','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timers_due_idx ON timers (status, fire_at);

-- User tasks: claim persistente com claim_token (D21) chega na F3; o DDL já
-- carrega as colunas. payload guarda o contexto de abertura (formRef etc.).
CREATE TABLE user_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  instance_id     uuid NOT NULL REFERENCES instances(id),
  element_id      text NOT NULL,
  wait_key        text NOT NULL UNIQUE,
  form_ref        text NOT NULL,
  assignee        text,
  candidate_roles text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','completed','cancelled')),
  claim_token     uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX user_tasks_status_idx ON user_tasks (tenant_id, status, assignee, created_at);

-- Incidentes: dedupe por effect_key (efeitos RaiseIncident re-despachados e
-- incidentes sintetizados pelo host — ex.: state_schema_version antiga demais
-- — usam chaves determinísticas com prefixo 'host:').
CREATE TABLE incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  instance_id uuid NOT NULL REFERENCES instances(id),
  kind        text NOT NULL,
  message     text NOT NULL,
  effect_key  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','retried','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_open_idx ON incidents (tenant_id, status, created_at);

-- História: seq MONOTÔNICO por instância (com lacunas), derivado de
-- (revision, effect_index) — G-DAD-2. effect_key UNIQUE = exatamente-uma-vez
-- sob re-dispatch. Particionamento é decisão pós-piloto por métricas (D16r).
CREATE TABLE history_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid   NOT NULL REFERENCES tenants(id),
  instance_id    uuid   NOT NULL REFERENCES instances(id),
  seq            bigint NOT NULL,
  kind           text   NOT NULL,
  payload        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  engine_version text   NOT NULL,
  effect_key     text   NOT NULL UNIQUE,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX history_instance_idx ON history_events (instance_id, seq);

-- ---------------------------------------------------------------------------
-- RLS em TUDO, sempre (D7) — mesmo padrão NULLIF da 0001/0002.
ALTER TABLE variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE variables FORCE ROW LEVEL SECURITY;
CREATE POLICY variables_tenant_isolation ON variables
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE variable_search_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE variable_search_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY variable_search_keys_tenant_isolation ON variable_search_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE timers FORCE ROW LEVEL SECURITY;
CREATE POLICY timers_tenant_isolation ON timers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE user_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY user_tasks_tenant_isolation ON user_tasks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant_isolation ON incidents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE history_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_events FORCE ROW LEVEL SECURITY;
CREATE POLICY history_events_tenant_isolation ON history_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON variables, variable_search_keys, timers, user_tasks, incidents, history_events
  TO app_api;
