# Pendências e decisões diferidas — registro CANÔNICO

> **Fonte única** de dívida técnica, limitações declaradas e decisões adiadas do
> BuildToValue. Substitui o `pendencias.md` externo (fora do repo) — a partir de
> agora, "registrar em pendências" = **editar este arquivo**. As seções mantêm a
> numeração `§` já referenciada em relatórios/dossiê para os cross-refs continuarem
> resolvendo. Não é exaustivo cirurgicamente; é o LUGAR ÚNICO — o dono completa o que faltar.
>
> Recuperado por varredura dos relatórios de fase + dossiê (2026-07-24). Status:
> **[ABERTO]** · **[RESOLVIDO]** (data/PR) · **[GATILHO]** (condição que o reabre/força).

## §1 · Precedentes metodológicos (coexistências sob gate)

- **§1.1 — Isenção do lint `btv:gate`.** O gate humano (userTask `btvGate`) é isento
  do `formRef` obrigatório (a decisão é aprovar/reprovar, sem formulário) — `lint.ts`
  `EXEC_FORM_REF_MISSING` pula gates. **[RESOLVIDO]** (F3.1 leva 4 / D31).
- **§1.2 — Coexistência `simulation × engine`.** Precedente do Anexo C item 2: duas
  implementações sob corpus de equivalência compartilhado até o colapso. **[RESOLVIDO]**
  como método; ver §2.7 para a instância viva (forms).

## §2 · Decisões & dívidas nomeadas

- **§2.4 — Limitação da API v1 (Idempotency-Key / 409).** Documentada no OpenAPI +
  `proposta-api-v1-mvp.md`. **[ABERTO/registrado]** — comportamento aceito na v1.
- **§2.5 — RBAC `business` `instances:start` sem `definitions:read`.** O Console oculta
  "Iniciar processo" para `business` (o modal não listaria definições). **Decisão de RBAC
  do dono.** **[ABERTO — decisão do dono]** (F3 / demo.md).
- **§2.6 — Avaliador de condição v1** (subset S-FEEL do gateway) — decisão de autonomia F2.
  **[RESOLVIDO]** (F2, subset publicado; validável).
- **§2.7 — Avaliador de forms: 3 implementações sob corpus.** Compartilham corpus de
  equivalência até o **colapso pós-`forms@1.1`** (ponto de colapso nomeado). **[ABERTO —
  GATILHO: publicação de `@buildtovalue/forms@1.1`]** → colapsar para 1 implementação.
- **§2.14.2 — Triagem do shape do export (AG-2.3).** **[RESOLVIDO]** (#41, AG-2.3 —
  envelope de ator normalizado + coverage no recibo).
- **§2.16 — Laço com espera não suportado (`EXEC_LOOP_WAIT_UNSUPPORTED`).** O runtime v1
  não honra re-entrada em elemento de espera (`waitKey` colide → deadlock); o lint recusa
  no deploy (D37). **Correção real:** identidade de token FRESCA por iteração,
  determinística sob replay — **lote de lib da AG-3**. **[ABERTO — AG-3 lib]**.
- **§2.17 — Reavaliação de proposta expirada (`agentProposalExpired`).** Sem reavaliação
  automática na v1 (evita o laço da Q4); a reproposta é explícita, cap 3. A "reavaliação"
  (re-propor contra o estado novo) exige re-entrada no `agentTask` — bloqueada por §2.16.
  **[ABERTO — depende de §2.16]**.
- **§2.18 — Aprovar/Reprovar de 1ª classe.** Botões dedicados de gate (vs decisão como
  campo de form) — extensão de contrato. **[EM ANDAMENTO — AG-3.1 P1]** (marcação do
  designer aprovada; fatia de backend + UI em curso).
- **§2.19 — Métricas agregadas do Operate** (128 ativas / incidentes abertos / p95 no
  cartão) — sem endpoint de contagem na v1. **[ABERTO]** — candidato a endpoint de métricas.
