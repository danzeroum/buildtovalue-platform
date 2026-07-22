# Proposta — Shape completo da API `/v1` do MVP (F3)

> **Status: PROPOSTA — aguardando aprovação do dono (política 3.2).**
> Nenhum endpoint novo será implementado antes do aceite. Base: PLANO v1.2
> §F3.1 + ADENDO-01 (§2.2, §2.3, §3, §6) + triagens phase-1/phase-2.
> SDK (openapi-typescript) só é regenerado DEPOIS da aprovação.

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
`error` bloqueia deploy; `warning` publica com aviso no Studio.

| Código | Condição |
|---|---|
| `EXEC_UNSUPPORTED_ELEMENT` | Elemento fora do subconjunto v1 (fail-fast D19). |
| `EXEC_BOUNDARY_HOST_NOT_WAITING` | **(issue #2)** Boundary anexado a atividade que NÃO espera (ex.: task automática instantânea/script): timer jamais teria janela para disparar. Casos de teste da issue incluídos. |
| `EXEC_TIMER_EXPRESSION_INVALID` | `timer` ausente/mal-formado; anos/meses/ciclos (não suportados v1). |
| `EXEC_XOR_NO_DEFAULT` | XOR com condição em TODAS as saídas (sem default implícito) — rota morta possível. |
| `EXEC_XOR_MULTIPLE_DEFAULTS` | Mais de uma saída sem condição no mesmo XOR (default ambíguo). |
| `EXEC_CONDITION_UNSUPPORTED` | Expressão fora do S-FEEL suportado (avaliador injetado valida na publicação, não só em runtime). |
| `EXEC_FORM_REF_MISSING` | User task sem `formRef` resolvível no registry. |
| `EXEC_JOB_TYPE_MISSING` | Service task sem `jobType`. |
| `EXEC_GRAPH_UNREACHABLE` | Nó inalcançável a partir do start / sem caminho a um end. |

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
| `POST /v1/instances/{id}/variables/{name}/reveal` | Revela UMA variável sensitive: 200 `{name, value}` + **evento de auditoria obrigatório** (quem, quando, qual variável). POST (não GET) porque tem efeito colateral de auditoria. Payload de user task sensitive segue a MESMA regra. | `variables:reveal-sensitive` |
| `PATCH /v1/instances/{id}/variables` | Edição pelo operador: `{set: {name: value}}` — cifra `sensitive` na escrita (D20), auditada. | `operate:act` |

Limitação D20 reafirmada no OpenAPI: `sensitive` não é buscável por conteúdo.

## 5. `jobs` (D22/D12 — com correção de nomenclatura)

| Rota | Descrição | Permissão |
|---|---|---|
| `POST /v1/jobs/locks` | Lock em lote: `{types?, limit?, leaseMs?, workerId}` → `{jobs: [{…, lockToken}]}` (FOR UPDATE SKIP LOCKED + lease). | `operate:act` |
| `POST /v1/jobs/{id}/completion` | `{lockToken, result?}` — 409 fencing. | `operate:act` |
| `POST /v1/jobs/{id}/failure` | `{lockToken, error, retryInSeconds?}` — retries esgotados → incidente. | `operate:act` |
| `GET /v1/jobs` | Lista (cursor; `status`, `type`) — pendentes/atrasados no Operate. | `operate:read` |

**Migração proposta**: `/complete` e `/fail` (contrato F1.8/F2, já em uso
pelo worker) permanecem como **aliases deprecados** no OpenAPI até o fim da
F4; o worker migra para os nomes novos na F3.1. Motivo: consistência com a
regra de sub-recurso substantivo ANTES de o SDK congelar — evita uma
terceira cobrança de rename com clientes reais no ar.

## 6. `user-tasks` (D21 claim persistente + D24 reatribuição + ADENDO §2.2)

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/user-tasks` | Lista (cursor; filtros `filter=mine\|role\|unassigned`, `status`). Tarefa de papel alheio NÃO aparece (filtrada, não 403 — ADENDO §2.2). | `tasks:read` |
| `GET /v1/user-tasks/{id}` | Detalhe + `formRef` PINADO (`formId@versão`) + payload (campos sensitive mascarados como em §4). Task de papel alheio = 403 `/problems/forbidden` com mensagem de papel. | `tasks:read` |
| `POST /v1/user-tasks/{id}/claim` | Claim PERSISTENTE (D21): 200 `{claimToken}`. Já reivindicada por OUTRO → **409 com `holder` para exibição** ("com Maria desde 14:02" — ADENDO §2.2). Re-claim pelo MESMO usuário → 200 com token NOVO (o anterior morre — um token ativo por task). | `tasks:work` |
| `DELETE /v1/user-tasks/{id}/claim` | Unclaim do PRÓPRIO claim (204). De outrem = 403 (operador usa `/assignment`). | `tasks:work` |
| `POST /v1/user-tasks/{id}/completion` | `{claimToken, submission}` — validação NO SERVIDOR com o MESMO schema do renderer (422 por campo); token errado/morto = **409 (fencing formal — critério de aceite F3)**; submissão flui a variáveis com classificação (D13/D20). | `tasks:work` |
| `POST /v1/user-tasks/{id}/assignment` | Reatribuição por OPERADOR (D24): `{assignee, reason}` — invalida claimToken vigente, auditada ("revogação auditada"), história registra ator+motivo. | `operate:act` |

## 7. `incidents`

| Rota | Descrição | Permissão |
|---|---|---|
| `GET /v1/incidents` | Lista (cursor; `status`, `kind`, `instanceId`). | `operate:read` |
| `POST /v1/incidents/{id}/retry` | Re-tenta a causa: job failed volta a `available` (retries restaurados) / efeito dead-letter re-enfileirado. Auditado. 200 `{status}`. | `operate:act` |
| `POST /v1/incidents/{id}/resolution` | `{reason}` obrigatório — resolve manualmente sem re-tentar. Auditado. | `operate:act` |

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

## 10. Decisões em aberto para a sua triagem (recomendação marcada)

| # | Questão | Recomendação |
|---|---|---|
| a | Renomear `/complete`/`/fail` de jobs para `/completion`/`/failure` com aliases deprecados até F4? | **Sim** (consistência antes de o SDK congelar; custo baixo agora, alto depois). |
| b | Claim: re-claim pelo mesmo usuário rotaciona o token (proposto) ou devolve o mesmo? | **Rotacionar** (um token ativo; perda de token se resolve com re-claim, sem suporte). |
| c | Reveal de sensitive: também exigir `reason` no body (auditoria mais rica) ou só o evento automático? | **Exigir `{reason}`** — mesmo padrão do cancelamento; consistente com LGPD art. 37. |
| d | `GET /v1/user-tasks` de papel alheio: filtrar silenciosamente (proposto, ADENDO §2.2) ou 403 por item? | **Filtrar** na lista; 403 explícito só no acesso direto por id. |
