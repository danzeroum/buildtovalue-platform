#!/usr/bin/env bash
# Backup automatizado (F1.6 / gate 8.4). Cron sugerido: 0 */6 * * *
# Uso: BACKUP_DIR=/backups DATABASE_ADMIN_URL=postgres://... ./backup.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?defina BACKUP_DIR}"
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:?defina DATABASE_ADMIN_URL}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR}/buildtovalue-${stamp}.dump"

pg_dump --format=custom --compress=6 --file="${target}" "${DATABASE_ADMIN_URL}"
sha256sum "${target}" > "${target}.sha256"

find "${BACKUP_DIR}" -name 'buildtovalue-*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name 'buildtovalue-*.sha256' -mtime "+${RETENTION_DAYS}" -delete

echo "backup ok: ${target}"
