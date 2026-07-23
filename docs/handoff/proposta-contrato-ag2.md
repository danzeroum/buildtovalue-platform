# Proposta de contrato — AG-2 (runtime de agente + governança) · **v2** · **GATE**

> **Status:** v2 aguardando **aprovação do dono** (política 3.2). Incorpora a
> triagem final da F3 (as duas decisões respondidas) e o **ADENDO-03 / Atlas de
> Governança (D32–D37, ISO 42001 · EU AI Act)** — que entrou no repo depois da
> v1. **Adiciona sem remover** nada da v1.
>
> Aprovada esta v2 = **AG-2.0**; depois AG-2.1→2.5 no regime combinado
> (migração/RBAC/contrato = gate; resto autônomo, **checkpoint por etapa**).
> Onde marco **[GATE]**, exige seu "ok" explícito.

## 0. Princípios herdados (não-negociáveis)

- **Não-determinismo (D27):** interior do `agentTask` (LLM real) FORA do
  D6/replay; fronteiras do job determinísticas; trilha é EVIDÊNCIA, nunca insumo
  de replay. Aceite: nenhuma fixture de replay contém interior de agentTask.
- **Output de agente nunca é comando de governança:** efeito externo só por tool
  com gate (D31) — mesma cerca do copilot (mitiga prompt injection).
- **Segredo só como `secret://…`** (D29) — nunca em claro no corpo/OpenAPI.
- **Evidência nunca é conteúdo** (ADENDO-03): provas com dados mascarados;
  `evidência-verificada` só do runtime real (D30); o ledger nunca contém
  conteúdo pessoal — o teste passa a varrer TAMBÉM bundles de agente e as duas
  trilhas.

## 1. Migração 0006 — mesmo pacote de gate **[GATE]**

Uma aprovação cobre agente + governança (o pacote já teria migração).

| Item | Para quê | D |
|---|---|---|
| **`REVOKE UPDATE, DELETE ON history_events FROM app_api`** | trilha imutável POR PERMISSÃO, não disciplina (runtime nunca usa por design — custo zero, prova máxima) | D32 |
| **`tenant_audit_events`** append-only (INSERT-only p/ app_api, RLS+FORCE) — eventos de governança SEM instância | casa própria da trilha de tenant | D33 |
| `tenant_ai_config` (provider, modelo, `key_ref secret://`, budget, kill-switch) | inteligência do tenant | D29 |
| `tenant_tools` (tool, habilitada, `requires_gate`, escopo) | governança de tools | D31 |
| `history_events` — novos `kind` de trilha + coluna mascarável de I/O (origem rotulada) | trilha de corrida de agente | D27/D30 |
| **`incidents.payload jsonb`** | re-enfileirar dead-letter (fecha a ERRATA §7) | D22 |
| bindings do pino ganham **`user_id`** (tenant_id já existe) | contexto de autorização | D34 |

**Envelope de ator padronizado nas DUAS trilhas** (campo de 1ª classe
CONSULTÁVEL, nunca enterrado em payload): `actor { type: 'user'|'system'|
'agent', id, requestId }`. `tenant_audit_events` nasce com os campos que a F4
precisa (senão vira migração retroativa de trilha imutável):
`actor`, `event_type`, `resource_type`, `resource_id`, `motivo`, `payload
jsonb`, `request_id`, **referência de ancoragem recuperável por evento/
intervalo**, `created_at`. `ip`/`user_agent` **só** em eventos de autenticação,
com retenção mínima (nota LGPD no registro de tratamento).

**Catálogo de `event_type` v1 (publicar no contrato)** — inicial:
`auth.login`, `auth.refresh.denied`, `config.ai.updated`, `config.tools.updated`,
`agent.killswitch.toggled`, `audit.exported`, `audit.integrity.verified`,
`variable.revealed`, `incident.resolved`, `task.reassigned`. (Extensível; o
catálogo é parte do contrato para o auditor.)

## 2. Rotas /v1 propostas **[GATE — extensão de contrato]**

### 2a. Governança / auditoria (ADENDO-03)
- **`GET /v1/audit/export`** (D36) — filtros `período/ator/event_type/
  resource_type`; formatos **JSON/CSV**; tenant implícito do JWT; permissão nova
  **`audit:export`** (a própria exportação é auditada). **Recibo** com **digest
  ancorado** no corpo (anatomia no Atlas E4). XES por instância permanece.
- **`POST /v1/audit/integrity`** (D35) — recalcula o digest canônico de um
  intervalo das duas trilhas, retorna resultado + **bloco ancorado**; a
  verificação **vira ela mesma evento de auditoria**.
- **Negações (D34):** toda negação vira log estruturado (usuário, recurso, ação,
  permissão exigida, resultado) + métrica; **persistência em
  `tenant_audit_events` só para recursos de alta sensibilidade** (reveal, config
  de inteligência, tools, kill-switch, export). Gravar todo DENIED em banco é
  vetor de escrita sob ataque (Anexo C-15, rejeitado).

### 2b. Agente (ADENDO-02)
- **Inteligência do tenant** (`admin`): `GET/PUT /v1/ai-config` — `key` só
  `secret://`; **kill-switch** por tenant (interrupção do Art. 14 EU AI Act);
  budget. Nunca ecoa o segredo. Mudança = evento de auditoria (D33).
- **Tools** (`admin`): `GET /v1/tools`, `PATCH /v1/tools/{name}`. **Invariante
  dupla (UI + runtime):** tool irreversível sem gate no caminho **não executa**.
- **Gate de agente = user task em "modo agente"** (D28): conclusão estende a de
  user task com **`expectedInstanceRevision` + hash do escopo aprovável**;
  instância avançada (mundo obsoleto) → **409**, UI re-hidrata. "Escalar" =
  reatribuição D24.
