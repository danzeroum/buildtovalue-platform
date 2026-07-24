# Proposta de SHAPE — AG-2.3 (export de auditoria + verificação de integridade)

**Gate:** shape antes de implementar (política 3.2). Triagem do dono contra: §2.14.2
(normalização do envelope das duas trilhas), recibo com digest ancorado, rota de
verificação auditada, catálogo de `event_type` publicado. Nada implementado antes do "ok".

Princípio-mãe honrado em todo o shape: **evidência nunca é conteúdo**. O export carrega
**metadados de procedência** (ator, tipo de evento, recurso, motivo, momento, âncora), NUNCA
o `payload` cru — o ledger e as trilhas já não têm conteúdo pessoal (aceite nomeado, §01 do
dossiê), e o export não reabre essa porta.

---

## 1. O problema central (§2.14.2): o envelope de ator vive em DUAS formas físicas

| Trilha | Ator | Evento | Recurso | Momento | Ordem |
|---|---|---|---|---|---|
| `tenant_audit_events` (governança, sem instância) | **colunas** `actor_type`/`actor_id`/`request_id` | `event_type` | `resource_type` + `resource_id` | `created_at` | `id` |
| `history_events` (por instância) | **jsonb** `payload->'actor'->>{type,id,requestId}` (nem todo evento tem — evento puro do engine não tem ator) | `kind` | (implícito) `instance` + `instance_id` | `occurred_at` | `seq` |

O auditor **não pode** receber dois formatos para o mesmo conceito. A rota NORMALIZA as duas
numa forma única na saída. A normalização é UMA função (`normalizeActor`) com duas entradas
físicas → uma saída lógica; testada nos dois caminhos.

---

## 2. Shape do REGISTRO normalizado (a unidade do export)

Cada evento das duas trilhas vira UM registro com esta forma única:

```json
{
  "source": "instance" | "tenant",
  "at": "2026-07-24T10:00:00.000Z",
  "actor": { "type": "user" | "system" | "agent", "id": "…", "requestId": "…" | null } | null,
  "eventType": "taskDecision" | "config.ai.updated" | "agent:acao" | "…",
  "resourceType": "instance" | "ai_config" | "jobs" | "…",
  "resourceId": "…" | null,
  "motivo": "…" | null,
  "seq": 700000 | null,
  "anchorRef": "…" | null
}
```

Regras de normalização (a triar):
- **`actor`** — `tenant`: dos campos-coluna; `instance`: de `payload->'actor'`. Evento de
  instância SEM ator (engine puro: `instanceCompleted`, timers) → proponho **`actor: null`**
  (honesto: "sem ator nomeado" ≠ inventar `system`). *[Decisão A: `null` vs `{type:'system',
  id:'engine'}` — recomendo `null`, mais honesto.]*
- **`eventType`** — `tenant`: `event_type` verbatim; `instance`: `kind` verbatim (inclui o
  namespace `agent:*` já publicado). Mesmo campo lógico, catálogo unificado (§5).
- **`resourceType`/`resourceId`** — `tenant`: colunas; `instance`: `'instance'` + `instance_id`.
- **`motivo`** — `tenant`: coluna `motivo`; `instance`: `payload->>'motivo'` quando existir
  (ex.: cancelamento, reatribuição, reproposta), senão `null`.
- **`seq`** — só `instance` (ordem determinística intra-instância); `tenant` → `null`.
- **`anchorRef`** — a referência de ancoragem recuperável por evento/intervalo (a coluna
  `tenant_audit_events.anchor_ref` já existe; `history_events` ancora por intervalo — §4).
- **`payload` cru NÃO entra.** Se algum campo de metadado seguro for necessário além destes,
  entra por **whitelist explícita**, nunca o objeto inteiro.

**Ordem total** (a triar): por `at` ascendente; empate → `source` (`instance` antes de
`tenant`), depois `seq`/`id`. Determinística para o digest ser estável.

---

## 3. Rota do export — `GET /v1/audit/export`

- **Permissão:** `audit:export` (papel a conceder no RBAC — **não existe hoje**; adiciono no
  pacote). A própria chamada é **auditada** (evento `audit.export` em `tenant_audit_events`,
  com os filtros + digest + contagem — o auditor é auditado).
- **Filtros** (querystring): `from`/`to` (período, obrigatório o `from`?), `actorType`,
  `actorId`, `eventType`, `resourceType`, `resourceId`, `source` (`instance|tenant|both`,
  default `both`). Os índices da 0006 já cobrem período/ator/tipo/recurso na trilha de tenant;
  para `history_events`, filtro por período/instance + varredura ordenada por `seq`.