- **§2.20 — Decisões de autonomia F2** (itens 6–9): `example@1` embutido, relógio da
  varredura de timers, fórmula do `seq` de auditoria. **[RESOLVIDO/validável]** (F2).
- **§2.21 — Migração do Console para `react-router` v8.** Único fix da exceção de audit
  `GHSA-qwww-vcr4-c8h2` (v7.x sem patch; `react-router-dom` não tem 8.x; v8 mudou API).
  Leva PRÓPRIA, fora da fase de superfícies. **[ABERTO — GATILHO: revisão de 60 dias
  (2026-09-22) OU o Console adotar RSC/server actions OU advisory novo em react-router]**.
  Detalhe: `docs/security/audit-exceptions.md`.
- **§2.22 — `brace-expansion` (GHSA-mh99-v99m-4gvg), sem fix possível do nosso lado.**
  Advisory novo no CI da PR #57 (AG-3.2 UI). Sem patch nas linhas antigas (`1.x`/`2.x`,
  usadas por `minimatch` transitivo em `eslint`/`@vitest/coverage-v8`) — o fix só chegou a
  partir de `~3.0.2`/`5.0.2`. **Override forçado testado e revertido**: quebra em runtime
  (`brace_expansion_1.default is not a function` — API incompatível entre majors da mesma
  linha de versão). Fix real depende de upstream (`eslint`/`@vitest/coverage-v8`
  atualizarem sua dependência de `minimatch`). **[ABERTO — GATILHO: revisão de 60 dias
  (2026-09-22) OU nova major de `eslint`/`@vitest/coverage-v8` OU advisory novo]**.
  Detalhe: `docs/security/audit-exceptions.md`.
- **§2.23 — Endpoint de agregação de custo por instância (decisão do dono, timeline
  AG-3.3).** A v1 da timeline mostra custo **só por linha** (exato, por-passo) — SEM total
  agregado no cabeçalho do drill-down. Razão registrada: o histórico é paginado
  (`limit: 100`); um "total" que soma só a página carregada mentiria sobre o próprio
  escopo ("quanto a instância custou" sem realmente somar a instância inteira) — pior que
  não ter total. Se "quanto esta instância gastou" virar requisito real de cliente, a
  resposta correta é um **endpoint de agregação próprio** (soma no servidor, sobre TODA a
  trilha da instância, não sobre uma página) — não um cálculo aproximado no cliente.
  **[ABERTO — GATILHO: requisito de cliente nomeado para "custo total por instância"]**.
  Detalhe: `docs/handoff/ag3-3-inventario-timeline-custo.md` §3.3.

## §3 · Infra & ambiente (Gate de Piloto)

- **§3.1 — Smoke containerizado do compose.** api+worker validados só como PROCESSOS
  (sem daemon Docker no ambiente da sessão); a subida CONTAINERIZADA não foi executada.
  **[ABERTO — GATILHO: máquina com Docker]** (F1/AG-2.2; item aberto do Gate de Piloto).
- **§3.2 — Job de CI do e2e de navegador.** Chromium + orquestrar API+worker+console.
  **[PARCIAL]** — o job de navegador (axe + target-flow + carregando) entrou (#43); o e2e
  multi-servidor completo do fluxo-alvo segue aberto.
- **§3.3 — Retorno do repo `buildtovalue-platform` a PRIVATE.** Público de propósito até
  o fechamento da v1; o retorno é ITEM DO GATE (decisão do dono, 22/07). **[ABERTO —
  decisão do dono]** (gate-piloto.md item 6).
- **§3.4 — Infra do piloto** (cofre gerenciado/KMS, WAL imutável, TLS). Reprova o Gate por
  construção hoje (env/estático). Ver `docs/privacy/gate-piloto.md` + `gate-piloto-auditoria.md`
  (§A/§B/§C) + `docs/runbooks/deploy-vps.md §7`. **[ABERTO — infra do piloto]**.

---

*Manutenção: ao registrar nova pendência, adicione aqui com status e (se houver) gatilho.
Ao resolver, marque **[RESOLVIDO]** com data/PR — não remova (o histórico é auditável).*
