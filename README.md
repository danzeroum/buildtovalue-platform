# buildtovalue-platform

Plataforma SaaS BuildToValue (privada): BPMS multi-tenant — API, motor de
execução, worker e Console. O domínio BPMN (engine, forms, registry, ledger)
vem do repo público [`danzeroum/bpmn`](https://github.com/danzeroum/bpmn) por
versões publicadas exatas (D5).

**Contrato de execução:** `docs/handoff/PLANO-buildtovalue-platform-v1.2.md` +
`docs/handoff/ADENDO-01-parecer-design.md`. Arquitetura: `docs/architecture/c4.md`.

## Desenvolvimento

```bash
pnpm install
docker compose -f infra/docker/compose.dev.yml up -d   # postgres + jaeger
cp .env.example .env
pnpm db:migrate                                        # papel app_migrator
pnpm --filter @platform/api dev
pnpm --filter @platform/worker dev
pnpm --filter @platform/console dev
```

## Qualidade

```bash
pnpm lint && pnpm -r run build && pnpm typecheck
TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

Os testes de `packages/db` sobem um database descartável e validam o
**isolamento de tenants por RLS com o papel real da aplicação** (D7) — esse
teste é permanente e bloqueia regressão de policy.

## Estrutura

Ver seção 4 do plano. Resumo: `apps/{api,worker,console}` +
`packages/{config,observability,db,auth,api-contracts,shared-ui}` +
`infra/docker` + `docs/{architecture,privacy,runbooks,reports}`.
