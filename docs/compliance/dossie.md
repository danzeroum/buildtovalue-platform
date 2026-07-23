# Dossiê de Conformidade — BuildToValue v1 (D37)

**Escopo normativo:** ISO/IEC 42001 (sistema de gestão de IA) · EU AI Act Art. 12
(registros/rastreabilidade), Art. 13 (transparência), Art. 14 (supervisão humana
& interrupção) · LGPD (dados pessoais/sensíveis).

**Fonte de estrutura:** *Atlas de Governança* (`docs/handoff/handoff-governanca/
Atlas-de-Governanca.dc.html`), organizado por camada
(banco → runtime → ledger → APIs → logs → trilhas → frontend). Este dossiê é a
projeção **auditável** do Atlas sobre o código realmente entregue: cada linha
aponta o **artefato** (migração/módulo/rota) e a **evidência** (teste nomeado ou
prova em runtime), com **status honesto** em v1.

**Princípio-mãe (vinculante):** *evidência nunca é conteúdo*. O ledger e as
trilhas **nunca** contêm dado pessoal (teste nomeado, §01); `evidência-verificada`
só existe a partir do runtime real (D30). Nada neste dossiê reivindica prova que
o código não produz.

**Legenda de status**
- ✅ **v1** — implementado e coberto por teste nesta base.
- 🔶 **contratado** — contrato/migração já gravados; superfície/rota fica em
  etapa posterior da AG-2 (sem retrabalho de trilha imutável).
- ⬜ **F4/F5** — fora do escopo v1 (Atlas “fora de escopo”).

Migrações de referência: `packages/db/migrations/0001…0006`.

---

## 01 · Banco de dados — imposto por permissão, não por disciplina

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| RLS + FORCE em toda tabela | `0001–0006` (policies `USING tenant_id = current_setting('app.tenant_id')`) | `tests/rls-isolation.test.ts` — isolamento em 17 tabelas; consulta cross-tenant retorna vazio | ISO A.5 · acesso | ✅ v1 |
| Trilhas **append-only** (D32) | `0006` `REVOKE UPDATE, DELETE ON history_events` (+ `tenant_audit_events`) | `rls-isolation.test.ts` — `UPDATE/DELETE` negados (`permission denied`) nas duas trilhas | AI Act 12 · imutabilidade | ✅ v1 |
| Definições imutáveis | `0004` (`process_definitions`/`form_definitions`, versão nova = novo registro) | `tests/registry.test.ts` — v1 intocada por v2; `registry_ref = name@version` | AI Act 12 · versionamento | ✅ v1 |
| Cifra de campos `sensitive` (D20) | `crypto/fieldCipher.ts`; classificação da definição | `tests/lgpd-seam.test.ts` — sensível cifrado em repouso; sem KeyProvider a tx **aborta** (nunca claro) | AI Act 12 · LGPD | ✅ v1 |
| Idempotência + replay | outbox `UNIQUE(effect_key)`; jobs `UNIQUE(wait_key)` | `tests/runtime-dispatch.test.ts`, `skeleton-crash.e2e` — mesma chave → mesmo efeito; replay determinístico | ISO · integridade | ✅ v1 |
| Provisão de agente (D29/D31) | `0006` `tenant_ai_config` (`key_ref LIKE 'secret://%'`), `tenant_tools` | `tests/kill-switch.test.ts` — segredo só `secret://` | AI Act 14 · barreira | ✅ v1 |

---

