# Plano de desenvolvimento v1.2 — `danzeroum/buildtovalue-platform`

> **Para:** desenvolvedor Claude Code
> **De:** arquitetura BuildToValue
> **Data:** 2026-07-21
> **Status:** VALIDADO FINAL — contrato de execução
> **Substitui:** v1.1 (que substituiu a v1.0)
>
> A v1.2 incorpora a última rodada de validação externa. As mudanças concentram-se no
> Anexo A (ADR-0001) e no DDL da F2 — defeitos do tipo que o ADR-0001 existe para prevenir,
> corrigidos ANTES da execução. O aceite firmado sobre a v1.1 permanece válido; este é o texto
> que governa. Anexo C (rejeições) ampliado — não reimplementar nem rediscutir.

---

## 0. Changelog v1.1 → v1.2

1. **Anexo A corrigido (bloqueantes):** catálogo de efeitos completado com `CloseUserTask`,
   `CancelJob` e `CancelTimer` por chave de espera (boundary interruptivo e `CancelInstance`
   eram inimplementáveis sem eles); `Wait.key` substituída por `waitKey` determinística gerada
   pelo ENGINE (`elementId:tokenId`) — o host mapeia `waitKey ↔ effect_key` (pureza restaurada);
   `variables` presente em TODOS os eventos que podem atravessar gateway; ids de token derivados
   deterministicamente do token pai (pool de ids removido); `AdvanceResult` tipado separando
   rejeição de negócio de defeito interno (defeito lança e reverte, nunca vira incidente
   silencioso); invariante nova: `advance()` nunca retorna variáveis de negócio.
2. **DDL da F2 corrigido:** SEM particionamento na v1 (convergência de três analistas) —
   `UNIQUE(effect_key)` simples na outbox (que é fila efêmera, não série histórica); índices
   operacionais definidos; particionamento de `history_events` vira decisão pós-piloto por
   métricas. D16 revisado.
3. **Busca de variáveis:** tabela lateral `variable_search_keys` + colunas nativas para
   built-ins; generated columns rebaixadas a alternativa registrada (Anexo C).
4. **Elementos BPMN não suportados: fail-fast.** Rejeição no deploy (lint/perfil da biblioteca)
   + incidente defensivo no runtime. Nunca ignorar silenciosamente. (D19)
5. **Sincronização F0b↔F1 explícita:** F1 inicia em paralelo; o walking skeleton é o ponto de
   sincronização e só fecha consumindo versão PUBLICADA exata do engine (prerelease `-next.N`
   pinada exata, promovida a estável no aceite da F0b). D5 preservado.
6. **Dispatcher refinado:** conexão DEDICADA para `LISTEN` (incompatível com pooler em
   transaction mode); polling dinâmico (fila vazia → 1s; com itens → 100ms; fallback 60s).
7. **Handlers fora da transação (D22):** worker executa handler em contexto assíncrono e
   completa via `POST /v1/jobs/{id}/complete` com `lock_token` — testa o contrato público
   desde o dia 1.
8. **`StateMigrator`** na carga da instância: migrações puras encadeadas por
   `stateSchemaVersion`; versão antiga demais → incidente pedindo intervenção, nunca falha
   silenciosa.
9. **Claim de user task ≠ lease de job (D21):** claim persistente, sem expiração automática na
   v1; `claim_token` exigido para concluir/desatribuir/delegar; revogação pelo operador é
   auditada. Evita "formulário longo que expira".
10. **Criptografia com `KeyProvider` (D20):** três níveis — dev local (chave estática em .env),
    CI (chave efêmera do pipeline), piloto/produção (secret manager/KMS obrigatório). Chave
    estática NÃO passa no gate de piloto. Limitação documentada: campo `sensitive` cifrado não
    é buscável por conteúdo.
11. **F0b começa com spike de 1–2 dias (D18)** mapeando kernel×host no `simulation` e o custo
    real da extração; corpus de equivalência FILTRADO ao subconjunto v1 (fixtures complexas
    puladas com skip explícito e reativadas na F5); ADR-0001 apresentado ao dono com 2–3
    alternativas de formato.
12. **F0a condicionada às pendências §1 do repo `bpmn`:** publicar somente pacotes efetivamente
    liberados; qualquer pacote ainda workspace-only sai da lista e entra em minor futuro.
13. Miscelânea: migrações forward-only (rollback = fix-forward + restore ensaiado); v1 sem
    Redis (cache só em memória de processo onde seguro, com ADR se surgir necessidade);
    disciplina orval (endpoint estável no OpenAPI antes de o console consumi-lo); estimativa
    de referência F0a→Gate: ~14–22 semanas com um desenvolvedor focado.

---

## 1. Decisões travadas (não rediscutir sem ADR aprovado pelo dono)

### Herdadas (essência inalterada)

- **D1 — Dois repositórios.** `danzeroum/bpmn` público (Apache-2.0): domínio, engine, contratos
  de formulário, registry, ledger. `buildtovalue-platform` privado: produto SaaS. Secrets,
  regras comerciais e dados de clientes nunca entram no repo público.
- **D2 — Engine determinístico na biblioteca.** `@buildtovalue/engine` puro:
  `advance(state, event)` sem I/O, `Date`, `Math.random`, `setTimeout`, async ou ordem de
  iteração não especificada. Tempo e insumos entram no evento. Host = persistência, locking,
  outbox, dispatch.
- **D3 — Formulários em três camadas.** Schema versionado (`@buildtovalue/forms`) → renderer
  (`@buildtovalue/forms-react`) → apps. User task referencia `formId@versão`; instância antiga
  exibe o formulário pinado.
