-- Migração 0020 — fecha a divergência LATENTE de agent_definitions.autonomy_level
-- (varredura de colunas de controle sem leitura, AG-3.4 §2.31; decisão do dono).
--
-- A regra "autonomia baixa exige gate a jusante" (assinatura do produto —
-- "autonomia como dial", ADENDO-02) já é aplicada no GATE de deploy, contra o
-- grafo EM MEMÓRIA (`registry/lint.ts`, `lintAgentGraphExecution`). Isso está
-- correto e não muda aqui. O que estava em aberto é a COLUNA PERSISTIDA: um
-- INSERT comum grava `autonomy_level` a partir de `graph.autonomyLevel`, mas
-- nada IMPEDIA estruturalmente que um bug futuro (ou um script de correção)
-- gravasse um valor DIFERENTE do grafo — divergência silenciosa entre o que
-- a coluna diz e o que o grafo (fonte única) realmente declara.
--
-- Converte para GENERATED ALWAYS ... STORED: a partir de agora é
-- ESTRUTURALMENTE IMPOSSÍVEL divergir — o Postgres recusa qualquer INSERT/
-- UPDATE que tente setar `autonomy_level` diretamente (é sempre derivado de
-- `graph`, a mesma coluna que já é a fonte de verdade). `graph.autonomyLevel`
-- é campo obrigatório do `AgentWorkflow` (nunca ausente num deploy que passou
-- pelo gate de `validateGraph`), então o `NOT NULL` é seguro.
--
-- Forward-only. `agent_definitions` é append-only (só SELECT+INSERT para
-- app_api desde a 0007) — sem UPDATE possível hoje, então não há dado
-- divergente a corrigir; esta migração só fecha a porta para o futuro.
ALTER TABLE agent_definitions DROP COLUMN autonomy_level;
ALTER TABLE agent_definitions ADD COLUMN autonomy_level int
  GENERATED ALWAYS AS ((graph ->> 'autonomyLevel')::int) STORED NOT NULL;
