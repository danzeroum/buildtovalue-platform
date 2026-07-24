# Proposta de SHAPE — AG-2.3 (export de auditoria + verificação de integridade)

**Estado: APROVADO com triagem A–D (2026-07-24).** Este documento é o shape aprovado;
as quatro decisões abertas foram resolvidas pelo dono e estão dobradas no texto (marcadas
**[A]…[D] — resolvido**). A rota é implementada contra este shape.

**Gate:** shape antes de implementar (política 3.2). Triagem do dono contra: §2.14.2
(normalização do envelope das duas trilhas), recibo com digest ancorado, rota de
verificação auditada, catálogo de `event_type` publicado. Nada implementado antes do "ok" — dado.

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

Regras de normalização:
- **`actor`** — `tenant`: dos campos-coluna; `instance`: de `payload->'actor'`. Evento de
  instância SEM ator (engine puro: `instanceCompleted`, timers) → **`actor: null`**.
  **[A] — resolvido:** `null` (não `{type:'system',id:'engine'}`). `actor: null` significa,
  no contrato, **"ato do motor, sem ator"** — o engine avançou o token por sua própria mecânica
  determinística (D6), não houve humano/sistema/agente nomeado. Isso vai documentado no catálogo
  (§6) e no OpenAPI: `null` é honesto ("sem ator nomeado"), inventar `system` seria atribuir
  autoria a quem não a tem.
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

**Ordem total:** por `at` ascendente; empate → `source` (`instance` antes de `tenant`),
depois `seq`/`id`. Determinística para o digest ser estável.

**Meta-eventos fora do snapshot (decisão de implementação, honesta):** os eventos da
PRÓPRIA auditoria (`audit.export`, `audit.verify`) **não entram** no conjunto exportado.
Motivo: o ato de exportar grava um evento; incluí-lo tornaria o digest não-reproduzível (o
export mudaria o próprio resultado). Eles seguem gravados, imutáveis e consultáveis à parte
— só não fazem parte do snapshot de negócio. Somado ao `to` pinado no recibo (§4), é isso que
faz "mesma consulta → mesmo digest" ser verdade. Não é ocultação: é a condição para o export
poder provar a si mesmo.

---

## 3. Rota do export — `GET /v1/audit/export`

- **Permissão:** `audit:export` — concedida a `admin` **e** ao papel novo `auditor` (§7-D). A
  própria chamada é **auditada**: evento `audit.export` em `tenant_audit_events`. **[C] —
  resolvido:** esse evento de auditoria **carrega `digest` + intervalo (`from`/`to`) + os
  filtros aplicados** no seu `payload` (além de `count`) — de modo que a trilha por si só
  registra QUAL export foi tirado, com QUE recorte e com QUE digest, sem depender do recibo
  entregue ao cliente. O auditor é auditado, e a auditoria é auto-suficiente.
- **Filtros** (querystring): `from`/`to` (período, obrigatório o `from`?), `actorType`,
  `actorId`, `eventType`, `resourceType`, `resourceId`, `source` (`instance|tenant|both`,
  default `both`). Os índices da 0006 já cobrem período/ator/tipo/recurso na trilha de tenant;
  para `history_events`, filtro por período/instance + varredura ordenada por `seq`.
- **Formato:** `format=json|csv` (default `json`).
  - **JSON** = a forma canônica (o digest é computado sobre ela — canonicalização estável:
    chaves ordenadas, sem espaços, timestamps ISO em UTC).
  - **CSV** = a MESMA sequência achatada (o `actor` vira `actor_type,actor_id,actor_request_id`);
    o digest referenciado é o **do JSON canônico** — o formato de visualização não muda a prova.