## 02 · Runtime — supervisão humana e interrupção (Art. 14)

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| Kill-switch auditado (D29 · §5.2) | `agent/tenantAiConfig.ts` `setKillSwitch`; `runtime/jobs.ts` `lockJobs` | `tests/kill-switch.test.ts` — pausa **só** jobs `agent`; serviços seguem; reativação re-locka; acionar/reativar auditados **com motivo** | AI Act 14 · interrupção | ✅ v1 |
| Decisão humana no roteamento (D-decisão) | `runtime/userTasks.ts` `completeUserTask`; `registry/lint.ts` `deriveDecisionRouting` | `tests/decision.test.ts` + `decision.e2e.test.ts` — decisão **nunca ignorada em silêncio**: ausente/inesperada/valor-fora-das-opções → 422; flui p/ `variables` **e** `history_events` (`taskDecision`, autor+valor) | AI Act 14 · supervisão · 12 · registros | ✅ v1 |
| Dead-letter re-enfileirável (D22) | `runtime/outbox.ts` (payload no incidente), `runtime/operate.ts` `retryIncident` | `tests/dead-letter.test.ts` — efeito esgotado vira incidente com payload; `/retry` re-enfileira; crash-test D11 (UNIQUE segura) | ISO · confiabilidade | ✅ v1 |
| Fencing (effect_key / lock / claim) | outbox/jobs/user_tasks | `skeleton-crash.e2e.test.ts` — 100 instâncias, kill nas duas janelas, zero efeito duplicado; claim token rotacionado | ISO · confiabilidade | ✅ v1 |
| Gate humano do agente (world-delta · D28) | contrato `expectedInstanceRevision` (fencing) | — | AI Act 14 · supervisão | 🔶 contratado |
| Trilha de fatos do agente (D27) · evidência-verificada (D30) | `0006` `history_events.agent_io` | — | AI Act 12 · registros/autenticidade | 🔶 contratado |
| Paradas honestas · budget · invariante de tools (D31) | `tenant_tools.requires_gate` | — (execução de agente é etapa posterior) | AI Act 14 · limites | 🔶 contratado |

---

## 03 · Ledger & integridade — a prova que não se reescreve

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| Ledger sem conteúdo pessoal | `runtime/outbox.ts` (EmitHistory), payloads de trilha | `tests/lgpd-seam.test.ts` — **aceite nomeado** “ledger sem conteúdo pessoal”; dead-letter guarda só metadados de efeito | AI Act 12 · LGPD | ✅ v1 |
| Ancoragem de digest das trilhas (D35) | `tenant_audit_events.anchor_ref` (coluna já existe) | — | AI Act 12 · integridade | 🔶 contratado |
| Export com recibo / Evidence Bundle | — | — | AI Act 12 · rastreável | 🔶 contratado (E4) |

---

## 04 · APIs — toda ação sensível exige e audita motivo

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| Motivo obrigatório e auditado | rotas: reveal (`runtime.ts:302`), cancelamento (`runtime.ts:372`), resolução (`operate.ts:169`), reatribuição (`userTasks.ts` assignment), kill-switch | history: `sensitiveRevealed`, `taskReassigned`, `incidentResolved`; tenant: `agent.killswitch.toggled` — todos `min(1)` no `reason`/`motivo` | AI Act 12 · 14 | ✅ v1 |
| Cross-tenant = 404 sempre | convenção §0; RLS | `variables.e2e.test.ts`, `api.test.ts` — nunca revela recurso de outro tenant | ISO · isolamento | ✅ v1 |
| XES / IEEE 1849 por instância | `instances` export | `instances.e2e.test.ts` — log de eventos exportável | AI Act 12 · interoperável | ✅ v1 |
| `GET /v1/audit/export` (D36) + `audit:export` | proposta AG-2 v2 §4 (rota não criada em v1) | — | AI Act 12 · acesso a registros | 🔶 contratado |
| `POST` verificar integridade (D35) | proposta AG-2 v2 §4 | — | AI Act 12 · integridade | 🔶 contratado |

---

## 05 · Logs & observabilidade — sensível nunca vaza

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| Bindings `tenant_id` + `user_id` (D34) | envelope de ator `actor{type,id,requestId}` (`0006` `tenant_audit_events`) | `tests/tenant-audit.test.ts` — envelope consultável por coluna | AI Act 12 · rastreável | ✅ v1 |
| Negação de autorização auditada (D34) | `requirePermission` (403) | — (log estruturado + métrica: refino em etapa posterior) | AI Act 12 · segurança | 🔶 contratado |
| Redaction leak-fail (build falha se sensível em log) | — | teste dedicado de CI a criar | AI Act 12 · LGPD | 🔶 contratado |

