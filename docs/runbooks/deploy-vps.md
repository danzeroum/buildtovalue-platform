# Runbook — deploy do ambiente de TESTE/DEMO na VPS

> Ambiente de **teste/demo** com Postgres **dedicado**, numa VPS **compartilhada**
> com outras aplicações. **NÃO é o ambiente de piloto** (ver §7 — o que ele NÃO
> satisfa do Gate 8.4). Nada de nginx de borda próprio — a VPS já tem o
> `global-ingress-gateway`.
>
> **Deploy concreto, com domínio e TLS:** `deploy-plataforma-vps.md` (passo a
> passo de `plataforma.buildtovalue.cloud`). Este documento é a referência do
> compose e das operações de banco.

## 0. O que sobe (`deploy/docker-compose.yml`)

| Serviço | Papel | Exposição |
|---|---|---|
| `postgres` | dados, DEDICADO | **nenhuma** (só rede interna) |
| `migrate` | one-shot, papel de migração | — (roda e sai) |
| `api` | contrato `/v1` | rede de borda + `127.0.0.1:${API_HOST_PORT}` (diagnóstico) |
| `worker` | outbox/timers/jobs/ancoragem | nenhuma (metrics interno) |
| `console` | SPA estático (nginx da imagem) | rede de borda |

Tetos (VPS compartilhada): api/worker 256m · postgres 384m · console 128m ·
0.5 cpu cada · `NODE_OPTIONS=--max-old-space-size=192` · logs json-file 10m×3.

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

> As imagens são multi-stage e usam `pnpm --filter=… --prod deploy --legacy`
> para o runtime sem devDependencies. O `--legacy` **não é opcional**: a partir
> do pnpm 10 o `deploy` só roda sem ele em workspaces com
> `inject-workspace-packages=true`, e sem ele o build morre com
> `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`. Não há daemon Docker no CI, então
> mudanças nos Dockerfiles seguem sendo validadas na VPS.

## 3. Semear o demo (one-off)
```bash
docker compose --profile seed run --rm seed
# tenant acme · admin@acme.test / demo1234 · processo Reembolso@1
```

## 4. Console e ingress
O console sobe como **imagem própria** (`deploy/Dockerfile.console`): o builder
compila o monorepo e o runtime é um `nginx:alpine` servindo `apps/console/dist`
com `try_files` para as rotas do react-router. Nada é copiado do CI, e o CI não
publica artefato de build.

Plugagem no `global-ingress-gateway` pela forma **(a) rede compartilhada**: a
`api` e o `console` entram também na rede externa `btv-prod-net`, e o gateway
faz `proxy_pass` **por nome de container** (`btv-platform-api`,
`btv-platform-console`). Console e API no mesmo domínio — o cliente do console
usa baseUrl relativa, então não há CORS nem URL de API embutida no build.

- Blocos prontos: **`deploy/ingress-plataforma.conf`** (ACME + TLS + roteamento
  `/v1|/health|/ready` com `X-Request-Id`, `/metrics` barrado).
- Passo a passo com certificado: **`deploy-plataforma-vps.md`**.
- `deploy/ingress-example.conf` continua como referência genérica das duas
  formas possíveis (rede compartilhada × porta no host).

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

## 8. BOOTSTRAP do ensaio AG-2.5 (DeepSeek) — máquina limpa só com Docker

Passo a passo copiável. A chave DeepSeek entra **só** no passo 8.2 (arquivo no host);
**nunca** vai ao repo nem ao banco. Assume que você está em `deploy/`.

> ✅ **Fiação pronta:** em produção com `SECRET_BACKEND=file`, o worker injeta o provider
> REAL (DeepSeek) no job `agent` — resolve a chave do `secret://` e chama de verdade. O
> bootstrap abaixo deixa o ambiente de pé, **prova o segredo** (8.4) e destrava o ensaio real.

### 8.1 · Subir + migrar + semear (do zero)
```bash
cd deploy
# .env: além de MIGRATOR_PASSWORD/JWT_SECRET/FIELD_KEY_SECRET, defina:
#   SECRET_BACKEND=file
#   SECRET_HOST_DIR=./secrets        # dir do HOST montado read-only no worker
#   SECRET_DIR=/run/secrets/btv      # alvo do mount (default; mantenha)
#   FX_USD_BRL=5.40                  # taxa USD→BRL (tabela DeepSeek é em USD)
docker compose up -d --build                 # postgres → migrate(one-shot) → api+worker
docker compose --profile seed run --rm seed  # tenant 'acme'
TENANT=$(docker compose exec -T postgres psql -U app_migrator -d buildtovalue -tAc \
  "SELECT id FROM tenants WHERE slug='acme'")
echo "tenant acme = $TENANT"
```

### 8.2 · Criar o arquivo da chave (chmod 600, no HOST)
`SECRET_DIR` real do container = `/run/secrets/btv` (montado de `SECRET_HOST_DIR`, default
`deploy/secrets`). `key_ref` = `secret://tenants/acme/ai-key` → arquivo `tenants/acme/ai-key`.
```bash
umask 077
mkdir -p secrets/tenants/acme
printf '%s' 'sk-SUA-CHAVE-DEEPSEEK-REAL' > secrets/tenants/acme/ai-key
chmod 600 secrets/tenants/acme/ai-key
# o container roda como uid 1000 (node); o resolver RECUSA perm frouxa (640/644).
# se o uid do host ≠ 1000, dê a posse ao node: sudo chown 1000:1000 secrets/tenants/acme/ai-key
```

### 8.3 · Inserir o `tenant_ai_config` (SQL direto — não há rota; papel de migração)
```bash
docker compose exec -T postgres psql -U app_migrator -d buildtovalue -c "
  INSERT INTO tenant_ai_config (tenant_id, provider, base_url, model, key_ref, budget_cents)
  SELECT id, 'openai-compatible', 'https://api.deepseek.com', 'deepseek-chat',
         'secret://tenants/acme/ai-key', NULL
  FROM tenants WHERE slug='acme'
  ON CONFLICT (tenant_id) DO UPDATE SET
    provider=EXCLUDED.provider, base_url=EXCLUDED.base_url,
    model=EXCLUDED.model, key_ref=EXCLUDED.key_ref;"
```
Campos DeepSeek já preenchidos. `base_url` valida https no uso; `key_ref` tem CHECK
`LIKE 'secret://%'` no banco (a chave em claro é recusada pelo próprio schema).

### 8.4 · VERIFICAR antes do ensaio (o resolver acha a chave, sem vazá-la)
Dois sinais:
```bash
# (a) o worker leu SECRET_BACKEND/SECRET_DIR/FX_USD_BRL (log de boot, não-secreto):
docker compose logs worker | grep 'worker F2 de pé'
#   → {"secretBackend":"file","secretDir":"/run/secrets/btv","fxUsdBrl":"5.40", ...}

# (b) DOCTOR: resolve o key_ref do tenant e passa a guarda fail-closed — SEM o valor:
docker compose run --rm --entrypoint node worker dist/secret-doctor.js "$TENANT"
#   → {"result":"OK","message":"chave resolvida ... pronta para o ensaio",
#      "keyLength":51,"keyStartsWithSk":true}
```
Se o arquivo tiver permissão frouxa, sumiço, ou for placeholder, o doctor **falha com o
motivo** (fail-closed) — e não imprime a chave. FX ausente aparece como aviso.

### 8.5 · Rodar o ensaio
Depois do doctor OK: iniciar a instância que dispara o `agentTask` (Console/API) e
acompanhar no Operate (custo real por chamada + versão da tabela). *(Destrava com a
injeção do provider real no job — a peça em curso citada acima.)*