- **D4r — Contrato de jobs primeiro, SDK depois.** Contrato lock/complete/fail com lease é a
  única porta de execução de trabalho desde a F2; worker interno (`JobHandlerRegistry`) consome
  esse contrato; subset em `packages/api-contracts/src/jobs/` pronto para promoção futura a
  `@buildtovalue/worker-sdk`. Workers de terceiros: pós-v1.
- **D5 — Versões publicadas exatas** de `@buildtovalue/*`; nunca branch/commit/link local.
  Prerelease `-next.N` pinada exata é permitida como versão publicada (ver F1). Upgrades via
  Renovate com gate (9.3).
- **D6 — Replay é contrato.** Mudança que altere resultado de replay gravado = major.
- **D7 — RLS desde a migração 0001.** `tenant_id` em toda linha, RLS em toda tabela, teste
  permanente de vazamento.
- **D8 — TypeScript ponta a ponta na v1.**
- **D9 — Nome:** `buildtovalue-platform`.
- **D10 — Engine é EXTRAÇÃO.** Instrução literal para a F0b: *o `@buildtovalue/engine` deve ser
  criado por extração incremental da semântica já implementada em `simulation`, `core`, `sfeel`
  e demais pacotes relevantes do repo `bpmn`. É proibido reimplementar do zero qualquer
  comportamento que já possua teste, fixture ou corpus de conformidade na biblioteca.*
  Critério de aceite: equivalência simulation×engine por fixture (subconjunto v1) em CI; cada
  fixture equivalente gera fixture de replay.
- **D11 — `effect_key` determinística:** `hash(instance_id, revision, effect_index, effect_type)`
  atribuída pelo host; dedupe por unicidade. Base do exatamente-uma-vez lógico.
- **D12 — Fencing:** `lock_token` em jobs; complete/fail só com token vigente (409 caso
  contrário); lease expirado devolve à fila.
- **D13 — Fonte única.** `instances.state` = posição técnica; `variables` = dados de negócio.
  Variáveis entram no engine SÓ via `event.variables` (visão imutável) e saem SÓ via payload de
  efeitos; `advance()` nunca retorna variáveis; o banco atualiza `variables` com base em
  efeitos, nunca no `nextState`.
- **D14 — Estado autoversionado e migrável.** `stateSchemaVersion` + referências por
  `elementId` (porta da migração de instâncias, F5).
- **D15 — Console único** (`apps/console`: /studio /tasks /forms /operate).
- **D17 — Gate de piloto bloqueante** (seção 8.4).

### Revisadas ou novas na v1.2

- **D16r — Postgres para tudo, SEM particionamento na v1.** Tabelas comuns com índices
  operacionais (F2). Particionamento de `history_events` por mês é decisão pós-piloto disparada
  por métricas (crescimento, custo de vacuum, p95/p99 de consulta); outbox NUNCA é particionada
  (fila efêmera: linhas despachadas são deletadas — a tabela fica pequena por construção).
- **D18 — Spike antes da F0b.** 1–2 dias no `simulation` mapeando kernel puro × host/I-O e
  estimando o custo real da extração. Se o spike revelar acoplamento grave, PARAR e reportar ao
  dono com opções — não decidir sozinho.
- **D19 — Fail-fast para BPMN não suportado.** No deploy: validação/lint (perfil governado da
  biblioteca) rejeita definição com elementos fora do escopo v1 (OR-merge, compensação,
  escalation, correlação de message/signal, subprocessos avançados). No runtime (defensivo):
  encontro com elemento não suportado → `RaiseIncident` tipado. Nunca ignorar.
- **D20 — `KeyProvider` para criptografia.** Interface
  `{ encrypt(tenantId, plaintext) ; decrypt(tenantId, ciphertext) }`. Implementações: dev local
  = chave estática de `.env`; CI = chave efêmera do pipeline; piloto/produção = secret
  manager/KMS (uma chave global de produção é aceitável no piloto; por-tenant na F5). Trocar
  implementação nunca altera queries nem modelo de dados. Campo `sensitive` cifrado não é
  buscável por conteúdo — se o Operate precisar buscar por um campo, ele não pode ser
  `sensitive` na v1 (documentado no ADR-0002).
- **D21 — Claim de user task é persistente.** Sem expiração automática na v1; `claim_token`
  exigido para complete/unclaim/delegar; operador pode revogar claim com trilha de auditoria.
  Lease com expiração é exclusividade de jobs.
- **D22 — Handlers fora da transação.** O dispatcher marca o efeito/job e libera a transação;
  o handler executa em contexto assíncrono desacoplado e conclui via
  `POST /v1/jobs/{id}/complete` (ou `/fail`) apresentando `lock_token` — nunca chamada HTTP
  dentro de transação aberta, e o contrato público é exercitado desde o primeiro handler.

---

## 2. Arquitetura alvo

C4 Contexto + Container documentados UMA VEZ em `docs/architecture/`; sequências para os 3
fluxos críticos: (1) avanço com outbox, (2) lock/complete de job com fencing, (3) submissão de
formulário → avanço. Componente: sob demanda.

```
apps/console (SPA: /studio /tasks /forms /operate) ── HTTPS ──▶ apps/api ──▶ PostgreSQL (RLS)
                                                                  │  └─ tx única: state+outbox
                                                                  ▼
                                              outbox ──▶ apps/worker
                                              (LISTEN em conexão dedicada
                                               + polling dinâmico 100ms–1s
                                               + fallback 60s)
                                                                  │ marca e libera a tx
                                                                  ▼
                                              handler assíncrono (JobHandlerRegistry)
                                                                  │ lock_token
                                                                  ▼
                                              POST /v1/jobs/{id}/complete  → novo avanço
```

