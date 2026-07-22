# ADENDO-02 ao Plano v1.2 — Agentes e Squads de IA como critério de lançamento

> **Anexar a:** `docs/handoff/PLANO-buildtovalue-platform-v1.2.md` (após o ADENDO-01)
> **Data:** 2026-07-22 · **Status:** aguardando aprovação do dono → segue ao desenvolvedor
> **Fontes:** decisão do dono (22/07); análise profunda da biblioteca (`agentflow` A-1..A-7,
> `agentTask` core/react, `copilot`, Handoff 22 Squad Lane com 9 protótipos hi-fi não
> implementados); BRIEFING-designer-agentes-squads; protótipos P1–P7 e Parecer do designer
> da plataforma (aprovado, com decisões a–d e duas adições).
>
> **O que muda:** a v1 passa a ser F3 + **F-AG** + Gate de Piloto. Nenhuma decisão D1–D25
> é alterada; este adendo acrescenta D26–D31, a fase F-AG e itens novos ao Gate 8.4.

---

## 1. Decisões novas

- **D26 — Critério de lançamento revisado.** Agentes de IA e squads são condição de
  lançamento da v1 (diferencial principal da plataforma). A v1 = F3 (MVP BPMS) + F-AG
  (agentes/squads, seção 3) + Gate de Piloto. A esteira F3 atual NÃO para nem muda.

- **D27 — Arquitetura do runtime de agente.** O `agentTask` do BPMN gera um **job**
  `jobType: "agent"` no `JobHandlerRegistry` (D4r) — herda lease, fencing, retry,
  dead-letter e D22 (execução fora de transação). O handler é o **AgentRunner real**:
  caminha o grafo `agentflow` (3 nós, decoradores, validação e budget da biblioteca),
  executa nós `llm` via `AIProvider` do tenant, nós `tool` via tools habilitadas, e nós
  `decision` por saída estruturada (métrica implícita continua proibida). Cada passo grava
  **fatos de trilha** em `history_events` (intenção → ação → I/O mascarado → decisão →
  evidência), com origem rotulada. `BlockedDecision` (retry esgotado, budget estourado,
  rota sem match, tenant pausado) vira **incidente** tipado com o termo de produto
  "parada honesta" — nunca erro genérico.
  **Invariante de não-determinismo (crítica):** o interior do `agentTask` NÃO é
  determinístico (LLM real) — **D6/replay não se aplicam dentro dele**. O que permanece
  determinístico é o avanço BPMN ao redor (o job completa com resultado; o engine avança
  como sempre). A trilha é EVIDÊNCIA gravada, jamais insumo de replay. Proibido tentar
  tornar chamadas de LLM reproduzíveis; proibido incluí-las em fixtures de replay do
  engine.

