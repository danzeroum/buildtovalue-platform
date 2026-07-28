# Runbook — plataforma.buildtovalue.cloud na VPS

Subir a plataforma na VPS `/opt/btv`, atrás do `global-ingress` que já roda lá
(container `btv-nginx-prod`, rede `btv-prod-net`), com TLS Let's Encrypt.

> **Ambiente de TESTE/DEMO com TLS e domínio — NÃO é o piloto.** Os itens do
> Gate 8.4 que faltam continuam faltando (chave de campo estática sem KMS,
> secret backend local, `pg_dump` sem WAL imutável, senha do `app_api` fixada
> pela migração). Ver `deploy-vps.md §7` e `docs/privacy/gate-piloto.md`.

**O desenho:** `api` e `console` entram na rede compartilhada `btv-prod-net`; o
ingress faz proxy **por nome de container**. `postgres` e `worker` ficam só na
rede interna. Console e API no **mesmo domínio** — o cliente do console usa
baseUrl relativa (`apps/console/src/api/client.ts`), então não há CORS nem URL
de API embutida no build.

| Serviço | Container | Rede | Exposição |
|---|---|---|---|
| `postgres` | (gerado) | interna | **nenhuma** |
| `migrate` | (gerado) | interna | — (one-shot, sai) |
| `worker` | `btv-platform-worker` | interna | nenhuma (`/metrics` :9100 interno) |
| `api` | `btv-platform-api` | interna + borda | `127.0.0.1:${API_HOST_PORT}` (só diagnóstico) |
| `console` | `btv-platform-console` | borda | nenhuma (proxy do ingress) |

---

## 1. DNS (antes de tudo)

Registro **A** `plataforma` → IP da VPS, na zona `buildtovalue.cloud`.

```bash
dig +short plataforma.buildtovalue.cloud     # tem que devolver o IP da VPS
```

O certificado só é emitido depois que isso propagar. Não siga para o §4 antes.

## 2. Clonar e configurar

```bash
cd /opt/btv
git clone https://github.com/danzeroum/buildtovalue-platform.git
cd buildtovalue-platform

cp deploy/.env.example deploy/.env
openssl rand -hex 32       # → MIGRATOR_PASSWORD
openssl rand -base64 48    # → JWT_SECRET      (>=32 chars)
openssl rand -base64 32    # → FIELD_KEY_SECRET (>=16 chars)
# edite deploy/.env com os três valores
```

Se a porta 3000 já estiver ocupada na VPS, troque `API_HOST_PORT` no `.env`
(ela é só para `curl` local; o ingress não a usa).

## 3. Subir a stack

Antes: **confira a memória livre.** O build roda `pnpm install` + `pnpm -r build`
(TypeScript de 10 pacotes + Vite) duas vezes — uma por imagem. É o pico de
consumo de toda a operação.

```bash
free -h
cd /opt/btv/buildtovalue-platform/deploy
docker compose up -d --build
```

Se der OOM no meio, construa uma imagem por vez (`docker compose build api`,
depois `worker`, depois `console`) ou suba swap temporário.

```bash
docker compose ps        # postgres/api/worker/console healthy; migrate exited (0)
curl -sf http://127.0.0.1:${API_HOST_PORT:-3000}/ready && echo OK
```

A ordem é garantida pelo compose: `migrate` (one-shot, papel de migração,
forward-only) precisa sair com sucesso antes de `api`/`worker` subirem.

## 4. Certificado e ingress — em duas fases

O nginx **não sobe** apontando para um certificado inexistente, e o gateway é
compartilhado com os outros domínios. Por isso: bloco 80 → certbot → bloco 443,
com `nginx -t` antes de **todo** reload.

**Fase 1 — ACME.** Copie o **BLOCO A** de `deploy/ingress-plataforma.conf` para
dentro do `http { }` de `/opt/btv/ingress/nginx/nginx.conf`:

```bash
cp /opt/btv/ingress/nginx/nginx.conf /opt/btv/ingress/nginx/nginx.conf.bak
# edite o nginx.conf, colando o BLOCO A
docker exec btv-nginx-prod nginx -t && docker exec btv-nginx-prod nginx -s reload
```

**Fase 2 — emitir.**

```bash
certbot certonly --webroot -w /var/www/certbot -d plataforma.buildtovalue.cloud
ls /etc/letsencrypt/live/plataforma.buildtovalue.cloud/fullchain.pem
```

**Fase 3 — publicar.** Cole o **BLOCO B** logo abaixo do A:

```bash
docker exec btv-nginx-prod nginx -t && docker exec btv-nginx-prod nginx -s reload
```

Se o `nginx -t` reprovar, **não recarregue**: restaure o `.bak` e corrija.
Enquanto não houver reload, o gateway segue rodando a config antiga.

## 5. Semear o demo (opcional)

```bash
docker compose --profile seed run --rm seed
# tenant acme · admin@acme.test / demo1234 · processo Reembolso@1
```

Troque a senha padrão (`SEED_PASSWORD`) se o ambiente for alcançável por
terceiros — ele está na internet a partir do §4.

## 6. Verificar

```bash
# 1. os dois containers estão na rede do gateway
docker network inspect btv-prod-net | grep btv-platform

# 2. o gateway resolve os upstreams por nome
docker exec btv-nginx-prod wget -qO- http://btv-platform-api:3000/ready
docker exec btv-nginx-prod wget -qO- http://btv-platform-console:80/ >/dev/null && echo console-ok

# 3. borda
curl -sI https://plataforma.buildtovalue.cloud/          # 200 + HSTS
curl -s  https://plataforma.buildtovalue.cloud/ready     # status ok
curl -sI https://plataforma.buildtovalue.cloud/metrics   # 404 — NÃO pode ser 200

# 4. os outros domínios seguem no ar
curl -sI https://prompte.buildtovalue.cloud/
```

No navegador: login, navegar **Tarefas · Formulários · Operação · Estúdio**, e
dar F5 numa rota profunda (confirma o `try_files` do SPA). Iniciar uma instância
e ver a tarefa aparecer na Tasklist prova que o worker está consumindo o
`LISTEN/NOTIFY` — `docker compose logs -f worker` confirma.

## 7. Atualizar

```bash
cd /opt/btv/buildtovalue-platform
git pull
cd deploy && docker compose up -d --build
```

O `migrate` roda de novo a cada `up` e aplica só as migrações novas
(forward-only, com checksum). O ingress **não** precisa de reload: os nomes de
container não mudam.

## 8. Rollback

```bash
cd /opt/btv/buildtovalue-platform
git checkout <commit-anterior>
cd deploy && docker compose up -d --build
```

> **Não há rollback de banco.** As migrações são forward-only por decisão (D7);
> voltar o código não desfaz o schema. Se a migração nova for o problema,
> restaure o dump (`deploy-vps.md §6`) — por isso o backup vem antes do update.

Para tirar o domínio do ar sem mexer na stack: remova os dois blocos do
`nginx.conf`, `nginx -t`, reload.

## 9. Limites conhecidos deste ambiente

- **Sem coleta de métricas.** `/metrics` da api e do worker existem, mas nada os
  raspa — não há Prometheus/Grafana nem alerting.
- **Sem tracing.** `OTEL_EXPORTER_OTLP_ENDPOINT` não é definido no compose de
  deploy; o Jaeger só existe no compose de dev.
- **Backup não é automático.** `infra/docker/backup.sh` existe, mas nada o
  agenda. Ensaio de restauração: `deploy-vps.md §6`.
- **Logs só no host** (`docker logs`, json-file 10m×3). Sem agregador.