Sequência do avanço: api carrega instância → `StateMigrator` se `stateSchemaVersion` antigo →
monta `EngineEvent` (now, variables imutáveis) → `advance()` → se `ok:false` tipado, trata
rejeição; se exceção interna, ABORTA e alerta crítico → `UPDATE ... WHERE revision=:expected` →
INSERT efeitos (`effect_key`) na MESMA tx → commit → trigger `pg_notify('outbox')`.

---

## 3. Guardrails (fontes das skills — conteúdo inalterado da v1.1)

### G-ARQ (fonte: *Arquitetura de Software(s)* — Adriano Carezzato)
G-ARQ-1 Atributos de Qualidade (-ilities) em todo ADR: escalabilidade, performance, segurança,
disponibilidade, manutenibilidade, testabilidade, minimizando custo cumulativo. · G-ARQ-2 Leis
da Arquitetura: "toda decisão tem seu preço"; "só se avalia em contexto"; trade-offs explícitos
e não vazios. · G-ARQ-3 C4/4+1: Contexto+Container uma vez; sequências dos 3 fluxos críticos.
· G-ARQ-4 Refatoração: registrar oportunidades por fase (acoplamento, testes, padrões,
planejamento escalável). · G-ARQ-5 DevOps/CI-CD com automação de testes e containers. ·
G-ARQ-6 Observabilidade: logging, tracing, monitoramento para comportamento interno e gargalos.
· G-ARQ-7 Segurança por Design: criptografia de sensíveis, privilégio mínimo, LGPD/GDPR.

### G-COD (fonte: *Algoritmos e Padrões de Projetos* — Renan de Oliveira)
G-COD-1 SOLID (5 princípios; DIP: interfaces de repositório). · G-COD-2 Design Patterns
nomeados (Strategy, Observer, Command, Factory, Adapter, Facade, Template Method) sem
pattern-mania. · G-COD-3 Big-O documentado em caminho quente com justificativa da estrutura de
dados. · G-COD-4 Clean Code + 12-Factor (nomes, funções curtas, sem duplicação; config no
ambiente; logs como eventos).

### G-DAD (fonte: *Projeto e Arquitetura de Sistemas de Uso Intensivo de Dados* — Etienne Cartolano)
G-DAD-1 5 Vs (volume/velocidade/variedade/veracidade/valor) alinhados ao problema de negócio.
· G-DAD-2 Qualidade dos Dados: pipeline rastreável; histórico referencia `instance_id`, `seq`,
`engine_version`, `effect_key`. · G-DAD-3 Monólito modular: domínio definido, baixo
acoplamento, deploy independente por processo, escala horizontal sem fragmentação prematura. ·
G-DAD-4 Métricas SMART e ciclo analítico completo.

### G-BPM (fonte: *Sistemas Orientados a Processos* — Erica Siqueira)
G-BPM-1 Modelagem BPMN: eventos claros, gateways corretos (XOR/AND na v1), swimlanes,
subprocessos bem definidos. · G-BPM-2 DMN: regras de negócio fora do código; v1 = S-FEEL;
motor DMN completo na F5; regra complexa em handler exige ADR de dívida. · G-BPM-3
Orquestração: sync/async via digital workers, acoplamento fraco REST, tolerância a falhas. ·
G-BPM-4 Process Mining: `seq` + export XES 2.0 desde a v1; variantes visuais na F5.

### G-LGPD (fonte: *Privacy by Design / LGPD* — Samara Schuch)
G-LGPD-1 7 Princípios PbD. · G-LGPD-2 Base legal identificada e justificada por categoria de
dado. · G-LGPD-3 Pessoais vs sensíveis: `dataClassification` obrigatório; sensível → proteção
adicional + justificativa. · G-LGPD-4 Incidentes: cenários, plano de resposta, cadeia de
evidências (ledger).

### G-UX (fonte: *UX no Desenvolvimento de Software* — Paula Azevedo Macedo)
G-UX-1 Heurísticas de Nielsen registradas em PR de interface. · G-UX-2 Design centrado no
usuário (empatizar→definir→idear→prototipar→testar; personas: usuário de negócio, analista,
operador). · G-UX-3 Protótipo de baixa fidelidade antes — só telas novas de fluxo principal. ·
G-UX-4 Arquitetura de informação consistente entre rotas.

### G-API (fonte: *Projeto e Arquitetura de APIs* — Rafael Lachi / Weber Ress)
G-API-1 Substantivos autoexplicativos, métodos HTTP corretos, problem+json, exemplos no
OpenAPI. · G-API-2 Anti-patterns proibidos: sem versionamento/documentação/rate limit/logs;
endpoint não documentado. · G-API-3 Logs estruturados com contexto, métricas, tracing OTel. ·
G-API-4 Plugin architecture nos pontos extensíveis (handlers, adapters, tipos de campo): ponto
de entrada, interfaces, ciclo de vida, compatibilidade.

### 3.1 Matriz de aplicação por tipo de mudança

| Tipo de mudança | Guardrails obrigatórios no PR |
|---|---|
| Engine / runtime | G-ARQ-1/2, G-COD-3, replay (D6), crash+fencing tests, G-ARQ-6 |
| Banco / tenancy / migração | G-ARQ-7, G-LGPD-2/3, RLS testado, G-DAD-2 |
| API | G-API-1/2/3, auth, rate limit, idempotência, OpenAPI |
| Interface (console) | G-UX-1/4 (G-UX-3 se tela nova de fluxo principal), a11y, estados erro/vazio/carregando |
| Refatoração interna | testes verdes, G-COD-1/4, trade-offs se decisão relevante |
| Docs / infra | G-ARQ-5; revisão leve |

"N/A + justificativa curta" permitido.

