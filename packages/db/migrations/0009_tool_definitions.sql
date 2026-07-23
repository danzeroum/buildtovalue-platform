-- Migração 0009 — registry de TOOL CONTRACTS (AG-2.2 etapa 5, D31). Forward-only.
--
-- Espelha agent_definitions: deploy IMUTÁVEL, versão semver, ref (id@version).
-- Um ToolContract declara `effect` (read…external-commitment) e `authorization`
-- (automatica/gate/proibida) como CAMPO PRÓPRIO — nunca inferido do efeito. O
-- deploy valida a coerência: efeito com gate (write-irreversible/external-commitment,
-- `effectRequiresGate`) NÃO pode ser `automatica`. É a base do gate D31: o lint de
-- processo consulta o efeito daqui para exigir um btv:gate a jusante.
--
-- Imutável por permissão (mesma prova do D32): SELECT+INSERT, sem UPDATE/DELETE.
CREATE TABLE tool_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid  NOT NULL REFERENCES tenants(id),
  tool_id       text  NOT NULL,
  version       text  NOT NULL,
  ref           text  NOT NULL,
  name          text  NOT NULL,
  capability    text  NOT NULL,
  effect        text  NOT NULL,
  authz         text  NOT NULL, -- 'authorization' é palavra reservada no Postgres
  data_scope    text  NOT NULL,
  contract      jsonb NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tool_id, version),
  UNIQUE (tenant_id, ref)
);
CREATE INDEX tool_definitions_id_idx ON tool_definitions (tenant_id, tool_id);

ALTER TABLE tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_definitions_tenant_isolation ON tool_definitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON tool_definitions TO app_api;
