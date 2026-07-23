-- Migração 0011 — status 'paused' de job (AG-2.2 etapa 5 slice 3, ADENDO-02 §5).
-- Forward-only.
--
-- PARADA HONESTA ≠ FALHA. Hoje toda `blocked` do agente vira /failure → retries →
-- incidente vermelho. Mas `budget` e `kill-switch` são pausas ESPERADAS e
-- retomáveis (âmbar) — vira-las card de incidente contradiz o §5. O job de agente
-- em parada honesta é ESTACIONADO ('paused'): sai da fila (o `jobs_available_idx`
-- e o lockJobs só pegam 'available'), NÃO consome retry, NÃO abre incidente. O
-- fato `agent:parada` na trilha + a nota de estado âmbar contam a história.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('available', 'locked', 'completed', 'failed', 'cancelled', 'paused'));