### 3.2 Política de ADR
Obrigatório apenas para o irreversível: ADR-0001 (estado+efeitos), ADR-0002 (tombstones),
schema de banco público, contrato `/v1`, formato do schema de formulário, (futuro)
particionamento. Trade-offs (G-ARQ-2) e -ilities (G-ARQ-1) obrigatórios. ADRs de decisão
irreversível são apresentados ao dono com 2–3 alternativas, não proposta única.

---

## 4. Estrutura do monorepo

```
buildtovalue-platform/
  apps/
    api/             # Fastify + zod; /v1; auth, tenancy, OpenAPI
    worker/          # dispatcher (LISTEN dedicado + poll dinâmico), timers, JobHandlerRegistry
    console/         # SPA: /studio /tasks /forms /operate
  packages/
    db/              # schema, migrações forward-only (drizzle-kit), RLS, repositórios,
                     # crypto middleware + KeyProvider
    api-contracts/   # DTOs zod + OpenAPI; src/jobs/ isolado (futuro worker-sdk)
    auth/            # identidade, sessões, RBAC v1, tenancy helpers
    config/          # env validada (12-factor)
    observability/   # pino + redaction testada, métricas, OTel
    shared-ui/       # componentes comuns + Storybook
  infra/docker/      # compose dev (postgres, jaeger) + Dockerfiles multi-stage
  docs/architecture/ docs/privacy/ docs/runbooks/ docs/reports/
  .github/workflows/
```

Ferramentas: pnpm, TS strict, Fastify, drizzle, zod, vitest, pino, OTel, Playwright, ESLint
(config-base do `bpmn`), changesets, Renovate, orval/openapi-typescript, Storybook.
**Sem Redis na v1** — cache apenas em memória de processo onde comprovadamente seguro; qualquer
cache compartilhado exige ADR.

---

## 5. Fases de execução

> Cada fase fecha com tag `phase-N` e relatório `docs/reports/fase-N.md`.
> Dependências: F0a → destrava D5. F0b bloqueia F2 (engine) e F3 (forms). F1 ∥ F0b; o walking
> skeleton é o PONTO DE SINCRONIZAÇÃO e só fecha com engine publicado (prerelease pinada exata).

### F0a — Publicar a biblioteca existente (repo `bpmn`) — IMEDIATO
1. Solicitar `NPM_TOKEN` ao dono; dry-run do `release.yml`; validar.
2. **Conferir pendências §1 do repo:** publicar `1.0.0` somente dos pacotes efetivamente
   liberados (flags `private` atuais mandam); pacote ainda workspace-only sai da lista e entra
   em minor futuro. Engine NÃO bloqueia este publish.

**Aceite:** pacotes instaláveis; releases reproduzíveis; lista publicada documentada no
relatório.

### F0b — Engine e forms mínimos (repo `bpmn`) — em paralelo com F1
0. **Spike (D18, 1–2 dias):** mapear no `simulation` o que é kernel puro × host/I-O; estimar
   extração; reportar. Acoplamento grave → parar e apresentar opções ao dono.
1. **ADR-0001 antes de código** (Anexo A), com 2–3 alternativas de formato e trade-offs;
   aprovação do dono é gate.
2. **Extrair `@buildtovalue/engine`** (D10 — instrução literal). Escopo semântico v1:
   start/end, fluxo sequencial, XOR, AND (fork/join), user task, service task→`CreateJob`,
   timer intermediário e boundary simples (interruptivo e não-interruptivo sobre user task —
   viabilizado por `CloseUserTask`), `EmitHistory`, `RaiseIncident`, `CompleteInstance`,
   cancelamento com fechamento de esperas. Fora do escopo v1 (D19: rejeitados no deploy):
   OR-merge, compensação, escalation, error events complexos, correlação message/signal,
   subprocessos avançados.
3. Pureza por lint custom + teste (proibido `node:*`, `Date`, `Math.random`, `setTimeout`,
   async).
4. `simulation` → host em memória; **corpus de equivalência FILTRADO ao subconjunto v1**
   (fixtures complexas com skip explícito `todo:F5`); cada fixture equivalente gera fixture de
   replay (D6); comparação 100% automatizada (canonicalJsonExact) — zero intervenção humana.
5. **`@buildtovalue/forms` mínimo em formato definitivo:** text, textarea, number, date,
   select, radio, checkbox; `validation`/`visibleWhen` em S-FEEL; `dataClassification`
   obrigatório; `defaultValue`. Extras por minors.
6. **`@buildtovalue/forms-react`:** renderer puro + Storybook desde o primeiro componente.
   Para o editor de schema da F3, preferir base pronta (ex.: json-editor) a construir do zero —
   a persona analista não é técnica (G-UX-2).
7. Publicar `engine@1.1.0-next.N` cedo (para o skeleton da F1) e promover a estável no aceite.

**Aceite:** spike reportado; ADR-0001 aprovado; equivalência 100% no subconjunto v1; corpus de
replay em CI; pacotes publicados (estáveis).

### F1 — Fundação da plataforma (paralela à F0b)
1. Scaffold do monorepo; TS strict, ESLint, vitest, changesets.
2. `config` (zod), `observability` (pino + redaction + OTel + Prometheus).
3. `db`: migração 0001 com RLS (D7), `SET LOCAL app.tenant_id`, papel API sem BYPASSRLS, papel
   de migração separado; teste de isolamento permanente. Migrações **forward-only**
   (reversão = fix-forward; plano de emergência = restore ensaiado).
4. `auth`: usuários, tenants, JWT curto+refresh, papéis v1, middleware de permissão.
5. `api` esqueleto: `/v1`, health/ready, problem+json, rate limit por tenant, OpenAPI servido;
   pipeline orval gerando SDK tipado (disciplina: endpoint só entra no console após estável no
   OpenAPI).