- **Resposta:** os registros (§2) + um **recibo** (§4). **[C] — resolvido:** no **JSON**, o
  recibo vai no **corpo** (`{ receipt, records }`); no **CSV**, vai no **header** `X-Audit-Receipt`
  (o corpo CSV é a sequência achatada, sem lugar para um objeto). Paginação por cursor se o
  intervalo for grande.

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
  "assurance": "self-recorded",   // [B] o recibo declara seu PRÓPRIO nível de garantia
  "assuranceNote": "Digest e âncora gravados pela própria plataforma no evento audit.export; ainda não há notarização externa/WAL imutável (infra do Gate de Piloto).",
  "generatedAt": "…",
  "generatedBy": { "type": "user", "id": "auditor@acme", "requestId": "…" }
}
```

- **`digest`** — hash da sequência canônica (não do CSV). Recompoível por quem tiver os mesmos
  filtros + os mesmos dados. **Determinístico** pela ordem total (§2).
- **`anchorRef`** — a referência de ancoragem (D35). A v1 ancora contra o **mínimo honesto**:
  `anchorRef` = o próprio digest + o intervalo, gravado no evento `audit.export`
  (auto-referência verificável). Ancoragem externa (WAL imutável / notarização) é item de infra
  do Gate de Piloto — o shape já reserva o campo, o backend enche com o que a infra do piloto
  fornecer. Nada de reivindicar "ancorado-verificável" (D30) sem runtime real.
- **`assurance` — [B] resolvido:** o recibo **declara seu próprio nível de garantia**, em vez de
  deixar o leitor inferir. Na v1 o valor é **`"self-recorded"`** com a frase de `assuranceNote`
  acima: a prova é auto-registrada pela plataforma (o mesmo sistema que gera o export gera o
  digest), **não** notarizada por terceiro independente. Quando a infra do piloto trouxer
  ancoragem externa, o valor sobe (ex.: `"externally-anchored"`) — o campo é o lugar honesto
  onde essa evolução aparece. É o mesmo princípio do "estado de evidência" do selo de procedência
  (auditado ≠ ancorado-verificável): o recibo nunca finge um grau de garantia que não tem.

---

## 5. Rota de verificação — `POST /v1/audit/verify`

- **Permissão:** `audit:export` (mesma — admin + `auditor`); **auditada** (evento `audit.verify`).
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

## 7. Decisões — triagem do dono (2026-07-24, todas resolvidas)

- **[A] — resolvido: `actor: null`.** Evento de instância sem ator nomeado grava `actor: null`,
  documentado no contrato como **"ato do motor, sem ator"** (§2). Não se inventa `{system,engine}`.
- **[B] — resolvido: recibo declara seu próprio nível de garantia.** Âncora v1 = auto-referência
  verificável (digest+intervalo no `audit.export`); **e** o recibo carrega `assurance:
  "self-recorded"` + frase (§4) — o grau de garantia é declarado, não inferido. Ancoragem externa
  é infra do Gate de Piloto e sobe o valor de `assurance` quando existir.
- **[C] — resolvido: corpo no JSON, header no CSV — e a auditoria carrega a prova.** Recibo no
  corpo (`{receipt, records}`) para JSON, header `X-Audit-Receipt` para CSV (§3). **Adição:** o
  **evento de auditoria `audit.export` carrega `digest` + intervalo + filtros** no payload, para a
  trilha ser auto-suficiente sem depender do recibo entregue.
- **[D] — resolvido: novo papel `auditor` [GATE].** Criar agora o papel `auditor`: **somente
  leitura + `audit:export`, zero escrita**. Conceder `audit:export` a `admin` **e** `auditor`.
  Marcado **[GATE]** (mudança de RBAC/segurança passa pelo gate). O aceite (§8) inclui um teste
  que prova que `auditor` **não escreve nada** — toda rota de escrita (advance, complete,
  reassign, config, deploy, …) responde 403 para o papel `auditor`, e nenhuma trilha de escrita
  aparece com `actor.id` de auditor.

## 8. Aceite (o que os testes provam)
- `normalizeActor` idêntico das DUAS formas físicas (colunas × jsonb) — teste nomeado dos dois caminhos;
- **[A]** evento de instância sem ator → `actor: null` no export (não `system`);
- export determinístico: mesma consulta → mesmo digest; ordem total estável;
- **[B]** recibo carrega `assurance: "self-recorded"` + nota; digest+âncora coerentes com o evento `audit.export`;
- **[C]** JSON leva `receipt` no corpo, CSV leva `X-Audit-Receipt` no header; o **evento `audit.export`
  registra `digest` + intervalo + filtros** (asserção direta na trilha de tenant);
- `verify` casa recibo→digest; `matches:false` quando a trilha diverge;
- export e verify **auditados** (aparecem na própria trilha de tenant);
- **[D] papel `auditor` não escreve nada**: teste que o papel `auditor` recebe `audit:export`,
  lê o export, e **falha se qualquer rota de escrita não devolver 403** (advance, complete,
  reassign, config.ai, deploy, reproposta, reveal-var, …) — e que nenhuma trilha de escrita
  carrega `actor.id` de auditor;
- **evidência nunca é conteúdo**: varredura do export FALHA se qualquer valor pessoal/sensível
  aparecer (mesma acidez do teste de ledger da F2).

Shape aprovado com a triagem A–D acima. A rota é implementada contra este documento.