- **Formato:** `format=json|csv` (default `json`).
  - **JSON** = a forma canônica (o digest é computado sobre ela — canonicalização estável:
    chaves ordenadas, sem espaços, timestamps ISO em UTC).
  - **CSV** = a MESMA sequência achatada (o `actor` vira `actor_type,actor_id,actor_request_id`);
    o digest referenciado é o **do JSON canônico** — o formato de visualização não muda a prova.
- **Resposta:** os registros (§2) + um **recibo** (§4) no envelope (header `X-Audit-Receipt`
  ou um objeto `receipt` no JSON; a triar). Paginação por cursor se o intervalo for grande.

---

## 4. Recibo com digest ancorado

O recibo é a prova de que "este conjunto, com estes filtros, neste intervalo, tem este digest":

```json
{
  "digest": "sha256:…",           // sobre a sequência canônica de registros (§2)
  "algorithm": "sha256",
  "count": 128,
  "filters": { "from": "…", "to": "…", "eventType": "…" },
  "anchorRef": "…",               // âncora recuperável do intervalo (D35)
  "generatedAt": "…",
  "generatedBy": { "type": "user", "id": "auditor@acme", "requestId": "…" }
}
```

- **`digest`** — hash da sequência canônica (não do CSV). Recompoível por quem tiver os mesmos
  filtros + os mesmos dados. **Determinístico** pela ordem total (§2).
- **`anchorRef`** — a referência de ancoragem (D35). *[Decisão B: a v1 ancora contra quê?
  Proponho o MÍNIMO honesto: `anchor_ref` = o próprio digest + o intervalo, gravado no evento
  `audit.export` (auto-referência verificável). Ancoragem externa (WAL imutável / notarização)
  é item de infra do Gate de Piloto — o shape já reserva o campo, o backend enche com o que a
  infra do piloto fornecer. Nada de reivindicar "ancorado-verificável" (D30) sem runtime real.]*

---

## 5. Rota de verificação — `POST /v1/audit/verify`

- **Permissão:** `audit:export` (mesma); **auditada** (evento `audit.verify`).
- **Body:** o recibo (ou `{digest, filters, anchorRef}`).
- **Ação:** re-executa a MESMA consulta normalizada, recomputa o digest, compara. Retorna:
  ```json
  { "matches": true|false, "expectedDigest": "…", "actualDigest": "…", "count": 128, "anchorRef": "…" }
  ```
- `matches:false` é resultado honesto (a trilha mudou? o intervalo diverge?), não erro —
  200 com `matches:false`; a própria verificação fica na trilha (quem verificou, quando, o quê).

---

## 6. Catálogo de `event_type` publicado no contrato

A publicar no OpenAPI (e espelhado no dossiê §06, que já lista o núcleo). União das duas trilhas:

- **Instância** (`history_events.kind`): `sensitiveRevealed`, `variablesUpdated`,
  `taskReassigned`, `taskDecision`, `incidentRetried`, `incidentResolved`, `instanceCompleted`,
  `agent:pinResolved|intencao|acao|io|decisao|evidencia|parada|retomado|reproposta`,
  + eventos do engine via `EmitHistory`.
- **Tenant** (`tenant_audit_events.event_type`): `config.ai.updated`, `agent.killswitch.toggled`,
  `agent.jobs.resumed`, `agent.jobs.paused` (se aplicável).
- **Incidentes** (kind): `agentToolStale`, `agentProposalExpired`, `agentPinMissing`,
  `agentUnpublished`, `effectDispatchFailed`, … (fluem como eventos de recurso `incident`).

Cresce por **adição**, nunca renomeia (estabilidade do contrato, insumo AG-2 já pedia).

---

## 7. Decisões que trago para a triagem (marcadas [Decisão] acima)

- **A** — evento de instância sem ator → `actor: null` (honesto) vs `{system,engine}`. Recomendo `null`.
- **B** — âncora v1 = auto-referência verificável (digest+intervalo no `audit.export`); ancoragem externa é infra do Gate de Piloto. O campo já existe; não reivindico "ancorado" sem runtime.
- **C** — recibo no header vs corpo do JSON. Recomendo corpo (`{receipt, records}`) para o JSON e header para o CSV.
- **D** — `audit:export` é papel novo no RBAC (só admin/auditor). Confirmar quem recebe.

## 8. Aceite (o que os testes vão provar, quando você aprovar o shape)
- `normalizeActor` idêntico das DUAS formas físicas (colunas × jsonb) — teste nomeado dos dois caminhos;
- export determinístico: mesma consulta → mesmo digest; ordem total estável;
- `verify` casa recibo→digest; `matches:false` quando a trilha diverge;
- export e verify **auditados** (aparecem na própria trilha de tenant);
- **evidência nunca é conteúdo**: varredura do export FALHA se qualquer valor pessoal/sensível
  aparecer (mesma acidez do teste de ledger da F2).

Aguardo sua triagem dos pontos A–D e do shape geral antes de escrever a rota.