---

## 06 · Trilhas de auditoria — ator sempre nomeado

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| `history_events` por instância | `runtime/audit.ts` `insertAuditEvent` (seq na faixa reservada `rev*100000+90000..99999`) | `operate.e2e`, `decision.test.ts` — “cancelada por X · motivo Y”; seq determinístico | AI Act 12 · registros | ✅ v1 |
| `tenant_audit_events` (D33) — governança sem instância | `0006`; `audit/tenantAudit.ts` `recordTenantAuditEvent` | `tests/tenant-audit.test.ts` — auth/config/tools/kill-switch append-only | AI Act 12 · governança | ✅ v1 |
| Envelope de ator (D33) `{type,id,requestId}` | colunas `actor_type/actor_id/request_id` (1ª classe, consultáveis) | `tenant-audit.test.ts` · `kill-switch.test.ts` | AI Act 12 · 13 | ✅ v1 |

**Catálogo de `event_type` estável (insumo de contrato AG-2, publicado aqui):**
- Trilha de instância (`history_events.kind`): `sensitiveRevealed`, `variablesUpdated`,
  `taskReassigned`, `taskDecision`, `incidentRetried`, `incidentResolved`,
  `instanceCompleted` (+ eventos do engine via EmitHistory).
- Trilha de tenant (`tenant_audit_events.event_type`): `config.ai.updated`,
  `agent.killswitch.toggled`.

O catálogo cresce por **adição** (nunca renomeia): `event_type`/`resource_type`/
`resource_id` são estáveis e consultáveis desde a 0006, evitando migração
retroativa de trilha imutável na F4.

---

## 07 · Frontend — a prova visível, no momento da ação (Art. 13)

| Mecanismo | Artefato | Evidência | Controle | Status |
|---|---|---|---|---|
| Classificação com consequências | `/forms` (console) — `dataClassification` obrigatória | lint de schema (`validateFormSchema`) | AI Act 13 · transparência | ✅ v1 |
| Decisão com escolha exata + igualdade explícita | `routes/tasks.tsx` (radios de `decisionOptions`); OpenAPI da conclusão | `tasks.test.tsx` — escolha exata, sem texto livre | AI Act 13 · 14 | ✅ v1 |
| Lint de rejeição explicada | `/studio` — lint D19 com issues | `studio.test.tsx`; `registry.test.ts` | AI Act 13 · 12 | ✅ v1 |
| Revelação mascarada por padrão (D20) | `/operate` — reveal com motivo | `operate.test.tsx` — mascarado→revela com motivo auditado | AI Act 13 · LGPD | ✅ v1 |
| Selo de procedência (ator + estado de evidência) | `shared-ui` (retrofit) | — | AI Act 13 · legibilidade | ⬜ F4 |

---

## Gate de Piloto (13 itens · adendos 02+03)

Itens de **infra** a provisionar cedo (fora do código): secret manager para
`key_ref = secret://…`; WAL imutável no Postgres do piloto (reforço físico da
append-only já imposta por permissão na 0006). Itens de **produto** cobertos em
v1: RLS+FORCE, trilha append-only, envelope de ator, kill-switch auditado,
motivo obrigatório, ledger sem conteúdo pessoal, cifra de sensíveis. Itens
**contratados** pendentes de superfície: export auditado (D36), verificação de
integridade (D35), execução/trilha de agente (D27/D30).

---

## Coexistências transitórias sob gate (rastreabilidade)

- **Avaliador de forms** (§2.7 de `pendencias.md`) — 3 implementações sob corpus
  compartilhado até o colapso pós-`forms@1.1`; ponto de colapso nomeado.
- Precedente metodológico: Anexo C item 2 (`simulation × engine`).

---

*Atualização deste dossiê é obrigatória a cada fechamento de fase (circuito do
designer). Última: fechamento da AG-2.1.*
