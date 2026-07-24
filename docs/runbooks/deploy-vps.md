# Runbook — deploy do ambiente de TESTE/DEMO na VPS

> Ambiente de **teste/demo** com Postgres **dedicado**, numa VPS **compartilhada**
> com outras aplicações. **NÃO é o ambiente de piloto** (ver §7 — o que ele NÃO
> satisfa do Gate 8.4). Console é build **estático gerado no CI**; a VPS só faz
> `pull`/`up`. Nada de nginx próprio — a VPS já tem o `global-ingress-gateway`.

## 0. O que sobe (`deploy/docker-compose.yml`)

| Serviço | Papel | Exposição |
|---|---|---|
| `postgres` | dados, DEDICADO | **nenhuma** (só rede interna) |
| `migrate` | one-shot, papel de migração | — (roda e sai) |
| `api` | contrato `/v1` | **só** `127.0.0.1:${API_HOST_PORT}` |
| `worker` | outbox/timers/jobs/ancoragem | nenhuma (metrics interno) |

Tetos (VPS compartilhada): api/worker 256m · postgres 384m · 0.5 cpu cada ·
`NODE_OPTIONS=--max-old-space-size=192` · logs json-file 10m×3.

## 1. Pré-requisitos na VPS
- Docker + Compose v2.
- O `.env` preenchido (veja `.env.example` → seção "DEPLOY NA VPS"): pelo menos
  `MIGRATOR_PASSWORD`, `JWT_SECRET` (>=32), `FIELD_KEY_SECRET` (>=16), e a
  `API_HOST_PORT` livre que você escolher.

## 2. Subir do zero
```bash
cd deploy
docker compose up -d --build        # postgres → migrate (one-shot) → api + worker
docker compose ps                   # api "healthy"; migrate "exited (0)"
curl -sf http://127.0.0.1:${API_HOST_PORT:-3000}/ready && echo OK
```
A ordem é garantida: a `api`/`worker` só sobem após `migrate` sair com sucesso
(`service_completed_successfully`) — migração forward-only com o papel de migração.

> As imagens são multi-stage e usam `pnpm --filter=… --prod deploy` (marcado
> "experimental" pelo pnpm) para o runtime sem devDependencies. Se um build não
> empacotar as deps de workspace, acrescente `--legacy` ao `deploy` no Dockerfile.
> Este primeiro build é validado NA VPS (não há daemon Docker no CI).

## 3. Semear o demo (one-off)
```bash
docker compose --profile seed run --rm seed
# tenant acme · admin@acme.test / demo1234 · processo Reembolso@1
```

## 4. Console (estático, do CI)
O `apps/console/dist` é gerado **no CI** (`pnpm -r build`) e publicado como
artefato. Copie-o para o diretório do host que o ingress serve (ex.:
`/var/www/buildtovalue`) e plugue o server block:

- Exemplo pronto: `deploy/ingress-example.conf` (proxy de `/v1 /health /ready`
  propagando `X-Request-Id`; console SPA com `try_files`).
- **Duas formas de plugar no `global-ingress-gateway`** (escolha quando souber
  como o gateway é configurado):
  - **(a) rede docker compartilhada** — adicione a `api` a uma rede externa do
    gateway e use `proxy_pass http://api:3000;` (a api não precisa de porta no host);
  - **(b) porta no host** — mantenha `127.0.0.1:${API_HOST_PORT}` e use
    `proxy_pass http://127.0.0.1:${API_HOST_PORT};`.

## 5. Operar
```bash
docker compose logs -f api worker         # logs (json, rotacionados 10m×3)
docker compose pull && docker compose up -d   # atualizar versão (imagens novas)
docker compose up -d --build api worker   # rebuild local (sem registry)
docker compose down                        # parar (mantém o volume btv_pgdata)
```

## 6. Backup e restauração ENSAIADA (Gate 8.4 item 3)

> O item do gate é o **ENSAIO documentado**, não só o dump. Faça o dump para
> **FORA da VPS** e restaure num banco descartável, comparando contagens.

**Backup (pg_dump para fora da VPS):**
```bash
# do seu workstation (o Postgres não tem porta publicada — dump via exec):
ssh vps 'cd /caminho/deploy && docker compose exec -T postgres \
  pg_dump -U app_migrator -Fc buildtovalue' > btv-$(date +%F).dump
```

**Restauração ensaiada (num banco descartável, NUNCA sobre o de produção):**
```bash
ssh vps 'docker compose exec -T postgres psql -U app_migrator -c "CREATE DATABASE btv_restore_test OWNER app_migrator"'
cat btv-YYYY-MM-DD.dump | ssh vps 'docker compose exec -T postgres pg_restore -U app_migrator -d btv_restore_test --no-owner'
# smoke: contagens conferem com o original?
ssh vps 'docker compose exec -T postgres psql -U app_migrator -d btv_restore_test -c "SELECT count(*) FROM history_events"'
ssh vps 'docker compose exec -T postgres psql -U app_migrator -c "DROP DATABASE btv_restore_test"'
```
Registre a data e o resultado do ensaio no `docs/privacy/gate-piloto.md` (item 3).

## 7. O que este ambiente NÃO satisfaz do Gate 8.4 (não confundir com o piloto)

Ambiente de **teste ≠ ambiente de piloto**. Aqui **faltam**, de propósito:
- **Cofre gerenciado** — o `secret://` usa o resolvedor LOCAL (`env`/`file`),
  não Vault/KMS. A interface (§A) é a mesma; troca-se o backend sem tocar o resto.
- **KMS para a cifra de campos** — `FIELD_KEY_SECRET` é chave ESTÁTICA (reprova o
  gate por construção, D20). O piloto usa envelope por KMS.
- **WAL imutável / PITR** — o backup aqui é `pg_dump` off-VPS; o piloto exige
  arquivamento de WAL em object-lock (é o que promove o `assurance` de ancoragem
  de `self-recorded` para `externally-anchored`).
- **TLS/segurança de rede** ficam no `global-ingress-gateway`, não neste compose.

Estes itens são do **ambiente de nuvem do piloto** — decisão de infra em aberto
(ver `docs/privacy/gate-piloto-auditoria.md` §A/§B/§C).