6. `infra/docker`: compose dev; Dockerfiles; backup automatizado + runbook de restore.
7. CI: lint, typecheck, testes com postgres, build, cobertura por pacote.
8. **Walking skeleton (ponto de sincronização com F0b):** `start → service task → end` com o
   engine PUBLICADO (`-next` pinada exata): `advance()` → tx única (state + outbox
   `effect_key`) → dispatcher `SKIP LOCKED` → handler trivial via contrato de jobs
   (`lock_token`) → completo. Endpoints de start e consulta. Kill do worker no meio com
   re-dispatch idempotente.

**Aceite:** compose sobe api+worker; skeleton verde (incluindo crash test); RLS testada; SDK
compila no console; backup+restore ensaiado.

### F2 — Runtime confiável

DDL (migração 0002+; **sem particionamento — D16r**):

```sql
process_definitions(id, tenant_id, registry_ref, bpmn_version, engine_version, created_at)
instances(id, tenant_id, definition_id, engine_version, state_schema_version,
          state jsonb, revision int, status, business_key, created_at, updated_at)
variables(instance_id, tenant_id, name, value jsonb, classification, updated_at)
variable_search_keys(tenant_id, instance_id, name, value_text, updated_at)
  -- populada pelo worker para chaves de busca DECLARADAS por processo; índice
  -- (tenant_id, name, value_text). Built-ins buscáveis são colunas nativas de instances/
  -- user_tasks (business_key, status, assignee). Generated columns: alternativa registrada.
outbox(id, tenant_id, instance_id, effect jsonb, effect_key text UNIQUE,
       status, attempts, next_attempt_at, created_at)
jobs(id, tenant_id, instance_id, type, payload jsonb, status,
     locked_by, lock_until, lock_token uuid, retries_left, error, created_at)
timers(id, tenant_id, instance_id, element_id, wait_key, fire_at, status)
user_tasks(id, tenant_id, instance_id, element_id, wait_key, form_ref, assignee,
           candidate_roles, status, claim_token uuid, payload jsonb, created_at, completed_at)
incidents(id, tenant_id, instance_id, kind, message, effect_key, status, created_at)
history_events(id, tenant_id, instance_id, seq, kind, payload jsonb, engine_version,
               effect_key, occurred_at)

-- Índices operacionais:
CREATE INDEX outbox_ready_idx  ON outbox (status, next_attempt_at, created_at);
CREATE INDEX timers_due_idx    ON timers (status, fire_at);
CREATE INDEX jobs_available_idx ON jobs  (status, lock_until, created_at);
CREATE INDEX history_instance_idx ON history_events (instance_id, seq);
```

1. **Serviço de avanço:** carregar → `StateMigrator` (migrações puras encadeadas;
   `state_schema_version` antigo demais → incidente pedindo intervenção) → `advance()` →
   `ok:false` = rejeição tipada tratada; exceção interna = abort + alerta crítico (nunca vira
   incidente de processo) → UPDATE com revision → INSERT outbox na mesma tx → commit →
   `pg_notify`. Documentar Big-O do loop de retry.
2. **Dispatcher:** conexão DEDICADA para `LISTEN` (fora do pooler transaction-mode); consumo
   `FOR UPDATE SKIP LOCKED` (O(1) amortizado por item — documentar); polling dinâmico (vazia
   1s / com itens 100ms) + fallback 60s; idempotência por `effect_key`; backoff; dead-letter →
   `incidents`.
3. **Jobs (D4r/D12/D22):** lock emite `lock_token`; handler roda FORA da tx e conclui via
   `POST /v1/jobs/{id}/complete|fail` com o token; lease expirado devolve à fila; 409 para
   token velho. Handlers v1: `http-call`, `send-email`(stub), `webhook` — plugáveis (G-API-4).
4. **Timers:** varredura `fire_at <= now()` indexada → `TimerFired{waitKey}` → avanço.
5. **Histórico:** `seq` monotônico por instância + `effect_key` (G-DAD-2). Ledger: provas e
   referências, nunca conteúdo pessoal (teste).
6. **Costura LGPD:** middleware de criptografia com `KeyProvider` (D20) para campos
   `sensitive`; redaction no pino com teste que falha se sensível vazar em log.
7. **ADR-0002 decidido** (Anexo B); implementação plena pós-piloto.
8. Crash tests + fencing tests formais (job e user task).

**Aceite:** processo exemplo (user task + service task + timer boundary + XOR) fim-a-fim;
crash/fencing verdes; cancelamento fecha esperas (task some da Tasklist, job não conclui,
timer não dispara); métricas expostas; sequências 1 e 2 documentadas; ADRs aprovados.

### F3 — MVP utilizável
Fluxo-alvo: modelar → publicar → iniciar → tarefa aparece → preencher formulário → job interno
executa → timer dispara → encerra → histórico consultável.

1. API `/v1` do MVP: `process-definitions` (deploy do registry COM validação D19),
   `instances` (create/get/list/cancel), `variables`, `jobs` (lock/complete/fail),
   `user-tasks` (list/claim/unclaim/complete com `claim_token`; claim persistente D21;
   revogação auditada por operador), `incidents` (list/retry/resolve). Cursor, Idempotency-Key,
   problem+json.
2. Console /studio (mínimo): abrir/editar (designer da biblioteca), draft, publicar no
   registry, vincular `formId@versão`. Publicação roda lint D19 e mostra rejeições claramente.
3. Console /forms (v1): editor de schema (base pronta, ex. json-editor) + preview com o MESMO
   renderer; publicação no registry; aviso visual para `sensitive` incluindo "não buscável por
   conteúdo".
4. Console /tasks: minhas/do papel/não atribuídas; claim/unclaim; formulário pinado; submissão
   validada no SERVIDOR com o mesmo schema → avanço.
