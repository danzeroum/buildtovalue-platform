# Runbook — banco de dados

## Papéis (D7 / gate 8.4)

| Papel | Uso | Propriedades |
|---|---|---|
| `app_migrator` | SÓ migrações (`DATABASE_MIGRATION_URL`) | dono do schema; `NOBYPASSRLS`; `CREATEROLE` (cria `app_api` na 0001) |
| `app_api` | aplicação (api + worker) | `LOGIN`, `NOBYPASSRLS`, sem ownership; sujeito a RLS SEMPRE |

Dev/CI: senhas fixas do bootstrap (`infra/docker/postgres-init/01-roles.sql`).
**Produção: provisionar os papéis fora de banda com senhas do secret manager;
chave estática/senha fixa REPROVA o gate de piloto (D20/8.4).**

## Migrações — forward-only (plano §7)

- Aplicar: `DATABASE_MIGRATION_URL=... pnpm db:migrate`
- Migração aplicada é IMUTÁVEL (checksum conferido). Errou? Corrija com uma
  migração NOVA (fix-forward). Não existe rollback de schema.
- Emergência real = restore do último backup (abaixo) + replay de migrações.

## Backup

`infra/docker/backup.sh` (pg_dump custom format + sha256 + retenção 14d).
Agendar a cada 6h no ambiente de referência. O gate de piloto exige backup
automatizado **e restore ensaiado documentado**.

## Restore (ensaio obrigatório antes do gate — registrar data/duração aqui)

```bash
# 1. verificar integridade
sha256sum -c buildtovalue-<stamp>.dump.sha256
# 2. banco alvo LIMPO (nunca por cima do corrente em incidente — investigação primeiro)
createdb -T template0 buildtovalue_restore
pg_restore --dbname=postgres://.../buildtovalue_restore --no-owner --role=app_migrator \
  buildtovalue-<stamp>.dump
# 3. smoke: SELECT count(*) FROM schema_migrations; teste de RLS do pacote db
#    apontando TEST_PG_ADMIN_URL para o restore.
# 4. promover via troca de DATABASE_URL (janela controlada).
```

| Ensaio | Data | Duração | Resultado |
|---|---|---|---|
| Ciclo completo em Postgres 16 local: migração 0001 + seed → `backup.sh` → `sha256sum -c` → `pg_restore` em banco limpo → verificação | 2026-07-22 | ~3s (base mínima; medir de novo com volume da F2) | ✅ `schema_migrations` íntegra; dados presentes; `relrowsecurity`+`relforcerowsecurity` = true em users/tenants/refresh_tokens (RLS sobrevive ao restore) |