- **Leitura da corrida/trilha/bundle** (`operate:read`):
  `GET /v1/instances/{id}/agent-runs` e `.../trail` (cursor, mascarado por
  classificação), bundle ancorado. `evidência-verificada` EXCLUSIVO de runtime
  real (teste: simulação nunca exibe).

### 2c. Herdadas da triagem F3
- **Conclusão de user task com decisão** (decisão **a** do dono, opção **b** —
  `decision` no CORPO, não campo de schema): `POST /v1/user-tasks/{id}/completion`
  passa a aceitar `decision?: string` além de `submission`. Ver §4 (sub-decisão
  de roteamento volta com você).
- **Definições iniciáveis** (decisão **b** do dono, opção **b**):
  **`GET /v1/startable-definitions`** — projeção `{id, name, version}` **sem
  XML**, escopada por `instances:start` (menor privilégio: `business` lista o que
  pode iniciar sem ganhar `definitions:read`). O console volta a exibir «Iniciar
  processo» para `business` quando a rota existir.

## 3. `agentTask` no runtime (sem contrato novo — reusa D22)

`agentTask` → job `jobType:"agent"` no `JobHandlerRegistry` (herda lease/
fencing/retry/dead-letter/D22). Handler = **AgentRunner real** (nós `llm` via
`AIProvider` do tenant, nós `tool` via tools habilitadas); grava fatos de
trilha; `BlockedDecision` (retry/budget/sem-provider) → incidente com voz de
operador. **Provider mock por fixtures** para testes determinísticos.

## 4. As decisões da triagem F3 — respondidas, com sub-decisão pendente

- **Aprovar/Reprovar = `decision` no corpo (opção b).** Mantém schemas de form
  limpos e alinha com o gate de agente (aprovar/reprovar/escalar são AÇÕES do
  gate). **Sub-decisão para VOCÊ na aprovação da v2 — como a decisão aterrissa
  para o gateway rotear:**
  - **Opção A — variável reservada por elemento:** o `decision` grava
    `<elementId>.decision` (namespace reservado); a condição do gateway lê
    `aprovar_reembolso.decision = "aprovar"`. Zero config no BPMN, mas acopla a
    condição ao id do elemento.
  - **Opção B — variável-alvo declarada no BPMN (RECOMENDADA):** o `userTask`
    declara `properties.decisionVar` (ex.: `"aprovacaoReembolso"`); o `decision`
    grava nessa variável; o gateway lê `aprovacaoReembolso = "aprovar"`.
    Explícito, desacoplado do id, e o lint D19 pode exigir que um gateway a
    jusante referencie a variável declarada. **Recomendo B.**
  *(Ambas usam o avaliador de gateway de igualdade — já suportado. Sem mudança
  de engine.)*
- **RBAC = `GET /v1/startable-definitions` (opção b).** Detalhe em §2c.
- **Unificação do avaliador de form (pendência §2.6 — item da AG-2.1):**
  confirmado que o servidor reusa o avaliador de GATEWAY (igualdade) no
  `validateSubmission`, enquanto o preview do console usa comparações+and/or →
  form com `valor > 5000` reprova no servidor. Correção D10 (fonte única):
  **`@buildtovalue/forms` exporta o avaliador de FORM** (comparações+and/or) e
  console + servidor consomem; apaga as duas cópias. Minor de biblioteca (bpmn)
  + consumo na plataforma. Interim: o seed do demo usa só igualdade.

## 5. Sequência sugerida (após seu "ok"), espelhando a AG-1

1. **AG-2.0 [GATE]:** esta v2 + migração 0006 aprovadas (inclui a sub-decisão de §4).
2. **AG-2.1:** migração 0006 + append-only (D32) + `tenant_audit_events` (D33) +
   envelope de ator + `user_id` nos bindings + negados em log/métrica/persistência
   seletiva (D34) + `incidents.payload` e retry de dead-letter real (ERRATA §7) +
   **unificação do avaliador de form** + `AIProvider` (mock por fixtures) +
   `tenant_ai_config` + kill-switch + `GET /v1/startable-definitions` +
   `decision` na conclusão. Dossiê de conformidade v1 (D37).
3. **AG-2.2:** AgentRunner + trilha mascarada + invariante D31 (UI+runtime).
4. **AG-2.3:** gate de agente (D28 fencing) no console (modo do detalhe, não rota).
5. **AG-2.4:** trilha no drill-down do Operate + `evidência-verificada` +
   **ledger real + salt-por-registro** + **job de ancoragem de digest (D35)** +
   `GET /v1/audit/export` + `POST /v1/audit/integrity`.
6. **AG-2.5 [aceite]:** demo e2e de agente (`agentTask` → deploy → corrida →
   gate → trilha → evidência) + **run de navegador do e2e-alvo UMA VEZ com
   evidência** (fecha o ◑ da F3, conforme sua triagem) + runbook estendido.

## 6. Gate de Piloto (8.4) — itens novos dos ADENDOS 02+03

10. Evidência das permissões append-only (dump dos grants + teste de UPDATE negado).
11. Arquivamento imutável de WAL/PITR no Postgres do piloto.
12. Export de auditoria demonstrado com recibo de ancoragem verificado.
13. Dossiê de conformidade v1 preenchido e revisado pelo dono.

## 7. Rejeições registradas (Anexo C — não reimplementar)

Triggers de banco para auditoria (12); hash encadeado por linha (13);
infra de assinatura própria para exports (14); persistir TODA negação em banco
(15). Substituídos por: auditoria explícita + append-only por permissão +
ancoragem de digest (D35) + desenho do D34.

**Nada acima é implementado antes da sua aprovação desta v2.**
