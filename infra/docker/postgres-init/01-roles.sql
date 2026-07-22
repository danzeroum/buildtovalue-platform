-- Bootstrap DEV/CI: papel de migração separado do papel da API (gate 8.4).
-- Produção provisiona estes papéis via secret manager (runbook database.md);
-- as senhas abaixo são exclusivas de ambiente local/CI.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev' NOBYPASSRLS CREATEROLE;
  END IF;
END $$;
ALTER DATABASE buildtovalue OWNER TO app_migrator;
