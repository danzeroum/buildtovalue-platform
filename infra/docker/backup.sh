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

# O dump local já está no lugar? Decide o que a mensagem de falha pode afirmar.
# Sem isto, uma falha DEPOIS da promoção diria "nenhum dump novo" — mentira, e
# do tipo pior: levaria alguém a achar que não tem backup do dia quando tem.
local_ok=0

# Todo caminho de saída é registrado com o código — inclusive o `set -e` matando
# o script no meio. É o que faz a falha aparecer no log do cron.
on_exit() {
  local code=$?
  rm -f "${part}"
  if [ $code -eq 0 ]; then
    log "ok exit=0 arquivo=${target} bytes=$(stat -c%s "${target}" 2>/dev/null || echo 0)"
  elif [ $local_ok -eq 1 ]; then
    log "FALHOU exit=${code} — o dump LOCAL está íntegro em ${target}; a falha é posterior a ele"
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
local_ok=1
log "local ok bytes=${bytes} sha256=$(cut -c1-16 < "${target}.sha256")…"

find "${BACKUP_DIR}" -name 'buildtovalue-*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name 'buildtovalue-*.sha256' -mtime "+${RETENTION_DAYS}" -delete
# .part órfão de execução interrompida (kill -9, queda da VPS) não fica para sempre.
find "${BACKUP_DIR}" -name 'buildtovalue-*.part' -mtime +1 -delete

# ---------------------------------------------------------------------------
# CÓPIA EXTERNA (Gate 8.4 item 3: o backup tem que sair da VPS).
#
# Disco que morre leva junto o backup que estava nele. Enquanto a cópia externa
# não existe, o item do gate não fecha — ter o dump só na mesma máquina do banco
# é ter uma cópia, não um backup.
#
# A cópia é ADIÇÃO, nunca condição: se ela falhar, o dump local permanece e o
# script sai ≠ 0 para o cron registrar. O pior resultado possível seria a etapa
# nova destruir o backup que já funcionava.
#
# Destino e credenciais SÓ do ambiente (BACKUP_REMOTE, RCLONE_*) — nada no repo.
# ---------------------------------------------------------------------------
if [ -z "${BACKUP_REMOTE:-}" ]; then
  # Modo degradado EXPLÍCITO: o destino definitivo depende da decisão de infra
  # do piloto. O cron não pode ficar refém dela — melhor backup local hoje, com
  # a lacuna dita em voz alta no log, que nenhum backup até a decisão sair.
  log "AVISO: BACKUP_REMOTE não definida — backup SÓ LOCAL. O item 3 do gate exige cópia fora da VPS."
  exit 0
fi

command -v rclone >/dev/null || { log "rclone não instalado (necessário para BACKUP_REMOTE)"; exit 1; }

nome="$(basename "${target}")"
log "cópia externa → ${BACKUP_REMOTE}/${nome}"
rclone copyto "${target}" "${BACKUP_REMOTE}/${nome}" || { log "falha ao copiar o dump"; exit 1; }
rclone copyto "${target}.sha256" "${BACKUP_REMOTE}/${nome}.sha256" || { log "falha ao copiar o sha256"; exit 1; }

# VERIFICAÇÃO da cópia (a cópia subiu íntegra?), não validação (o objeto
# restaura?) — essa é o ensaio do runbook de incidentes, onde vira evidência.
esperado="$(cut -d' ' -f1 < "${target}.sha256")"
remoto="$(rclone hashsum sha256 "${BACKUP_REMOTE}/${nome}" 2>/dev/null | awk '{print $1}' | head -1)"
if [ -z "${remoto}" ]; then
  # Nem todo backend calcula sha256 do lado servidor. Aí a verificação honesta
  # é baixar e comparar — mais caro, mas continua sendo verificação de verdade,
  # em vez de declarar sucesso porque o upload não deu erro.
  log "remoto não calcula sha256; verificando por download"
  rclone check "${target}" "${BACKUP_REMOTE}/${nome}" --download --size-only=false \
    || { log "cópia remota DIVERGE do local"; exit 1; }
  log "cópia externa ok (verificada por download)"
elif [ "${remoto}" != "${esperado}" ]; then
  log "cópia remota DIVERGE: local=${esperado:0:16}… remoto=${remoto:0:16}…"
  exit 1
else
  log "cópia externa ok sha256 confere (${esperado:0:16}…)"
fi

# Retenção remota espelha a local — senão o custo cresce sem fim e a política
# de descarte do dado passa a divergir entre as duas pontas.
rclone delete "${BACKUP_REMOTE}" --min-age "${RETENTION_DAYS}d" --include 'buildtovalue-*' \
  || log "AVISO: falha na retenção remota (a cópia do dia está ok)"
