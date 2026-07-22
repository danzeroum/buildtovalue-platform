# Proposta — Shape completo da API `/v1` do MVP (F3)

> **Status: APROVADA COM ADENDOS (dono + arquiteto, 22/07)** — este
> documento JÁ INCORPORA os adendos da pré-triagem; com o merge desta
> versão, a implementação F3.1 está liberada conforme o shape abaixo.
> Base: PLANO v1.2 §F3.1 + ADENDO-01 (§2.2, §2.3, §3, §6) + triagens
> phase-1/phase-2. SDK (openapi-typescript) regenerado a partir DAQUI.

## 0. Convenções transversais (valem para toda rota nova)

| Convenção | Regra |
|---|---|
| Erros | `application/problem+json` SEMPRE: `{type, title, status, detail?, requestId, errors?}`. Tipos: `/problems/validation` (400/422), `/problems/unauthorized` (401), `/problems/forbidden` (403), `/problems/not-found` (404), `/problems/conflict` (409 — fencing/claim/estado), `/problems/rate-limit` (429). |
| Paginação | Cursor OPACO (base64 de `(created_at,id)` ou `seq`): `?cursor=&limit=` (1–100, default 20) → `{items, nextCursor\|null}`. Nunca offset. |
| Idempotência | Header `Idempotency-Key` aceito em TODO POST de criação/ação (obrigatório no SDK para `instances`): chave por tenant, retenção 24h, replay devolve a resposta original + `Idempotency-Replayed: true`. |
| Ações | Sub-recurso SUBSTANTIVO, nunca verbo (regra da seção 6, consolidada na triagem phase-2): `/cancellation`, `/completion`, `/failure`, `/assignment`, `/resolution`. |
| Auditoria | Toda ação de operador (reveal, reatribuição, retry, resolve, cancel) gera evento de história/auditoria com ator + motivo. |
| RBAC | Rota declara PERMISSÃO (nunca papel) — matriz §8. Tenant SEMPRE do JWT (nunca de parâmetro). |
| Versionamento | `/v1` aditivo (campos novos opcionais = minor); quebra = `/v2`. Deprecações anunciadas no OpenAPI (`deprecated: true`) por ≥1 fase antes de remover. |
| Ações nominais | **(adendo 22/07)** A leitura NOMINAL de `/claim`, `/retry`, `/reveal` e `/lint` é declarada CONFORME a regra de sub-recurso: o POST **cria o recurso-ação** (um claim, uma retry, uma revelação auditada, um lint) e o DELETE o remove — a regra está fechada; nenhum rename adicional. |
| Cross-tenant | **(adendo 22/07)** Recurso de outro tenant = **404 SEMPRE** (existência não vaza — RLS já garante isso no dado; o contrato promete no status). O 403 com mensagem de papel (ADENDO §2.2) é EXCLUSIVAMENTE intra-tenant. |

## 1. `process-definitions` (deploy do registry COM validação D19)

| Rota | Descrição | Permissão |
|---|---|---|
| `POST /v1/process-definitions` | Deploy imutável: `{name, diagram, formRefs?}` → roda o LINT D19; qualquer erro = **422 com o catálogo de issues** (§2) e NADA é gravado. 201: `{id, registryRef, version, engineVersion, bpmnVersion, createdAt}`. | `definitions:deploy` |
| `POST /v1/process-definitions/lint` | Lint SEM deploy (Studio mostra rejeições antes de publicar — mesmo motor do deploy, mesma resposta). 200: `{issues[]}` (vazio = publicável). | `definitions:deploy` |
| `GET /v1/process-definitions` | Lista (cursor; filtros `name`, `active`). | `definitions:read` |
| `GET /v1/process-definitions/{id}` | Detalhe + diagrama. | `definitions:read` |

Versões são IMUTÁVEIS (D6/D10): re-deploy do mesmo nome cria versão nova;
instâncias em voo continuam na versão em que nasceram (migração = F5).

## 2. Catálogo de lint D19 (issue platform#2 implementada aqui)

