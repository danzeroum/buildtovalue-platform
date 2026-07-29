-- Migração 0022 — rótulo humano PINADO na tarefa. A Tasklist mostrava
-- `element_id` (o identificador do modelador: `t1`, `xss`, `aprovar`) porque
-- `user_tasks` não tinha onde guardar o nome. Quem trabalha na lista lia ID.
-- Contradiz a decisão A da F3 ("nomes humanos; rota literal é o secundário")
-- justamente na superfície primária de quem não é técnico.
--
-- PINADO, não join: o rótulo é copiado do diagrama da definição no despacho do
-- OpenUserTask — mesma disciplina do `form_ref` e do `is_gate` (D31), resolvidos
-- contra a DEFINIÇÃO PINADA da instância. Ler por join em `process_definitions`
-- a cada listagem custaria o JSON do diagrama por página e, pior, deixaria o
-- registro de trabalho realizado dependente de uma leitura externa.
--
-- Por que AGORA e não na F4: `user_tasks` é registro de trabalho realizado e a
-- trilha é imutável. Rótulo acrescentado depois NÃO retrofita as tarefas já
-- concluídas — elas ficariam para sempre sem o nome do que a pessoa fez. É o
-- risco que o insumo de contrato da AG-2 nomeia ("a v1 deve gravar já").
--
-- NULLABLE e SEM backfill, de propósito: nulo tem um significado honesto —
-- "esta tarefa nasceu sem rótulo conhecido" (elemento sem `label` no diagrama,
-- definição embutida sem registry, ou tarefa anterior a esta migração). Inventar
-- rótulo retroativo para linha antiga seria fabricar evidência. Toda leitura cai
-- para `element_id` quando é nulo.
ALTER TABLE user_tasks ADD COLUMN element_label text;

COMMENT ON COLUMN user_tasks.element_label IS
  'Rótulo humano do elemento, copiado do diagrama pinado na criação da tarefa. Imutável. NULL = sem rótulo conhecido (fallback para element_id na leitura).';