5. Console /operate (mínimo): instâncias com drill-down no diagrama (viewer) e posição atual;
   incidentes retry/resolve; jobs/timers pendentes; export XES (`toXES`).
6. UX: protótipos das 4 rotas antes (G-UX-3); heurísticas (G-UX-1); axe serious = 0.
7. E2E Playwright do fluxo-alvo.

**Aceite:** fluxo-alvo executável por pessoa não-desenvolvedora via runbook de demo; e2e
verde; OpenAPI completo com exemplos.

### GATE DE PILOTO (bloqueante — seção 8.4)

### F4 — Produto avançado (pós-piloto)
Form Builder drag-and-drop; Operate completo (filtros/dashboards; busca via
`variable_search_keys`); migração `bpmnPlay` → /play; migração do shell `@buildtovalue/studio`
+ limpeza dos apps do repo público; deep-link `?load=<versionId>`; delegação/filtros avançados
de Tasklist; quotas por tenant; particionamento de `history_events` SE métricas dispararem.

### F5 — Diferenciais (cada item com aceite próprio)
Migração de instâncias entre versões (fase própria; viabilizada por D14/ADR-0001); semântica
BPMN estendida (reativando fixtures `todo:F5`); motor DMN completo; variantes/mining visual;
`worker-sdk` público; LGPD avançada (KMS por tenant, portal do titular, retenção+expurgo,
arquivamento frio); Kubernetes/Terraform.

---

## 6. Contratos de API
`/v1`; breaking → `/v2`. Substantivos no plural; ações não-CRUD como sub-recursos. problem+json
com `type` estável. `items`+`nextCursor`. `Idempotency-Key`, `X-Request-Id`. Bearer JWT; tokens
de máquina restritos a jobs. SDK do console por orval em CI; endpoint só entra no console após
estável no OpenAPI.

## 7. Dados
Sem particionamento na v1 (D16r) — gatilho de particionamento: crescimento de `history_events`,
custo de vacuum, p95/p99 de consulta (registrar métricas desde a F2). Busca: colunas nativas
para built-ins + `variable_search_keys` para chaves declaradas. Ordem total por `(instance_id,
seq)` — nunca timestamp. `tenant_id` + RLS em tudo; teste de vazamento permanente. Migrações
forward-only; emergência = restore ensaiado.

## 8. LGPD e segurança

### 8.1 F2 (decidir e costurar)
ADR-0002; middleware + `KeyProvider` (D20); redaction testada; `classification` fluindo
schema→banco; ledger sem conteúdo pessoal (teste).

### 8.2 Registro de tratamento
`docs/privacy/registro-de-tratamento.md`: categorias, finalidade, base legal justificada
(execução de contrato; interesse legítimo com opt-out para telemetria; consentimento onde
aplicável) (G-LGPD-2). Privacy by default; PII fora de URLs (G-LGPD-1).

### 8.3 Direitos do titular (v1)
Export JSON por titular; exclusão = anonimização dos campos `personal`/`sensitive` + tombstone
no ledger. Portal completo e retenção por tenant: F5.

### 8.4 GATE DE PILOTO (evidenciado em `docs/privacy/gate-piloto.md`)
- RLS com `SET LOCAL` testada; API sem BYPASSRLS; papel de migração separado.
- Redaction testada; TLS; secrets em secret manager; audit de dependências verde.
- Backup automatizado + restore ensaiado e documentado.
- Ledger sem dados pessoais (teste); criptografia ativa para `sensitive` com **KeyProvider
  apontando para secret manager/KMS — chave estática REPROVA o gate** (D20).
- Plano de incidentes escrito + simulação executada e documentada (G-LGPD-4).

### 8.5 Pós-piloto (F5)
KMS por tenant, portal do titular, retenção+expurgo auditado, arquivamento frio, automação de
resposta a incidentes.

## 9. Qualidade, observabilidade e processo

### 9.1 Testes
Unidade (engine; serviços com repositórios fake); integração (api+db; crash; fencing job e
task); contrato (OpenAPI×implementação; SDK compila); e2e (fluxo-alvo); replay (corpus, D6);
equivalência simulation×engine (subconjunto v1, 100% automatizada).

### 9.2 Observabilidade
Pino com contexto + redaction; métricas (instâncias ativas, avanços/s, p95/p99 advance,
profundidade outbox, jobs/timers atrasados, incidentes, latência de dispatch); tracing OTel
request→advance→tx→dispatch→complete; alertas iniciais (outbox crescendo, timers >1min
atrasados, taxa de incidentes, p99 advance).

### 9.3 Upgrades da biblioteca
Renovate → CI (conformidade + replay + e2e do fluxo-alvo) → merge manual.

### 9.4 Métricas SMART
"skeleton executa 100 instâncias sem efeito duplicado (fim da F1)"; "p95 advance < 50ms com 1k
instâncias ativas no ambiente de referência (fim da F2)"; "fluxo-alvo em < 5 cliques da lista
à submissão (fim da F3)"; "zero vazamentos de tenant, sempre". Estimativa de referência
F0a→Gate: ~14–22 semanas com um desenvolvedor focado — replanejar se desviar >30%.

## 10. Modo de trabalho do Claude Code
1. Uma fase por vez (F0b ∥ F1 única paralelização; skeleton = sincronização); PRs pequenas.
2. ADRs pela política 3.2, sempre com alternativas para o dono; nunca commitar secrets.
3. Interface: protótipo antes só para tela nova de fluxo principal; heurísticas no PR.
4. Caminho quente: Big-O no PR.
5. Decisão irreversível em dúvida → opções com trade-offs e PERGUNTAR ao dono.
6. Não reimplementar nem rediscutir o Anexo C. Spike da F0b pode PARAR a fase (D18) — parar e
   reportar é o comportamento correto, não um fracasso.