- **D28 — Gate de agente = user task em "modo agente" na Tasklist** (decisão a do
  parecer). Mesma fila, mesmo claim persistente (D21), mesmas ações; o corpo do detalhe
  troca para: ação em linguagem de negócio, **world-delta** ("o que muda no mundo se você
  aprovar"), tripla efeito/autorização/evidência, trecho da trilha que motivou o pedido,
  dial de autonomia com o gate marcado, budget consumido. Saídas: aprovar / reprovar com
  motivo / escalar (= reatribuição D24, mesmo componente e verbo da Tasklist).
  **Fencing de mundo obsoleto (achado do parecer, obrigatório):** a conclusão do gate
  carrega a `expectedInstanceRevision` (e o hash do escopo aprovável); se a instância
  mudou de forma relevante desde a carga, o servidor responde **409**, a UI re-renderiza o
  world-delta atualizado e avisa — nunca se aprova um mundo que já não existe. O escopo da
  aprovação é EXATO ("aprova ESTE envio, não a categoria") e fica registrado no evento.

- **D29 — Inteligência do tenant.** `AIProvider` configurado por tenant com chave
  exclusivamente como **referência a secret manager** (`secret://…`) — nunca campo em
  claro (precedentes: H9/copilot e KeyProvider D20). Budget por tenant/processo com
  enforcement no runtime: estouro projetado ou real = parada honesta, nunca continuação.
  **Kill-switch com confirmação auditada** (adição do parecer): motivo obrigatório,
  efeito explícito no momento do clique ("agentes em execução fazem parada honesta; gates
  humanos seguem valendo"), evento de auditoria; jobs `agent` novos não são lockados
  enquanto pausado; reativação também auditada.

- **D30 — Evidência e ancoragem.** O rótulo **`evidência-verificada` é exclusivo do
  runtime real e imposto por código**, não por convenção: só eventos gerados pelo host em
  execução real o carregam; simulação (biblioteca) jamais o exibe — travado nos tokens/
  legenda do `shared-ui` e num teste. O **Evidence Bundle** da corrida é ancorado no
  **ledger real** com o `canonicalJson` + cadeia do core (mesma da F3), estendendo o
  ADR-0002: hashes de conteúdo com **salt por registro**, e o teste nomeado "ledger nunca
  contém conteúdo pessoal" passa a varrer também bundles de agente (I/O de trilha é
  mascarado na gravação conforme classificação D20).

- **D31 — Governança de tools por tenant.** Catálogo com habilitar/desabilitar por
  tenant, auditado (quem habilitou o quê, quando); efeito e autorização vêm do
  ToolContract da biblioteca em leitura. **Invariante dupla (UI e runtime):** tools de
  efeito `write-irreversible`/`external-commitment` NUNCA têm autorização `automatica` —
  o runtime recusa executá-las sem gate aprovado no caminho (par do lint
  `EFFECT_NEEDS_GATE`/`GATE_NOT_COVERING` no deploy); `proibida` bloqueia lock do job.
  Matriz editável fina: F4.

## 2. Escopo v1 por superfície (conforme parecer aprovado)

| Superfície | v1 | Ajustes do Bloco 1 incorporados |
|---|---|---|
| P1 Gate de agente | completa (modo do detalhe de tarefa) | world-delta (adição aceita); fencing de mundo obsoleto; "Escalar" = reatribuição D24 |
| P2 Execução no Operate | completa (camada no drill-down do token) | trilha virtualizada (critério H22: 500 passos a 60fps) + filtros da tela 07; `evidência-verificada` sempre visível e explicável |
| P3 Squad em execução | leitura | 6 arestas por traço+ícone+rótulo (E9), nunca só cor |
| P4 Inteligência do tenant | completa | kill-switch com confirmação auditada (adição aceita) |
| P5 Catálogo de tools | mínima | garantia visual da invariante D31; trilha de habilitação |
| P6 Deploy com lint de agente | completa | mesma UI de rejeição da tela 04; remediação em linguagem de negócio |
| P7 Evidence Bundle | card + selo de ancoragem | sem formato de hash novo — cadeia do core |

Decisões a–d do parecer ficam vinculantes: P1 = modo (não rota); trilha no drill-down
(não rota própria); Squad Studio **por ponte** `?load=<versionId>` (editor é da
biblioteca; a plataforma acrescenta só publicação — mesma tese do /studio F3).

## 3. Fase F-AG (entra entre o fim da F3 e o Gate de Piloto)

**AG-1 · Biblioteca: implementar o Handoff 22** (pode iniciar JÁ, em paralelo à esteira
F3 — repo `bpmn`, ordem de PRs SL-1..SL-13 do próprio handoff; espec e 9 protótipos
prontos). Inclui o headless (SquadManifest, readinessState, promptCoverage,
simulateSquad, validações novas incl. `EFFECT_NEEDS_GATE`/`GATE_NOT_COVERING`/
`AUTONOMY_CHAIN`), Squad Studio, inspector por abas, ponte BPMN, Evidence Bundle. Publica
por minors no trem `-next`. RECONCILIACAO.md ao final, como manda o handoff.

**AG-2 · Plataforma: runtime de agente** (após contrato aprovado — seção 4). Migração de
schema (gate): `tenant_ai_config`, `tenant_tools`, colunas/kinds de trilha em history.
AgentRunner (D27), enforcement de budget, kill-switch (D29), invariante de tools (D31),
lint de agente no deploy (extensão D19 consumindo as validações da AG-1), trilha com
mascaramento por classificação, ancoragem do bundle (D30). **Provider mock por fixtures
no CI** (determinístico, zero custo); provider real só em execução manual/piloto.

**AG-3 · Plataforma: superfícies P1–P7** (após ajustes do Bloco 1 aplicados aos
protótipos e AG-2 utilizável). Modo agente na Tasklist, camada no Operate, P3 leitura,
P4, P5 mínima, P6, P7. Gate de UX herdado integralmente: estados não-ideais próprios da
frente (sem provider, budget estourado, trilha vazia, tenant pausado), axe serious = 0,
heurísticas nos PRs, contraste do âmbar da parada honesta verificado no token.

**AG-4 · Demo e2e de agentes** (fecha a fase): processo com `agentTask` → deploy passa no
lint → instância corre → agente age → **gate humano aprova via world-delta** (incluindo o
teste do 409 de mundo obsoleto) → efeito externo executa → parada honesta demonstrada em
outro ramo → Evidence Bundle ancorado e verificável → tudo no runbook de demo, executável
por não-desenvolvedor. É a demo de venda do produto.

## 4. Contrato e regime (política 3.2 preservada)

As extensões da `/v1` (config de inteligência do tenant, tools, semântica de completion
do gate com `expectedInstanceRevision`, leitura da corrida/trilha/bundle) **exigem
proposta de shape para aprovação do dono ANTES de implementar** — mesma mecânica da PR #9,
como adendo ao documento do contrato. Migrações novas, RBAC novo (se houver permissão de
agente), criptografia/ledger: **gate**. Implementação do shape aprovado, superfícies e
biblioteca (AG-1): autônomas. Designer no circuito (G-UX-1/G-UX-3), incluindo a legenda
compartilhada dos rótulos de origem da trilha entre biblioteca e plataforma.

## 5. Aceites nomeados da F-AG

1. Fencing de mundo obsoleto: teste de aprovação contra instância que mudou → 409 +
   re-render; escopo exato registrado no evento de aprovação.
2. Kill-switch: teste da semântica completa (parada honesta dos em-execução; gates
   humanos seguem; novos jobs não lockam; reativação; tudo auditado com motivo).
3. Invariante D31 no runtime: tool irreversível sem gate no caminho não executa (par do
   lint testado nos dois lados).
4. Budget: estouro → parada honesta nomeando nó/razão/contagem; nunca continuação.
5. `evidência-verificada` imposta por código (teste: simulação nunca exibe o rótulo).
6. Ledger: bundle ancorado; teste "nunca contém conteúdo pessoal" varrendo bundles;
   salt por registro (ADR-0002 estendido).
7. Não-determinismo respeitado: nenhuma fixture de replay do engine contém interior de
   agentTask (lint de teste).
8. Demo AG-4 verde no e2e + runbook.
9. UX: estados não-ideais da frente + axe serious = 0 + arestas sem dependência de cor.

## 6. Gate de Piloto (8.4) — itens novos

7. Provider real do tenant piloto configurado via secret manager; chave estática reprova
   (extensão natural do D20).
8. Kill-switch ensaiado uma vez com evidência.
9. Demo AG-4 executada de ponta a ponta no ambiente do gate.

## 7. Fora de escopo da v1 nesta frente (F4/F5 — conforme parecer)

P3 rico/animado; delegação multi-nível; matriz de governança de tools editável; políticas
avançadas de budget; import LangGraph na UI; Live Mode/telemetria rica; colaboração em
tempo real no Agent/Squad Studio.

## 8. Riscos novos e mitigação

| Risco | Mitigação |
|---|---|
| Custo/flakiness de LLM no CI | Provider mock por fixtures no CI (AG-2); real só manual/piloto |
| Tentativa de "replay" de LLM | D27 invariante + aceite 7 (lint de teste) |
| Latência de LLM × lease do job | Dimensionar `leaseMs` por tipo agent + renovação de lease no handler (D22 já mantém tudo fora de tx) |
| Saída de LLM virando comando de governança | Princípio do copilot estendido ao runtime: output de agente nunca promove/aprova/assina; efeitos externos só via tools gated (D31) — mitiga também prompt injection |
| Aprovação de mundo obsoleto | D28 fencing + aceite 1 |
| Trilha vazando dado sensível | Mascaramento por classificação na gravação + redaction leak-fail existente + aceite 6 |
| H22 (AG-1) maior que o estimado | Espec com ordem de PRs pronta; AG-1 inicia já em paralelo; checkpoint por PR SL-N |

## 9. Efeito no calendário (honesto)

A F-AG adiciona as duas maiores peças novas desde o engine: a implementação do H22 na
biblioteca (AG-1) e o AgentRunner real (AG-2). No ritmo atual da esteira: AG-1 em
paralelo desde já; estimativa incremental da frente na ordem de **1–2 semanas** sobre o
plano anterior, com o gate de UX das superfícies como maior incerteza. A v1 continua
sendo a mesma definição — agora com a demo que nenhum concorrente tem.
