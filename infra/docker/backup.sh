#!/usr/bin/env bash
# Backup do Postgres (F1.6 / Gate 8.4 item 3). Dump datado + sha256 + retenção.
#
# DOIS MODOS:
#   (a) via Docker (VPS)  — COMPOSE_DIR=/opt/btv/buildtovalue-platform/deploy
#       O Postgres do deploy NÃO publica porta; só se chega por `compose exec`.
#   (b) direto            — DATABASE_ADMIN_URL=postgres://...
#
# Uso:
#   BACKUP_DIR=/var/backups/btv COMPOSE_DIR=/opt/btv/buildtovalue-platform/deploy ./backup.sh
#   BACKUP_DIR=/backups DATABASE_ADMIN_URL=postgres://... ./backup.sh
#
# Agendamento: infra/docker/backup.cron.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?defina BACKUP_DIR}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-app_migrator}"
PG_DB="${PG_DB:-buildtovalue}"

mkdir -p "${BACKUP_DIR}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR}/buildtovalue-${stamp}.dump"
# Escreve em .part e só promove no fim. Sem isto, um pg_dump que falha no meio
# (banco fora do ar, disco cheio) deixa um dump PARCIAL com nome de dump bom —
# e backup que parece existir é pior que backup que não existe.
part="${target}.part"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Todo caminho de saída é registrado com o código — inclusive o `set -e` matando
# o script no meio. É o que faz a falha aparecer no log do cron.
on_exit() {
  local code=$?
  rm -f "${part}"
  if [ $code -eq 0 ]; then
    log "ok exit=0 arquivo=${target} bytes=$(stat -c%s "${target}" 2>/dev/null || echo 0)"
  else
    log "FALHOU exit=${code} — nenhum dump novo em ${BACKUP_DIR}"
  fi
  exit $code
}
trap on_exit EXIT

log "início modo=$([ -n "${COMPOSE_DIR:-}" ] && echo docker || echo direto) destino=${target}"

if [ -n "${COMPOSE_DIR:-}" ]; then
  # -T: sem TTY (cron não tem). O dump sai por stdout para o .part no host.
  ( cd "${COMPOSE_DIR}" && docker compose exec -T "${PG_SERVICE}" \
      pg_dump --format=custom --compress=6 -U "${PG_USER}" "${PG_DB}" ) > "${part}"
else
  : "${DATABASE_ADMIN_URL:?defina DATABASE_ADMIN_URL (ou COMPOSE_DIR)}"
  pg_dump --format=custom --compress=6 --file="${part}" "${DATABASE_ADMIN_URL}"
fi

# Dump vazio é o modo de falha SILENCIOSO: o pg_dump pode sair 0 sem escrever
# nada (pipe quebrado, container morrendo no meio). Sem este piso, o cron
# acumularia arquivos de 0 byte e ninguém notaria até a hora do restore.
bytes="$(stat -c%s "${part}" 2>/dev/null || echo 0)"
if [ "${bytes}" -lt 1024 ]; then
  log "dump com ${bytes} bytes — abaixo do piso de 1024; descartado"
  exit 1
fi

mv "${part}" "${target}"
sha256sum "${target}" > "${target}.sha256"

find "${BACKUP_DIR}" -name 'buildtovalue-*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name 'buildtovalue-*.sha256' -mtime "+${RETENTION_DAYS}" -delete
# .part órfão de execução interrompida (kill -9, queda da VPS) não fica para sempre.
find "${BACKUP_DIR}" -name 'buildtovalue-*.part' -mtime +1 -delete
