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
- **§2.24 — Ator humano em `history_events` (correção de dados, AG-3.3 ponto 4).**
  Verificação pedida pelo dono antes da UI da timeline: os eventos HUMANOS (conclusão de
  user task, decisão de gate, claim/unclaim) não gravavam ator consultável no MESMO
  envelope `{type,id,requestId}` dos fatos de agente — em três dos quatro casos não
  gravavam NADA (conclusão sem `decisionVar` = zero linha; claim/unclaim = zero linha;
  reprovação de gate = nenhum efeito roda, logo nenhum envelope chega à trilha). Corrigido
  sem migração (payload jsonb livre): `userTaskCompleted` (fato universal de conclusão,
  incondicional), `taskClaimed`/`taskUnclaimed` (novos), e **`gateDecision`** (kind
  PRÓPRIO, substituindo o `taskDecision` genérico para gates) — gravado NO MOMENTO da
  decisão do gate (aprovar OU reprovar), nunca dependente do efeito a jusante rodar.
  Refinamento do limite D13/D32 ("auditoria ≠ execução"): a fronteira protege é-lida-para-
  executar — `instance_gate_state`/`approved_actor` seguem sendo o estado MUTÁVEL que o
  efeito lê para selar; nenhum dos dois (decisão nem efeito) lê a TRILHA para agir. A
  DECISÃO humana ganhar seu próprio fato imutável não viola isso — é o que a trilha existe
  para guardar. `motivo` da decisão de gate segue o RBAC do histórico (evidência de Art.14
  EU AI Act, não dado reservado — SEM os dois níveis do kill-switch). **[RESOLVIDO]**
  (PR da correção de dados, AG-3.3, antes da UI da timeline).
  Detalhe: `packages/db/src/runtime/userTasks.ts`, testes `decision.test.ts`,
  `agent-gate-e2e.test.ts`, `human-actor-trail.test.ts`.
- **§2.25 — Rótulos/voz para os 4 kinds novos de `history_events` (AG-3.3 ponto 4).**
  `userTaskCompleted`, `gateDecision`, `taskClaimed`, `taskUnclaimed` são kinds NOVOS
  (não existiam quando `ag3-3-marcacao-timeline-custo.md` foi marcada — aquela marcação
  cobre só os campos de custo em `agent:acao`). Hoje caem no fallback honesto de
  `historyLabel`/`voiceOf` (mostram o `kind` cru, nunca escondem) — mas a timeline
  "unificada humano+agente" fica mais legível com rótulo humano para os quatro. **[ABERTO
  — GATILHO: marcação da timeline de custo (ag3-3-marcacao-timeline-custo.md) OU uma
  marcação própria destes 4 kinds]**. Detalhe: `apps/console/src/voices.ts`.
- **§2.26 — REQUISITO NOMEADO, ligado ao P1: `GateDetail.tsx` precisa coletar `motivo` da
  decisão de gate (conformidade real, não só técnica).** A API já aceita `reason` opcional
  em `POST /v1/user-tasks/:id/completion` (§2.24, `gateDecision.motivo`) — mas a UI do P1
  não tem CAMPO NENHUM para digitá-lo. Sem esse campo, `motivo` nasce sempre `null`:
  **conformidade no papel, não na prática** — a decisão A do dono (motivo da reprovação é
  evidência do Art.14 EU AI Act) só se cumpre quando o motivo é de fato capturado no
  momento da decisão. Não bloqueia a v1 (o fato `gateDecision` com ator+decisão já fecha o
  buraco de auditoria mais grave); mas é dívida de conformidade em aberto, não frouxidão de
  produto. **Escopo do campo**: motivo **obrigatório no reprovar**, opcional no aprovar
  (razão: reprovação sem justificativa é a lacuna que o Art.14 mais teme; aprovação já tem
  o world-delta como evidência do quê foi aprovado). **NÃO inventar voz/rótulo/posição do
  campo aqui** — mesma regra que gerou o P1 original: rótulo e tratamento são do design.
  **[ABERTO — GATILHO: marcação do designer para o campo de motivo no P1 (`GateDetail.tsx`,
  aprovar/reprovar) — aguardando, junto com §2.25, a próxima marcação do designer]**.
  Detalhe: `packages/db/src/runtime/userTasks.ts` (`reason` já aceito, ignorado sem UI),
  `apps/console/src/routes/GateDetail.tsx` (tela a alterar).
- **§2.27 — Nome de exibição do ator HUMANO ainda não resolvido na timeline (AG-3.3
  UI).** A marcação aprovada pede "humano → iniciais em verde + nome" — construí o
  suporte completo no `ActorBadge` (shared-ui): tom verde (`data-tone='human'`) +
  iniciais em círculo QUANDO recebe `displayName` resolvido, com o MESMO degrade
  honesto do `KillSwitchBanner` (`displayName` ausente → id cru, sem iniciais, nunca
  "desconhecido"). O que falta: a rota `GET /v1/instances/:id/history` ainda NÃO resolve
  `displayName` (ao contrário de `GET /v1/ai/config` que já faz via `resolveActor`,
  AG-3.2) — hoje a timeline mostra sempre o `id` cru para atores humanos. Não é
  "esqueci"; é escolha deliberada: `resolveActor` de UM ator por resposta (kill-switch)
  é barato; a história pagina até 100 linhas, cada uma podendo ter um ator humano
  DIFERENTE — resolver displayName por linha pede um `findByIds` em lote (não existe
  hoje; `UserRepository.findById` é 1-a-1), não um `resolveActor` chamado 100x por
  página. **Cuidado registrado para a implementação (G-UX-3, revisão da timeline):** o
  `findByIds` em lote precisa correr sob o MESMO RBAC do histórico (`instances:read`) —
  nunca um caminho mais amplo só porque é "resolução de nome"; resolver displayName não
  pode virar um jeito indireto de vazar identidade de usuário a quem não teria acesso à
  linha. **[ABERTO — GATILHO: decisão do dono sobre adicionar `findByIds` em lote +
  resolução de displayName na rota de histórico]**. Detalhe:
  `packages/shared-ui/src/selo.tsx` (`ActorBadge`, pronto para receber `displayName`),
  `apps/api/src/routes/ai.ts` (`resolveActor`, o padrão de referência).
- **§2.28 — Estado de garantia do recibo de auditoria muda quando a ancoragem externa
  existir (A7, decisão do dono).** O recibo hoje sempre declara `assurance: 'self-recorded'`
  (D30 — sem notarização externa/WAL imutável ainda, infra do Gate de Piloto). A marcação da
  tela A7 (export de auditoria) reflete essa garantia real, não a "bloco #N sequencial" que o
  protótipo original desenhava sem essa informação existir. Quando a infra de ancoragem
  externa entrar (WAL imutável no Postgres do piloto, item do Gate — `docs/privacy/gate-piloto.md`),
  o valor de `assurance` passa a ter um estado novo (`'externally-anchored'` ou equivalente) e
  **o cartão do recibo muda de novo** — não antes. **[ABERTO — GATILHO: infra de ancoragem
  externa do Gate de Piloto entrar em produção]**. Detalhe:
  `docs/handoff/a7-inventario-export-auditoria.md` §2 (decisão A),
  `packages/db/src/audit/export.ts` (`ASSURANCE_NOTE`, `assurance:'self-recorded'`).

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
