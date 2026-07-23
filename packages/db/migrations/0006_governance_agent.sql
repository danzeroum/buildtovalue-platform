-- Migração 0006 — governança (ADENDO-03 D32/D33) + provisão de agente
-- (ADENDO-02 D29/D31) + dead-letter re-enfileirável (D22). Forward-only.
-- Pacote de GATE da AG-2.1 (proposta-contrato-ag2 v2 §1, aprovada).
--
-- Princípio (D32): trilha imutável POR PERMISSÃO DE BANCO, não por disciplina.
-- O runtime nunca faz UPDATE/DELETE em history_events por design (só INSERT —
-- append-only, effect_key UNIQUE) → revogar é custo zero e prova máxima.

-- ------------------------------------------------------- D32: trilha imutável
REVOKE UPDATE, DELETE ON history_events FROM app_api;

-- ------------------------------------ D33: trilha de auditoria de TENANT
-- Eventos de governança SEM instância (a history_events é ancorada em
-- instância). Append-only: app_api recebe SÓ SELECT+INSERT (sem UPDATE/DELETE).
-- Envelope de ator como campo de 1ª CLASSE consultável (nunca em payload);
-- event_type/resource_type/resource_id estáveis (catálogo no contrato); motivo;
-- referência de ancoragem recuperável por evento/intervalo (D35 — sem ela o
-- "verificar integridade" da F4 não tem o que mostrar).
CREATE TABLE tenant_audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_id      text NOT NULL,
  request_id    text,
  event_type    text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  motivo        text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  anchor_ref    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Índices para os filtros do export (D36): período/ator/event_type/resource.
CREATE INDEX tenant_audit_events_period_idx ON tenant_audit_events (tenant_id, created_at);
CREATE INDEX tenant_audit_events_type_idx ON tenant_audit_events (tenant_id, event_type, created_at);
CREATE INDEX tenant_audit_events_actor_idx ON tenant_audit_events (tenant_id, actor_type, actor_id);
CREATE INDEX tenant_audit_events_resource_idx ON tenant_audit_events (tenant_id, resource_type, resource_id);

-- ------------------------------------------ D29: inteligência do tenant
-- UMA config por tenant. Segredo SÓ como referência a secret manager
-- (`secret://…`) — CHECK garante que nunca chega chave em claro. kill_switch =
-- interrupção do Art. 14 do EU AI Act (auditada na aplicação).
CREATE TABLE tenant_ai_config (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id),
  provider     text NOT NULL,
  model        text NOT NULL,
  key_ref      text NOT NULL CHECK (key_ref LIKE 'secret://%'),
  budget_cents integer CHECK (budget_cents IS NULL OR budget_cents >= 0),
  kill_switch  boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------- D31: governança de tools
-- Catálogo por tenant. requires_gate=true por padrão (irreversível exige gate
-- no caminho; o enforcement do runtime chega na AG-2.2, a tabela nasce aqui).
CREATE TABLE tenant_tools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  tool          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT false,
  requires_gate boolean NOT NULL DEFAULT true,
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_tools_unique ON tenant_tools (tenant_id, tool);

-- ------------------------------------- D22: dead-letter re-enfileirável
-- Payload do efeito guardado no incidente de dead-letter para o /retry
-- re-enfileirar (fecha a ERRATA §7). Nullable: só incidentes de dead-letter
-- carregam.
ALTER TABLE incidents ADD COLUMN payload jsonb;

-- ------------------------------ D27/D30: coluna mascarável de I/O de agente
-- Fatos de trilha de agente vão para history_events (kinds novos); o I/O
-- (mascarado por classificação) fica em coluna própria. Nullable — só eventos
-- de agente carregam. (Consumo na AG-2.2.)
ALTER TABLE history_events ADD COLUMN agent_io jsonb;

-- ---------------------------------------------------------------- RLS (D7)
-- Mesmo padrão NULLIF das migrações anteriores. As três tabelas novas com
-- tenant_id entram na cobertura de isolamento (suíte permanente sobe p/ 17).
ALTER TABLE tenant_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_audit_events_tenant_isolation ON tenant_audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_ai_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_config_tenant_isolation ON tenant_ai_config
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_tools_tenant_isolation ON tenant_tools
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- --------------------------------------------------------------- Grants
-- tenant_audit_events: APPEND-ONLY para app_api (SELECT p/ export + INSERT).
GRANT SELECT, INSERT ON tenant_audit_events TO app_api;
-- config/tools: leitura + escrita (mutáveis pela aplicação, com auditoria).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_ai_config, tenant_tools TO app_api;
