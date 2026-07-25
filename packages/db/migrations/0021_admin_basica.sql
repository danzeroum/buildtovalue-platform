-- Migração 0021 — Administração básica [GATE+MIGRAÇÃO] (AG-3.5, ADENDO-04 §5): A4
-- membros/papéis/desativar/redefinir senha, A5 perfil/senha/preferências, A6-A senha
-- temporária. Shape aprovado em `docs/handoff/ag3-5-shape-proposta-admin-basica.md`.
--
-- `disabled_at`/`disabled_by`/`disabled_reason` são o denormalizado (leitura O(1) em
-- GET /v1/admin/members) — mesmo padrão de `kill_switch_at`/`kill_switch_by`/
-- `kill_switch_reason` em `tenant_ai_config` (0018); `tenant_audit_events` continua a
-- fonte de verdade (o ato de desativar/reativar/mudar papel/resetar senha é gravado lá).
ALTER TABLE users
  ADD COLUMN active               boolean NOT NULL DEFAULT true,
  ADD COLUMN disabled_at          timestamptz,
  ADD COLUMN disabled_by          uuid REFERENCES users(id),
  ADD COLUMN disabled_reason      text,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN timezone             text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN date_format          text NOT NULL DEFAULT 'DD/MM/YYYY'
    CHECK (date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'));

-- `users_role_check` já aceita 'auditor' desde a 0015 — nada a alterar aqui.
