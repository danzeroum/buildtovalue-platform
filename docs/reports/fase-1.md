# Relatório — Fase 1: Fundação da plataforma

> **Data de fechamento:** 2026-07-22 · **Tag:** `phase-1`
> **Status:** ACEITA — todos os entregáveis F1.1–F1.8 verdes, incluindo o
> walking skeleton com o engine PUBLICADO pinado exato (D5).

## Aceite da fase (plano v1.2 §5/F1) — item a item

| Critério | Evidência |
|---|---|
| **Skeleton verde (incluindo crash test)** | `apps/api/tests/skeleton-crash.e2e.test.ts`: **100 instâncias** start→serviceTask(noop)→end com `@buildtovalue/engine@1.1.0-next.1` **instalado do npm, pinado exato** (+ `core@1.2.0-next.0`). Kill nas DUAS janelas críticas: (A) depois do commit do avanço e ANTES do dispatch — os 200 efeitos sobrevivem na outbox e são despachados exatamente uma vez na retomada; (B) no meio do lote do dispatcher — rollback e re-dispatch idempotente (≥2 mortes injetadas). Fencing D12 pelo CONTRATO público: lease expirada re-tomada por outro worker, token velho = 409 problem+json, conclusão dupla = 409. **Resultado: 100 completed, revision=2 cada, 100 jobs exatos (zero duplicata), outbox 0.** É a métrica SMART 9.4 ("100 instâncias sem efeito duplicado") cumprida. |
| **RLS testada** | Suíte permanente `packages/db/tests/rls-isolation.test.ts` (9 casos, papel real `app_api` sem BYPASSRLS) + RLS forçada nas 3 tabelas do runtime (0002). |
| **SDK compila no console** | Pipeline `sdk:generate` (openapi-typescript + openapi-fetch) roda no typecheck/build do console em CI; client tipado consumido no shell. |
| **Backup + restore ensaiado** | `docs/runbooks/database.md`: ensaio de 2026-07-22 — dump + sha256 OK + restore em banco limpo com `schema_migrations` íntegra e **RLS sobrevivendo ao restore**. |
| **Compose sobe api+worker** | `infra/docker/compose.dev.yml` + Dockerfiles multi-stage entregues; api+worker validados como PROCESSOS contra Postgres 16 real (toda a suíte). **Ressalva honesta:** a subida CONTAINERIZADA não foi executada neste ambiente (sem daemon Docker) — item registrado em `pendencias.md` §3 para smoke em máquina com Docker. |

## Entregáveis (histórico das PRs)

- **PR #1** (mergeada): F1.1–F1.7 — scaffold, config zod, observability com
  redaction testada, migração 0001 com RLS (D7), auth (JWT+refresh rotativo,
  RBAC v1), API /v1 (problem+json, rate limit por tenant, OpenAPI), console
  D23 + SDK, shared-ui D25 (contraste AA testado), infra, CI.
- **PR #3** (mergeada): migração 0002 (instances/outbox/jobs com RLS,
  UNIQUE(effect_key), UNIQUE(wait_key)), dispatcher SKIP LOCKED com efeito
  aplicado + linha deletada na MESMA tx, contrato de jobs com lease+fencing,
  18 testes de integração; ADR-0002 proposto; fix da corrida de CREATE ROLE.
- **PR final da fase**: serviço de avanço (tx única estado+outbox com
  revision otimista, `StateMigrator` stub D14), fachada do runtime, rotas
  `POST /v1/instances`, `GET /v1/instances/:id`,
  `POST /v1/jobs/{id}/complete|fail` (D22), worker com loop dispatch+jobs
  concluindo pelo contrato público, e o crash test acima.

## Do lado da biblioteca (F0a/F0b, repo bpmn — contexto do fechamento)

F0a concluída; F0b.2/F0b.4 aceitas (engine extraído com equivalência
sim×engine por igualdade nos pontos de pausa + corpus de replay byte-a-byte);
F0b.5/6 entregues (forms com `value` reservada e `dataClassification`
obrigatória; forms-react com stories). Release em **pre mode `next`** (45
changesets reconciliados na PR #167); publish destravado após 3 releases de
depuração (guarda pre-mode-aware, fail-fast de NPM_TOKEN, secret corrigido
pelo dono).

## Follow-ups registrados (não bloqueiam a F2)

1. `ENGINE_VERSION` interna (1.1.0-next.0) ≠ versão do pacote (1.1.0-next.1)
   — o bump do changesets não toca a constante. Corrigir no repo bpmn com
   teste de sincronia constante×package.json (entra no aceite da F0b).
2. Smoke containerizado do compose (ambiente com Docker).
3. Promoção do trem `-next` a estável no aceite da F0b (`changeset pre exit`).

## Métricas SMART (9.4) no fechamento

- "skeleton executa 100 instâncias sem efeito duplicado" — **CUMPRIDA** (evidência acima).
- p95 advance e fluxo-alvo em cliques: alvos da F2/F3, medição armada pela
  observabilidade (histogramas HTTP; métricas de runtime chegam com o
  dispatcher da F2).
- "zero vazamentos de tenant, sempre" — suíte permanente verde.
