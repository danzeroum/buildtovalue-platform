# Relatório — Fase 3: MVP utilizável

> **Data:** 2026-07-23 · **Status:** trazido para **triagem final do dono**
> (junto da proposta de contrato da AG-2, `docs/handoff/proposta-contrato-ag2.md`).
> Derivado do PLANO v1.2 §F3 + ADENDO-01 §6 + `docs/handoff/plano-f3.md` +
> triagem da fase-2 (22/07).
>
> Regime de autonomia: cada leva foi PR estratégica com CI verde e squash;
> desvio de contrato = pergunta antes do merge (nenhum nesta fase — só desvios
> de PROTÓTIPO, registrados). GATE (contrato/migração/RBAC/cripto) permanece
> com o dono.

## Aceite da fase (plano v1.2 §F3) — item a item

| Critério | Evidência | Status |
|---|---|---|
| **API MVP completa** (`/v1`, problem+json, cursor, Idempotency-Key) | 31 rotas /v1 (auth, instances, definitions, user-tasks, operate) mergeadas nas levas 1–5; OpenAPI emitido com todas (fix #17); e2e de contrato contra Postgres real (`apps/api/tests/*.e2e.test.ts`). | ✅ |
| **/studio mínimo** — deploy com **lint D19 visível** | PR #18: `PublishModal` roda o lint D19 do perfil governado ANTES do deploy, separa REJEIÇÃO/AVISO por cor+rótulo, bloqueia a publicação com a contagem. Designer = biblioteca (lazy). | ✅ |
| **/forms v1** — aviso "sensitive não buscável" + consequências D20 | PR #18: editor + preview pelo MESMO renderer; marcar «sensível» revela as 4 consequências D20 no momento da escolha (item bloqueante). | ✅ |
| **/tasks** — claim/unclaim, formulário pinado, validação no servidor | PR #19: claim persistente D21 (token rotacionado exigido na conclusão), 409 com detentor, form pinado no mesmo renderer, **422 mapeado por campo**, «Reatribuir» (D24, operador). | ✅ |
| **/operate mínimo** — drill-down, incidentes, XES, **variáveis D20** | PR #19: posição no diagrama (viewer + overlay de token), incidentes retry/resolve (dead-letter = 409 honesto), jobs/timers/histórico, export XES, **variáveis sensíveis mascaradas com revelação auditada (fail-closed)**. | ✅ |
| **Protótipos das 4 rotas antes** (G-UX-3) | `docs/handoff/Prototipos Console Plataforma.dc.html` + parecer; a implementação seguiu as telas 01–06. | ✅ |
| **Heurísticas G-UX nos PRs de interface + `axe serious = 0`** | Helper `expectNoSeriousAxe` em todas as telas novas; 47 testes de console (jsdom + Testing Library + vitest-axe). Revisão adversarial de a11y aplicada (abas↔painel, aria-pressed, foco em diálogo, loading com texto). | ✅ |
| **e2e Playwright do fluxo-alvo** | Spec de navegador contra os seletores reais (`apps/e2e/`, typecheck ok) + **smoke HTTP** que sobe API+worker e dirige o fluxo (`smoke:flow`). **Parcial/honesto:** o run de navegador não foi executado no sandbox da sessão (mata multi-servidor); cobertura e2e no CI vem dos testes de CONTRATO. Wire-up de job de navegador = pendência. | ◑ |
| **Aceite: fluxo-alvo executável por não-dev via runbook** | `docs/runbooks/demo.md` — passos (criar/migrar/semear banco, subir pilha, click-path) **verificados contra Postgres real**; `seed:demo` provado. | ✅ |

## Critérios que a triagem da F2 moveu para o ACEITE da F3 (nomeados)

| Critério | Evidência | Status |
|---|---|---|
| **Fencing formal de user task com `claim_token` (D21)** — estilo crash test | Leva 4 (migração 0005) + `apps/api/tests/user-tasks.e2e.test.ts`: claim sobrevive a RESTART da API, token rotacionado mata o anterior (10.b), reatribuição D24 invalida e audita, validação por form pinado (422 por campo), ZERO conclusão dupla, papel alheio filtrado/403. | ✅ |
| **Lint D19 issue #2** — "boundary só sobre atividade de espera" (`EXEC_BOUNDARY_HOST_NOT_WAITING`) | Implementado na F3.1 (gate) com casos de teste; catálogo de 9 códigos. | ✅ |
| **Integração do ledger real (`@buildtovalue/audit`) + salt-por-registro (ADR-0002 item 3)** | Dono = fluxo de publish/promoção do registry (F3.2), que já existe (deploy imutável + lint). A costura da CADEIA real de auditoria com hash+salt-por-registro NÃO entrou nesta fase — é **migração** (coluna/estrutura nova) = **GATE**, movida para a proposta da AG-2. O teste "ledger nunca contém conteúdo pessoal" segue verde nas tabelas do host; varrer TAMBÉM a cadeia real entra com a migração. | ◑ → AG-2 |
| **p95 do avanço** | `docs/reports/p95-advance.md`: p50 5.96ms · **p95 7.89ms** · p99 11.44ms (Postgres real, N=500). Harness reproduzível (`bench:p95`). | ✅ |

## Pendências e decisões do dono (de `pendencias.md §2.5`)

1. **Aprovar/Reprovar de 1ª classe** — a conclusão valida a submissão e rejeita
   chave desconhecida; a decisão é modelada como CAMPO do form (o seed já traz
   `decisao`). Botões dedicados exigem extensão de contrato → **AG-2**.
2. **RBAC `instances:start` sem `definitions:read`** (business) — o console
   oculta «Iniciar processo» para não dar em beco; decisão de RBAC = **GATE**.
3. **Dead-letter re-enfileirável** — precisa de coluna `payload` em `incidents`
   = migração → **AG-2** (já registrado na ERRATA §7).
4. **Métricas agregadas do Operate** (128 ativas, incidentes abertos, p95 no
   cartão) — sem endpoint de contagem na v1; candidato a endpoint de métricas.
5. **Job de CI do e2e de navegador** — instalar Chromium + orquestrar
   API+worker+console; o sandbox da sessão não roda multi-servidor.
6. **Ledger real + salt-por-registro** — migração da AG-2 (item acima).

## Próximo passo (STOP — política 3.2)

A esteira F3 está pronta para a **triagem final**. O próximo movimento é um
**GATE**: a proposta de contrato da AG-2 (agentes/squads + os itens de migração
acima), em `docs/handoff/proposta-contrato-ag2.md`, aguardando sua aprovação
antes de qualquer migração/rota nova.
