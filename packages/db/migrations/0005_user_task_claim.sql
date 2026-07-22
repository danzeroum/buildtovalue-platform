-- Migração 0005 — claim persistente de user task (D21, shape §6).
-- Mínima de propósito: a 0003 já tem claim_token/assignee; o que falta é o
-- CARIMBO do claim para o 409 exibir "com {assignee} desde {claimed_at}"
-- (ADENDO-01 §2.2). Forward-only.

ALTER TABLE user_tasks ADD COLUMN claimed_at timestamptz;
