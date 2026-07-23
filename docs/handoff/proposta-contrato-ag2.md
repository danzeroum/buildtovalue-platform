# Proposta de contrato — AG-2 (runtime de agente na plataforma) · **GATE**

> **Status:** proposta aguardando **aprovação do dono** (política 3.2 — nenhuma
> migração, rota nova, RBAC ou cripto entra antes). Fecha a frente F-AG do
> ADENDO-02 (D26–D31) na plataforma privada, consumindo a AG-1 (Squad Lane) já
> entregue na biblioteca.
>
> Este documento propõe SHAPE. Números de migração e nomes finais só depois do
> seu "ok". Onde marco **[GATE]**, é item que exige sua aprovação explícita.

## 0. Princípios herdados (não-negociáveis)

- **Não-determinismo (D27):** o interior do `agentTask` (LLM real) fica FORA do
  D6/replay. Fronteiras do job (enfileirar/concluir) seguem determinísticas. A
  trilha é EVIDÊNCIA gravada, jamais insumo de replay. **Aceite:** nenhuma
  fixture de replay do engine contém interior de agentTask (lint de teste).
- **Output de agente nunca é comando de governança:** saída de LLM não
  promove/aprova/assina; efeito externo só por **tool com gate** (D31) — mesma
  cerca do copilot, agora no runtime (mitiga prompt injection).
- **Segredo só como `secret://…`** (D29) — nunca em claro no corpo/OpenAPI.
- **LGPD:** trilha e bundle mascaram por classificação; o teste "ledger nunca
  contém conteúdo pessoal" passa a varrer TAMBÉM bundles de agente (D30).

## 1. Migrações propostas **[GATE]**

| Tabela/coluna | Para quê | D |
|---|---|---|
| `tenant_ai_config` (provider, modelo, `key_ref secret://`, budget, kill-switch) | inteligência do tenant | D29 |
| `tenant_tools` (tool, habilitada, `requires_gate bool`, escopo) | governança de tools | D31 |
| `history_events` — novos `kind` de trilha + coluna mascarável de I/O (origem rotulada: intenção/ação/I-O/decisão/evidência) | trilha de corrida | D27/D30 |
| **`incidents.payload jsonb`** | **re-enfileirar dead-letter** (fecha a ERRATA §7 — hoje 409 honesto) | D22 |
| Âncora de **Evidence Bundle** + **ledger real com salt-por-registro** (ADR-0002 item 3) | evidência ancorada; hash de conteúdo só com salt junto | D30 |

## 2. Rotas /v1 propostas **[GATE — extensão de contrato]**

- **Config de inteligência** (`operate:act`/admin): `GET/PUT /v1/ai-config` —
  `key` só como `secret://`; **kill-switch** por tenant; budget. Nunca ecoa o
  segredo.
- **Tools** (admin): `GET /v1/tools`, `PATCH /v1/tools/{name}` (habilitar/
  `requires_gate`). **Invariante dupla (UI + runtime):** tool irreversível sem
  gate no caminho **não executa** (par do lint + enforcement).
- **Gate de agente = user task em "modo agente"** (D28): a conclusão do gate
  estende a de user task com **`expectedInstanceRevision` + hash do escopo
  aprovável**; se a instância avançou (mundo obsoleto), **409** e a UI
  re-hidrata. "Escalar" = reatribuição D24. *(Compatível com a conclusão atual;
  a extensão é aditiva.)*
- **Leitura da corrida/trilha/bundle** (`operate:read`): `GET
  /v1/instances/{id}/agent-runs` e `.../trail` (cursor, mascarado), bundle
  ancorado. Rótulo **`evidência-verificada` é EXCLUSIVO de runtime real** (teste:
  simulação nunca exibe).

## 3. `agentTask` no runtime (sem contrato novo — reusa D22)

`agentTask` do BPMN → job `jobType:"agent"` no `JobHandlerRegistry` (herda
lease/fencing/retry/dead-letter/D22). Handler = **AgentRunner real** (nós
`llm` via `AIProvider` do tenant, nós `tool` via tools habilitadas); grava
fatos de trilha; `BlockedDecision` (retry/budget/sem-provider) → incidente com
voz de operador. **Provider mock por fixtures** para testes determinísticos.

## 4. Itens da triagem F3 que entram junto (decisões suas)

- **Aprovar/Reprovar de 1ª classe (F3):** hoje a decisão é um CAMPO do form (a
  conclusão rejeita chave fora do schema). Se quiser botões dedicados, escolha:
  (a) **campo reservado** de decisão no schema do form; ou (b) **`decision`** no
  corpo da conclusão de user task. **[GATE — extensão de contrato]**
- **RBAC `instances:start` × `definitions:read` (F3):** business inicia mas não
  lista definições. Escolha: (a) conceder `definitions:read` ao business; (b)
  endpoint de "definições iniciáveis" escopado por `instances:start`; (c) tirar
  `instances:start` do business. **[GATE — RBAC]** Hoje o console oculta o botão
  para não dar em beco.
- **Métricas agregadas do Operate:** cartões (ativas/incidentes/p95) pedem um
  endpoint de contagem — proponho `GET /v1/metrics/summary` (pós-v1, não bloqueia).

## 5. Sequência sugerida (após seu "ok"), espelhando a AG-1

1. **AG-2.0 [GATE]:** este contrato + migrações aprovados.
2. **AG-2.1:** migração + `AIProvider` (mock por fixtures) + `tenant_ai_config`
   + kill-switch; `incidents.payload` + retry de dead-letter real (fecha ERRATA).
3. **AG-2.2:** AgentRunner + trilha mascarada + invariante D31 (UI+runtime).
4. **AG-2.3:** gate de agente (D28 fencing) no console (modo do detalhe, não rota).
5. **AG-2.4:** trilha no drill-down do Operate + `evidência-verificada` + bundle
   ancorado (ledger real + salt).
6. **AG-2.5 [aceite]:** demo e2e de agente (`agentTask` → deploy → corrida →
   gate → trilha → evidência), runbook estendido.

**Nada acima é implementado antes da sua aprovação desta proposta.**