### Template de PR
```
## O que
## Por quê (fase/entregável)
## Tipo de mudança (3.1) e guardrails verificados (ou N/A + justificativa)
## Trade-offs (se decisão relevante)
## Testes
```

### Definition of Done
Código + testes verdes + ADR quando exigido + guardrails da matriz + sem regressão de
cobertura + logs/métricas expostos.

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Extração do engine mais cara que o previsto | Spike D18 antes de comprometer a F0b; parar e reportar |
| Equivalência falhando em fixtures fora do escopo | Corpus filtrado ao subconjunto v1 com skips `todo:F5` |
| Patch do engine corromper instâncias em voo | D6 + replay como gate; `engine_version` + `state_schema_version`; `StateMigrator` |
| Formato de estado fechar a migração futura | ADR-0001 antes de código; D14; alternativas ao dono |
| Bug interno virar incidente silencioso | `AdvanceResult` tipado; exceção interna aborta tx + alerta crítico |
| Vazamento entre tenants | RLS 0001 + teste permanente |
| Efeito duplicado após crash | `effect_key` determinística + crash tests |
| Worker atrasado completando job reassumido | `lock_token` fencing + teste |
| Handler HTTP segurando transação | D22: handler fora da tx; complete via API com token |
| Retrofit de criptografia em produção | Costura na F2 com `KeyProvider`; chave estática reprova o gate |
| NOTIFY perdido/atrás de pooler | Conexão dedicada + polling fallback 60s |
| Particionamento prematuro (ou tardio) | D16r: sem partições na v1; métricas de gatilho desde F2 |
| Drift API × console | SDK orval em CI |
| Cerimônia matando momentum | 3.1 + 3.2 + template enxuto |

## 12. Fora de escopo da v1 (não implementar)
Migração de instâncias (F5); OR-merge/compensação/escalation/correlação/subprocessos avançados
(F5, fixtures com skip); DMN completo (F5); Form Builder drag-and-drop (F4); Playground como
prioridade (F4); mining visual (F5); workers de terceiros + SDK público (F5); CRDT;
Rust/napi-rs; KMS por tenant, portal do titular, retenção configurável, arquivamento (F5);
K8s/Terraform completos (F5); particionamento (gatilho por métricas); Redis/cache compartilhado
(exige ADR); busca por conteúdo de campos `sensitive` (limitação documentada).

---

## Anexo A — ADR-0001 (rascunho v2): `InstanceState`, eventos e efeitos

**Status:** rascunho corrigido — apresentar ao dono com alternativas antes de código (F0b.1).
**Correções v1.2:** catálogo completado; `waitKey` do engine; `variables` em todos os eventos;
ids determinísticos; `AdvanceResult` tipado; invariante de não-retorno de variáveis.

```ts
interface InstanceState {
  stateSchemaVersion: number;    // versão do formato; migrações puras encadeadas (StateMigrator)
  engineVersion: string;
  definitionRef: { registryRef: string; bpmnVersion: string };
  tokens: Token[];               // SEMPRE por elementId (D14)
  waits: Wait[];
  sequence: number;              // monotônico; base do history.seq
  status: 'active'|'completed'|'cancelled'|'incident';
}
interface Token { id: string; elementId: string; scopeId: string; parentTokenId?: string }
// id determinístico derivado pelo ENGINE: filho = `${parentTokenId}/${outgoingFlowId}`;
// raiz = instanceId (fornecido uma única vez em StartInstance). Sem pool de ids.

interface Wait {
  kind: 'userTask'|'job'|'timer';
  elementId: string;
  tokenId: string;
  waitKey: string;               // GERADA PELO ENGINE, determinística: `${elementId}:${tokenId}`
}                                // host mapeia waitKey ↔ effect_key nas linhas de job/task/timer

type Vars = Readonly<Record<string, unknown>>;   // visão imutável fornecida pelo host

type EngineEvent =
  | { type:'StartInstance';     now:string; instanceId:string; variables:Vars; businessKey?:string }
  | { type:'JobCompleted';      now:string; waitKey:string; variables:Vars; result?:Vars }
  | { type:'JobFailed';         now:string; waitKey:string; variables:Vars; error:string }
  | { type:'TimerFired';        now:string; waitKey:string; variables:Vars }
  | { type:'UserTaskCompleted'; now:string; waitKey:string; variables:Vars; submission:Vars }
  | { type:'CancelInstance';    now:string; variables:Vars };
// `variables` em TODOS os eventos: qualquer um pode desembocar em gateway com condição S-FEEL.
// now SEMPRE do host; o kernel nunca consulta relógio nem gera aleatoriedade (D2).

type Effect =
  | { type:'CreateJob';       waitKey:string; elementId:string; jobType:string; payload:Vars }
  | { type:'OpenUserTask';    waitKey:string; elementId:string; formRef:string; candidates:string[] }
  | { type:'CloseUserTask';   waitKey:string }        // boundary interruptivo / cancelamento
  | { type:'CancelJob';       waitKey:string }        // boundary interruptivo / cancelamento
  | { type:'ScheduleTimer';   waitKey:string; elementId:string; fireAt:string }
  | { type:'CancelTimer';     waitKey:string }
  | { type:'EmitHistory';     kind:string; payload:unknown }
  | { type:'RaiseIncident';   kind:string; message:string }
  | { type:'CompleteInstance' };
// effect_key = hash(instanceId, revision, index, type) atribuída pelo HOST (D11).
// Cancelamento/interrupção: o engine emite Close/Cancel para TODAS as esperas afetadas.

type AdvanceResult =
  | { ok:true;  state:InstanceState; effects:Effect[] }
  | { ok:false; rejection:{ kind:'staleWait'|'invalidTransition'|'alreadyClosed'|string;
                             message:string } };
// Rejeição de NEGÓCIO (wait inexistente/fechada, transição inválida) → ok:false tipado; o host
// responde 409/422 e NÃO altera estado. Defeito INTERNO (invariante violada, referência BPMN
// inexistente, estado corrompido) → o engine LANÇA EngineInvariantError; o host aborta a
// transação e dispara alerta crítico. Bug nunca vira incidente de processo silencioso.
```

