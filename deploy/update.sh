#!/usr/bin/env bash
# Atualiza a stack do BuildToValue nesta VPS: puxa a branch, reconstrói o que
# mudou e verifica que subiu. Idempotente — rodar duas vezes seguidas não faz
# mal, e sem commit novo ele nem chama o Docker.
#
#   ./deploy/update.sh              # atualiza a branch atual
#   ./deploy/update.sh --force      # reconstrói mesmo sem commit novo
#   ./deploy/update.sh --check      # só diz o que mudaria; não toca em nada
#
# NÃO faz backup do banco. As migrações são forward-only e não têm "down":
# antes de uma atualização que traga migração, o runbook manda rodar
# `infra/docker/backup.sh` (docs/runbooks/database.md).
set -euo pipefail

FORCE=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconhecido: $arg (use --force, --check ou --help)" >&2; exit 2 ;;
  esac
done

# Resolve a raiz do repo a partir do próprio script — funciona de qualquer cwd.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mXX %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 1. sanidade -----------------------------------------------------------
[ -f deploy/docker-compose.yml ] || die "não achei deploy/docker-compose.yml em $REPO"
[ -f deploy/.env ] || die "deploy/.env não existe — copie de deploy/.env.example e gere os segredos"

# Mudança local não commitada seria engolida por um merge silencioso. Melhor
# parar e deixar a decisão com quem está no terminal.
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "há mudanças locais não commitadas — resolva antes (git stash, ou commite)"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ANTES="$(git rev-parse HEAD)"
say "repo $REPO | branch $BRANCH | commit ${ANTES:0:7}"

# ---- 2. buscar ------------------------------------------------------------
say "buscando origin/$BRANCH"
tentativa=1
until git fetch origin "$BRANCH"; do
  [ $tentativa -ge 4 ] && die "fetch falhou 4 vezes — problema de rede?"
  espera=$((2 ** tentativa))
  warn "fetch falhou; nova tentativa em ${espera}s"
  sleep "$espera"
  tentativa=$((tentativa + 1))
done

DEPOIS="$(git rev-parse FETCH_HEAD)"
if [ "$ANTES" = "$DEPOIS" ]; then
  echo "já está em ${ANTES:0:7} — nada novo em origin/$BRANCH"
  if [ $FORCE -eq 0 ]; then
    [ $CHECK -eq 1 ] && exit 0
    say "nada a fazer (use --force para reconstruir mesmo assim)"
    exit 0
  fi
  warn "--force: reconstruindo sem commit novo"
else
  say "commits novos (${ANTES:0:7} → ${DEPOIS:0:7})"
  git --no-pager log --oneline "$ANTES..$DEPOIS"
fi

# Migração nova exige atenção: forward-only, sem rollback.
MIGRACOES="$(git diff --name-only "$ANTES..$DEPOIS" -- packages/db/migrations/ 2>/dev/null || true)"
if [ -n "$MIGRACOES" ]; then
  warn "esta atualização traz MIGRAÇÃO (forward-only, sem down):"
  printf '   %s\n' $MIGRACOES >&2
  warn "se ainda não fez backup, interrompa (Ctrl+C) e rode infra/docker/backup.sh"
fi

if [ $CHECK -eq 1 ]; then
  say "--check: nada foi alterado"
  exit 0
fi

# ---- 3. atualizar o código -------------------------------------------------
if [ "$ANTES" != "$DEPOIS" ]; then
  say "atualizando a árvore"
  # --ff-only: se a branch divergiu, para em vez de criar merge na VPS.
  git merge --ff-only FETCH_HEAD || die "a branch divergiu do remoto — resolva à mão"
fi

# ---- 4. reconstruir e subir ------------------------------------------------
cd "$REPO/deploy"
say "build + up (o cache de layer do Docker reaproveita o que não mudou)"
docker compose up -d --build

# ---- 5. verificar ----------------------------------------------------------
say "migração"
MIG_ID="$(docker compose ps -aq migrate || true)"
if [ -n "$MIG_ID" ]; then
  CODIGO="$(docker inspect -f '{{.State.ExitCode}}' "$MIG_ID")"
  docker compose logs --no-log-prefix --tail 3 migrate || true
  [ "$CODIGO" = "0" ] || die "o serviço migrate saiu com código $CODIGO — a api pode estar com schema velho"
fi

say "aguardando healthy"
PRAZO=$((SECONDS + 120))
PENDENTES="api worker console postgres"
while [ $SECONDS -lt $PRAZO ]; do
  RESTAM=""
  for s in $PENDENTES; do
    CID="$(docker compose ps -q "$s" || true)"
    if [ -z "$CID" ]; then RESTAM="$RESTAM $s"; continue; fi
    ESTADO="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID")"
    case "$ESTADO" in
      healthy|running) ;;
      *) RESTAM="$RESTAM $s" ;;
    esac
  done
  PENDENTES="$RESTAM"
  [ -z "${PENDENTES// /}" ] && break
  sleep 3
done

docker compose ps
if [ -n "${PENDENTES// /}" ]; then
  warn "sem healthy em 120s:$PENDENTES"
  warn "veja: docker compose logs --tail 50$PENDENTES"
  exit 1
fi

# A porta publicada vive no .env do compose, não no ambiente deste shell.
PORTA="$(sed -n 's/^API_HOST_PORT=\([0-9]\{1,\}\).*/\1/p' .env | tail -1)"
say "readiness da api (127.0.0.1:${PORTA:-3000})"
curl -sf "http://127.0.0.1:${PORTA:-3000}/ready" && echo || die "/ready não respondeu ok"

say "pronto — ${DEPOIS:0:7} no ar"
echo "para reverter: git checkout ${ANTES:0:7} && cd deploy && docker compose up -d --build"
echo "(o código volta; a MIGRAÇÃO não — forward-only, restauração é por backup)"
