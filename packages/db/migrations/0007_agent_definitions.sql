-- Migração 0007 — registry de AGENTES (AG-2.2 etapa 3 [GATE + MIGRAÇÃO]).
-- Espelha process/form_definitions: deploy IMUTÁVEL, gate de validação
-- (validateGraph, ADENDO-02) no caminho, versões sobem por id. Forward-only.
--
-- Diferença de shape: a versão do agente é semver DECLARADA pelo autor (não
-- auto-incrementada como o `int` do processo) — o artefato tem ref própria
-- (`agnt-rsch@2.1.0`), a mesma convenção do calledElement/callActivity. `ref`
-- (id@version) é o PIN que o history_events da corrida grava (requisito 1 da
-- etapa) e que instances.definition_ref/agentTask resolvem.
--
-- Imutabilidade por PERMISSÃO de banco (mesma prova do D32 nas trilhas): o
-- registry só recebe SELECT+INSERT. Não há UPDATE/DELETE possível — re-deploy
-- do mesmo id gera versão NOVA, nunca reescreve a corrida velha.
CREATE TABLE agent_definitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid  NOT NULL REFERENCES tenants(id),
  agent_id       text  NOT NULL,
  version        text  NOT NULL,
  ref            text  NOT NULL,
  name           text  NOT NULL,
  autonomy_level int   NOT NULL,
  graph          jsonb NOT NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, version),
  UNIQUE (tenant_id, ref)
);
-- Resolução latest-per-name (ref flutuante → última versão) e listagem do
-- catálogo caminham por (tenant, agent_id); a ordenação semver final é em JS
-- (não-hot: resolvida UMA vez no start da instância, nunca por job).
CREATE INDEX agent_definitions_id_idx ON agent_definitions (tenant_id, agent_id);

-- RLS em TUDO, sempre (D7) — padrão NULLIF, idêntico às demais.
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definitions_tenant_isolation ON agent_definitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- APPEND-ONLY para app_api: definição de agente é imutável (versões novas, nunca
-- reescrita). Sem UPDATE/DELETE — a corrida referencia o pin com garantia dura.
GRANT SELECT, INSERT ON agent_definitions TO app_api;
