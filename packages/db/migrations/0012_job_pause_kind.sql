-- Migração 0012 — motivo estruturado da parada honesta (AG-2.2 etapa 5 slice 3,
-- ADENDO-02 §5.2). Forward-only.
--
-- A retomada precisa saber POR QUE o job parou: reativar o kill-switch retoma só
-- os jobs pausados por kill-switch (não os de budget, que exigem ação explícita
-- do operador). O `error` guarda a voz humana; `pause_kind` é o discriminador
-- OPERACIONAL consultável (mesma disciplina de não decidir por texto/trilha).
ALTER TABLE jobs ADD COLUMN pause_kind text;