**Invariantes:** (1) `advance` é pura; distinção rejeição×defeito conforme acima; (2) mesma
(state, event) ⇒ mesmos (state', effects) byte-idênticos sob `canonicalJsonExact`; (3) toda
referência estrutural por `elementId`; ids de token derivados do pai (nunca posicionais/
aleatórios); (4) bump de `stateSchemaVersion` exige `migrateState(vN→vN+1)` pura testada por
replay; (5) `advance` NUNCA retorna variáveis de negócio — entram via `event.variables`, saem
via payload de efeitos (D13); (6) elemento fora do escopo v1 ⇒ rejeição no deploy (lint) e,
defensivamente, `RaiseIncident` tipado no runtime (D19).
**Trade-offs (G-ARQ-2):** estado explícito em JSONB maior que representação compacta —
legibilidade/auditabilidade/migrabilidade valem o espaço; catálogo fechado de efeitos limita
plugins na v1 (extensão via `jobType`/`kind` cobre os casos); manter mapeabilidade
elemento→elemento torna o formato mais verboso HOJE para viabilizar a migração de instâncias
AMANHÃ — custo aceito conscientemente.
**-ilities (G-ARQ-1):** testabilidade e manutenibilidade máximas; performance O(tokens) por
avanço; segurança: estado nunca contém dados de formulário (D13).

## Anexo B — ADR-0002 (rascunho): Tombstones — ledger imutável × direito de exclusão

**Status:** rascunho — decidir na F2; implementação plena na F5.
**Decisão proposta:** (1) ledger NUNCA armazena conteúdo pessoal — só hashes, referências e
metadados de governança (teste automatizado); (2) conteúdo vive em `variables`/
`user_tasks.payload`; exclusão = anonimização + tombstone no ledger
(`{type:'erasure', subjectRef, refs[], reason, requestedAt}`) — a cadeia íntegra passa a provar
QUE a eliminação ocorreu; (3) hashes de conteúdo usam salt por registro armazenado junto ao
conteúdo — apagados conteúdo+salt, o hash residual não é reversível nem verificável por força
bruta; (4) limitação registrada: campos `sensitive` cifrados NÃO são buscáveis por conteúdo —
campo que precisa de busca no Operate não pode ser `sensitive` na v1 (D20).
**Alternativa rejeitada:** crypto-shredding dentro do ledger — acopla gestão de chaves à cadeia
e quebra o `verify()` existente.
**-ilities:** conformidade (LGPD art. 18), auditabilidade preservada, manutenibilidade
("ledger não guarda conteúdo").

## Anexo C — Sugestões avaliadas e REJEITADAS ou ADIADAS COM GATILHO (não reimplementar)

1. **Adiar RLS / filtros manuais.** Rejeitado (retrofit caro; RLS na 0001 custa horas). (D7)
2. **Conviver com duas semânticas de tokens.** Rejeitado (engine é extração; duplicação é a
   classe de bug mais cara — achado B4 do repo). (D10)
3. **Formulários em formato placeholder (RJSF como FORMATO).** Rejeitado — schema é artefato
   persistido/versionado. Nota v1.2: usar biblioteca pronta como EDITOR do nosso schema (F3.3)
   é permitido e recomendado; o que é proibido é formato provisório persistido.
4. **Guardrails só por linters.** Rejeitado parcialmente (SOLID/trade-offs na revisão humana
   quando a matriz 3.1 invocar).
5. **Eliminar o contrato de jobs (handlers acoplados).** Rejeitado — o contrato é necessário
   internamente; adia-se o SDK público. (D4r)
6. **Particionamento de outbox.** Rejeitado permanentemente — fila efêmera; UNIQUE simples;
   linhas despachadas são removidas. (v1.2)
7. **Particionamento de `history_events` na v1.** Adiado com gatilho de métricas (D16r);
   difícil de remover, fácil de adicionar quando justificar. (v1.2)
8. **Generated columns para busca de variáveis.** Preterido em favor de colunas nativas para
   built-ins + `variable_search_keys`; registrado como alternativa se a tabela lateral se
   provar gargalo. (v1.2)
9. **Pool de ids pré-gerados no evento.** Rejeitado — ids derivados deterministicamente do
   token pai; elimina "pool curto" no replay. (v1.2)
10. **Lease/expiração automática de claim em user task.** Rejeitado na v1 — claim persistente
    com revogação auditada (D21); lease é para jobs. (v1.2)
11. **Chave estática de criptografia no piloto.** Rejeitado — reprova o gate 8.4; `KeyProvider`
    com secret manager/KMS obrigatório para dados reais. (D20, v1.2)

---

*Fontes dos guardrails: Arquitetura de Software(s) (Adriano Carezzato); Algoritmos e Padrões de
Projetos (Renan de Oliveira); Projeto e Arquitetura de Sistemas de Uso Intensivo de Dados
(Etienne Cartolano); Sistemas Orientados a Processos (Erica Siqueira); Privacy by Design / LGPD
(Samara Schuch); UX no Desenvolvimento de Software (Paula Azevedo Macedo); Projeto e Arquitetura
de APIs (Rafael Lachi / Weber Ress). Decisões D1–D22 consolidadas após duas rodadas de revisão
externa (2026-07-21).*