`issue = {code, elementId?, edgeId?, message, severity: 'error'|'warning'}` —
`error` bloqueia deploy; `warning` publica com aviso no Studio. Severidade
por código FIXADA na pré-triagem (adendo 4):

| Código | Severidade | Condição |
|---|---|---|
| `EXEC_UNSUPPORTED_ELEMENT` | error | Elemento fora do subconjunto v1 (fail-fast D19). |
| `EXEC_BOUNDARY_HOST_NOT_WAITING` | error | **(issue #2)** Boundary anexado a atividade que NÃO espera (ex.: task automática instantânea/script): timer jamais teria janela para disparar. Casos de teste da issue incluídos. |
| `EXEC_TIMER_EXPRESSION_INVALID` | error | `timer` ausente/mal-formado; anos/meses/ciclos (não suportados v1). |
| `EXEC_XOR_NO_DEFAULT` | **warning** | XOR com condição em TODAS as saídas. **Adendo do arquiteto:** XOR todo-condicional é VÁLIDO; rota morta em execução é incidente de RUNTIME, não veto de deploy. |
| `EXEC_XOR_MULTIPLE_DEFAULTS` | error | Mais de uma saída sem condição no mesmo XOR (default ambíguo — roteamento não-determinístico). |
| `EXEC_CONDITION_UNSUPPORTED` | error | Expressão fora do S-FEEL suportado (avaliador injetado valida na publicação, não só em runtime). |
| `EXEC_FORM_REF_MISSING` | error | User task sem `formRef` resolvível no registry de forms (§2b). |
| `EXEC_JOB_TYPE_MISSING` | error | Service task sem `jobType`. |
| `EXEC_GRAPH_UNREACHABLE` | warning | Nó inalcançável a partir do start / sem caminho a um end (diagrama em rascunho publicável; vira aviso no Studio). |

## 2b. `form-definitions` (adendo 1 — o que a Tasklist renderiza)

O formato dos forms (F0b.5: chave `value` RESERVADA; `dataClassification`
OBRIGATÓRIO por campo) vira GATE de deploy — o `validateSchema` de
`@buildtovalue/forms` é o lint.

| Rota | Descrição | Permissão |
|---|---|---|
| `POST /v1/form-definitions` | Deploy imutável de `{formId, schema}` → roda `validateSchema` (SchemaIssue codes, incl. `FIELD_KEY_RESERVED` e classificação ausente); erro = 422 com issues, nada gravado. 201: `{formId, version, ref}` (`ref = formId@versão`). | `definitions:deploy` |
| `POST /v1/form-definitions/lint` | Lint sem deploy (editor /forms mostra issues antes de publicar). | `definitions:deploy` |
| `GET /v1/form-definitions` | Lista (cursor; filtro `formId`). | `definitions:read` |
| `GET /v1/form-definitions/{ref}` | Por REF EXATO (`formId@versão`) — é o que a Tasklist usa para renderizar o formulário PINADO da task (mesma versão do deploy do processo, sempre). | `tasks:read` |

O `EXEC_FORM_REF_MISSING` do lint de processo resolve contra ESTE registry.

## 3. `instances`

| Rota | Descrição | Permissão |
|---|---|---|
| `POST /v1/instances` | `{definitionId\|registryRef, businessKey?, variables?}` → 201. `Idempotency-Key` honrado. | `instances:start` |
| `GET /v1/instances` | Lista (cursor; filtros `status`, `definitionId`, `businessKey`). | `instances:read` |
| `GET /v1/instances/{id}` | Detalhe + `currentElements[]` (posição dos tokens — drill-down do Operate). | `instances:read` |
| `POST /v1/instances/{id}/cancellation` | **Como entregue na PR #8** — `{reason}` obrigatório → história. | `instances:cancel` |
| `GET /v1/instances/{id}/history` | Eventos ordenados por `seq` (cursor). Exibe "cancelada por {usuário} · {motivo}" (ADENDO §2.3) — o ator entra no evento a partir desta fase. | `instances:read` |
| `GET /v1/instances/{id}/export?format=xes` | Export XES do histórico (Operate F3.5, `toXES` da biblioteca). | `operate:read` |

## 4. `variables` (ADENDO §3 — máscara + revelação auditada)

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/instances/{id}/variables` | Lista `{name, classification, value}` — **`sensitive` SEMPRE mascarada** (`{masked: true}`, valor NUNCA no payload); `personal` visível com marcação. | `instances:read` |
| `POST /v1/instances/{id}/variables/{name}/reveal` | Revela UMA variável sensitive: body `{reason}` **OBRIGATÓRIO** (decisão 10.c — mesmo padrão do cancelamento, LGPD art. 37); 200 `{name, value}` + **evento de auditoria obrigatório** (quem, quando, qual variável, motivo). POST (não GET) porque cria o recurso-ação auditado. Payload de user task sensitive segue a MESMA regra. | `variables:reveal-sensitive` |
| `PATCH /v1/instances/{id}/variables` | Edição pelo operador: `{set: {name: value}}` — cifra `sensitive` na escrita (D20), auditada. | `operate:act` |

Limitação D20 reafirmada no OpenAPI: `sensitive` não é buscável por conteúdo.

## 5. `jobs` (D22/D12 — com correção de nomenclatura)

| Rota | Descrição | Permissão |
|---|---|---|
| `POST /v1/jobs/locks` | Lock em lote: `{types?, limit?, leaseMs?, workerId}` → `{jobs: [{…, lockToken}]}` (FOR UPDATE SKIP LOCKED + lease). | `operate:act` |
| `POST /v1/jobs/{id}/completion` | `{lockToken, result?}` — 409 fencing. | `operate:act` |
| `POST /v1/jobs/{id}/failure` | `{lockToken, error, retryInSeconds?}` — retries esgotados → incidente. | `operate:act` |
| `GET /v1/jobs` | Lista (cursor; `status`, `type`, **`instanceId`** — aba do drill-down, adendo 3) — pendentes/atrasados no Operate. | `operate:read` |

**Migração proposta**: `/complete` e `/fail` (contrato F1.8/F2, já em uso
pelo worker) permanecem como **aliases deprecados** no OpenAPI até o fim da
F4; o worker migra para os nomes novos na F3.1. Motivo: consistência com a
regra de sub-recurso substantivo ANTES de o SDK congelar — evita uma
terceira cobrança de rename com clientes reais no ar.

## 6. `user-tasks` (D21 claim persistente + D24 reatribuição + ADENDO §2.2)

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/user-tasks` | Lista (cursor; filtros `filter=mine\|role\|unassigned`, `status`, **`instanceId`** — destino pós-início do ADENDO §2.1 e aba do drill-down, adendo 3). Tarefa de papel alheio NÃO aparece (filtrada, não 403 — ADENDO §2.2, decisão 10.d). | `tasks:read` |
| `GET /v1/user-tasks/{id}` | Detalhe + `formRef` PINADO (`formId@versão`) + payload (campos sensitive mascarados como em §4). Task de papel alheio = 403 `/problems/forbidden` com mensagem de papel. | `tasks:read` |
| `POST /v1/user-tasks/{id}/claim` | Claim PERSISTENTE (D21): 200 `{claimToken}`. Já reivindicada por OUTRO → **409 com `holder` para exibição** ("com Maria desde 14:02" — ADENDO §2.2). Re-claim pelo MESMO usuário → 200 com token NOVO (o anterior morre — um token ativo por task). | `tasks:work` |
| `DELETE /v1/user-tasks/{id}/claim` | Unclaim do PRÓPRIO claim (204). De outrem = 403 (operador usa `/assignment`). | `tasks:work` |
| `POST /v1/user-tasks/{id}/completion` | `{claimToken, submission}` — validação NO SERVIDOR com o MESMO schema do renderer (422 por campo); token errado/morto = **409 (fencing formal — critério de aceite F3)**; submissão flui a variáveis com classificação (D13/D20). | `tasks:work` |
| `POST /v1/user-tasks/{id}/assignment` | Reatribuição por OPERADOR (D24): `{assignee, reason}` — invalida claimToken vigente, auditada ("revogação auditada"), história registra ator+motivo. | `operate:act` |

## 6b. `timers` (adendo 2 — Operate exibe timers pendentes)

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/timers` | Lista (cursor; filtros `status`, `instanceId`): `{id, instanceId, elementId, fireAt, status}` — pendentes/atrasados no Operate e aba do drill-down. Somente leitura na v1 (adiar/disparar timer manualmente = pós-piloto). | `operate:read` |

## 7. `incidents`

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/incidents` | Lista (cursor; `status`, `kind`, `instanceId`). | `operate:read` |
| `POST /v1/incidents/{id}/retry` | Re-tenta a causa: job failed volta a `available` (retries restaurados). Auditado. 200 `{rearmedJobs}`. **Ver ERRATA abaixo sobre dead-letter.** | `operate:act` |
| `POST /v1/incidents/{id}/resolution` | `{reason}` obrigatório — resolve manualmente sem re-tentar. Auditado. | `operate:act` |

> **ERRATA (leva 5 F3, aceita pelo dono em 22/07) — retry de dead-letter na v1.**
> O shape acima previa que `/retry` também **re-enfileirasse o efeito em
> dead-letter** (`incidents.kind = 'effectDispatchFailed'`). Isso **NÃO é
> viável na v1**: a outbox é uma fila EFÊMERA (linha despachada é DELETADA) e
> o payload do efeito não é persistido no incidente — não há o que
> re-enfileirar. Comportamento v1: `/retry` re-arma jobs `failed`; para um
> incidente de dead-letter sem job re-tentável, responde **`409` +
> `problem+json`** apontando `/resolution` (mensagem explícita, sem falso
> sucesso). O re-enfileiramento fiel exige **coluna `payload` em `incidents`
> (migração nova = GATE)** e entra na **migração da AG-2** (registrado em
> `pendencias.md` §2.4). O 409 e a limitação estão documentados no OpenAPI da
> rota (`apps/api/src/routes/operate.ts`).

## 8. Matriz RBAC (rota → permissão; papéis existentes de `@platform/auth`)

Permissões já reservadas na F1 (`rbac.ts`) cobrem TUDO acima — nenhuma
permissão nova: `definitions:read/deploy`, `instances:read/start/cancel`,
`tasks:read/work`, `operate:read/act`, `variables:reveal-sensitive`.
Papéis: `admin` (tudo), `analyst` (modela/deploya/inicia), `business`
(inicia/trabalha tasks), `operator` (opera/cancela/revela). Ajustes de
grants, se o seu arquiteto quiser, são troca no MAPA — zero mudança de rota.

## 9. Aceites da F3 que esta proposta materializa (nomeados na triagem)

1. **Fencing formal de user task** — teste estilo crash test sobre
   `/claim` + `/completion`: claim persistente sobrevive a restart, token
   errado/morto = 409, reatribuição invalida token, zero conclusão dupla.
2. **Ledger real + salt-por-registro** — dono: fluxo de deploy/promoção do
   registry (`POST /process-definitions` ancora no ledger
   `@buildtovalue/audit` com hash salteado por registro); o teste nomeado
   "ledger nunca contém conteúdo pessoal" passa a varrer TAMBÉM a cadeia.
3. **Lint D19 com `EXEC_BOUNDARY_HOST_NOT_WAITING`** — issue #2 fechada
   pela rota `/lint` + gate de deploy, com os casos de teste da issue.

## 10. Decisões — RESPONDIDAS na pré-triagem (dono + arquiteto, 22/07)

| # | Questão | **Decisão** |
|---|---|---|
| a | Rename `/complete`/`/fail` de jobs | **SIM** — `/completion`/`/failure` com aliases deprecados até F4; worker migra na F3.1. |
| b | Re-claim pelo mesmo usuário | **ROTACIONAR** o claimToken (um token ativo por task; token perdido se resolve com re-claim). |
| c | Reveal de sensitive | **`{reason}` OBRIGATÓRIO** no body (incorporado na §4). |
| d | Task de papel alheio na lista | **FILTRAR** na lista; 403 com mensagem de papel SÓ no acesso direto por id (e SÓ intra-tenant — cross-tenant é 404, §0). |
