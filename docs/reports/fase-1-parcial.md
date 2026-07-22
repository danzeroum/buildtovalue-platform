# Relatório parcial — Fase 1 (fundação)

> **Data:** 2026-07-22 · **Status:** F1.1–F1.7 ENTREGUES; F1.8 (walking
> skeleton) ABERTO aguardando `@buildtovalue/engine@1.1.0-next.N` publicado
> (ponto de sincronização com a F0b, D5). Este arquivo vira `fase-1.md` no
> fechamento, com o skeleton verde.

## Entregue (branch `claude/buildtovalue-platform-setup-decvzt`)

| Entregável | Evidência |
|---|---|
| F1.1 scaffold (pnpm, TS strict, ESLint base do bpmn, vitest, changesets) | raiz do repo; `pnpm lint` verde |
| F1.2 config + observability | `packages/config` (zod, falha listando todas as variáveis); `packages/observability` (pino + redaction com teste-guardião que falha se sensível/`variables` vazar; métricas Prometheus) |
| F1.3 db: RLS 0001 + isolamento | `packages/db/migrations/0001_tenancy_auth.sql` (RLS FORÇADA, papéis app_migrator/app_api separados, NUNCA bypassrls); runner forward-only com checksum; **teste permanente de isolamento contra Postgres real** (9 casos, inclui WITH CHECK cross-tenant e morte do SET LOCAL) |
| F1.4 auth | scrypt nativo; JWT curto HS256 + refresh OPACO rotativo (hash em banco); RBAC v1 por permissão |
| F1.5 api + SDK | Fastify 5 `/v1` (login/refresh/me), problem+json RFC 9457, rate limit por tenant, X-Request-Id, OpenAPI 3.1 servido; SDK do console gerado do OpenAPI em CI (openapi-typescript + openapi-fetch) — compila |
| F1.6 infra | compose dev (postgres+jaeger), Dockerfiles multi-stage, backup.sh; **restore ENSAIADO 2026-07-22** (runbook `database.md`: sha256 OK, RLS sobrevive ao restore) |
| F1.7 CI | `.github/workflows/ci.yml`: lint → build → typecheck → testes com postgres service → cobertura |
| D25 (ADENDO-01) | `packages/shared-ui`: tokens por papel semântico, regra do mono, pisos a11y COM teste de contraste AA, densidade por espaçamento; console consome só tokens |
| D23 | shell do console com rótulos humanos (Tarefas · Formulários · Operação · Estúdio) + sublabel mono da rota |

Gate local: lint + build + typecheck + **52 testes verdes** (incl. RLS real).

## Aberto para fechar a F1

1. **F1.8 walking skeleton** — bloqueado por: engine publicado (F0b.2, em
   andamento). Inclui: tx única state+outbox com `effect_key`, dispatcher
   `SKIP LOCKED`, handler trivial via contrato de jobs com `lock_token`,
   crash test com re-dispatch idempotente, e a métrica SMART "100 instâncias
   sem efeito duplicado".
2. Dry-run do `release.yml` PELO Actions (dono dispara na UI; 403 para a
   integração) antes do prerelease do engine.
3. Tag `phase-1` + promoção deste relatório a `fase-1.md`.

## Achados técnicos registrados

- Policy RLS precisa de `NULLIF(current_setting(...), '')`: GUC customizada
  revertida por fim de transação volta como string vazia, não NULL — pego
  pelo teste de isolamento antes de qualquer código de produção depender.
- `--experimental-strip-types` do Node não resolve specifiers `.js`→`.ts`;
  execução direta de TS ficou com `tsx` (dev-only), produção roda `dist/`.
