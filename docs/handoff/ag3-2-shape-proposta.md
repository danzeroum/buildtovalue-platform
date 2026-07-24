# AG-3.2 — Proposta de shape (dev → triagem do dono) · P4 (inteligência do tenant) + kill-switch

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Nenhuma rota
> codada antes do ok. Par de: ADENDO-04 (P4/kill-switch sobem por conformidade — Art. 14 do
> EU AI Act / item 8 do gate de piloto).
>
> **Estado da triagem:** dono aprovou no essencial; refinou dois pontos (leitura ampla do
> estado + motivo em dois níveis). Este doc reflete os refinamentos e aguarda o **ok de gate
> final** antes do código.

## 0 · Princípio de separação (o eixo)

**Ler estado ≠ acionar ≠ configurar** — três superfícies, três escopos, três níveis de risco.
E, dentro de "ler", **dois níveis**: o *fato* da pausa é público para a Operação; a *razão*
detalhada é reservada ao admin.

| Superfície | Escopo (novo) | Quem | Auditado |
|---|---|---|---|
| Ler **fato** do kill-switch (banner) | `ai:read-state` | **amplo** — todo papel que opera | não (leitura de estado) |
| Ler **razão** + config de inteligência | `ai:configure` | admin | não (leitura) |
| **Acionar/retomar** kill-switch | `ai:operate` | **admin** | **sim** (motivo nas duas direções) |
| **Configurar** inteligência | `ai:configure` | admin | **sim** (motivo) |

Racional do dono: *o banner existe para a emergência que o admin talvez não esteja olhando —
se "ler estado" colapsar em permissão de admin, o operador comum não vê que os agentes estão
pausados.* Por isso o fato é amplo. A razão pode conter contexto de incidente
("suspeita de vazamento no fornecedor X") → é dado reservado → fica na tela de admin.

## 1 · Rotas

### 1.1 · LER o FATO do kill-switch — Operação inteira (banner)
```
GET /v1/ai/kill-switch                                            → 200
{ "state":  "active" | "paused",
  "by":     { "type":"user|system", "id":"…" } | null,   // quem acionou (ator, envelope D33)
  "since":  "2026-07-24T14:03:00Z" | null }               // desde quando
```
- **RBAC `ai:read-state`** — amplo (operator·analyst·business·admin·auditor).
- **NÃO devolve `reason`** (nível 2). O banner lê "agentes pausados por *&lt;ator&gt;* às
  *&lt;hora&gt;*" — o **ato é público**, a razão não.
- Read-only, não auditado. Sem PII.

### 1.2 · LER a RAZÃO + config — admin
```
GET /v1/ai/config                                                → 200
{ "provider":"openai-compatible|anthropic", "model":"…", "baseUrl":"https://…"|null,
  "keyRef":"secret://…",           // o PONTEIRO, nunca o segredo
  "keyConfigured": true,           // conveniência p/ a UI (evita parsear o ref)
  "budgetCents": 12000 | null,
  "fxUsdBrl": 5.20 | null,         // câmbio por tenant (null → default do sistema)
  "killSwitch": {
    "state":"active|paused",
    "by": {…}|null, "since":"…Z"|null,
    "reason": "texto do motivo" | null   // NÍVEL 2 — só aqui, escopo admin
  },
  "updatedAt":"…Z" }
```
- **RBAC `ai:configure`** (admin). É onde a **razão detalhada** aparece.
- **A API NUNCA devolve a chave.** `keyRef` é `secret://…` (ponteiro); o segredo real nunca
  esteve no banco (`CHECK key_ref LIKE 'secret://%'`, migração 0006). `keyConfigured` é
  derivado, booleano.

### 1.3 · ACIONAR / RETOMAR o kill-switch — admin, motivo nas duas direções
```
POST /v1/ai/kill-switch          body: { "paused": true|false, "reason": "…" }   → 200
                                 (mesmo shape do fato, 1.1 — sem a razão no corpo de volta)
```
- **`reason` OBRIGATÓRIO pausando E retomando** → 422 se vazio/ausente.
- Mapeia em `setKillSwitch(sql, tenant, killed, actor, motivo)` — já **auditado**
  (`agent.killswitch.toggled`) e, ao **retomar**, **religa os jobs pausados na mesma TX**
  (retoma automática — §5.2).
- **RBAC `ai:operate`** — **admin apenas** (decisão do dono: acionar/retomar é do admin).
- **Resposta nunca devolve chave** (não há chave nesse caminho); nem a razão (o POST-eco usa
  o shape do fato). O motivo gravado é lido depois por 1.2 (admin).

### 1.4 · CONFIGURAR inteligência — admin, motivo, chave nunca volta
```
PUT /v1/ai/config
  body: { provider, model, baseUrl?, keyRef, budgetCents?, fxUsdBrl?, reason }   → 200 (shape de 1.2)
```
- **RBAC `ai:configure`** (admin). **`reason` obrigatório** (troca de provider/custo é
  sensível) → auditado.
- **`keyRef` validado** `secret://…` (D29); **`baseUrl`** validado https + host permitido
  (mesma guarda da AG-2.5); troca de provider re-valida o par.
- **`fxUsdBrl`**: câmbio sai do env `FX_USD_BRL` para **config por tenant** (o `costOf` já
  aceita `fxRates`). `null` → cai no default do sistema (env vira **piso**, não fonte única).
  **Taxa única por tenant** (auditada) — tabela de taxas datada fica p/ F4.

## 2 · RBAC — o [GATE]

Escopos novos: `ai:read-state` (amplo), `ai:operate` (admin), `ai:configure` (admin).
Mapa de GRANTS (`@platform/auth` = guarda real; `capabilities.ts` = espelho de UX):

| Papel | `ai:read-state` | `ai:operate` | `ai:configure` |
|---|---|---|---|
| admin | ✅ | ✅ | ✅ |
| operator | ✅ | — | — |
| analyst | ✅ | — | — |
| business | ✅ | — | — |
| auditor | ✅ | — | — (vê `keyRef` ponteiro em 1.2? **[decisão em aberto]**) |

- Papel admin do tenant = o **`admin` atual** serve (não há papel de tenant novo → sem
  coluna de papel na migração). Se o dono quiser um papel de tenant distinto de `admin`,
  isso vira decisão de migração à parte.
- **Aberto:** `auditor` enxerga a config (1.2) para evidência de binding do `keyRef`, ou a
  config fica invisível ao auditor? Proposta-default: auditor **lê** (ponteiro, nunca aciona/
  configura).

## 3 · Migração — **[GATE + MIGRAÇÃO 0018]**

`tenant_ai_config` hoje só tem `kill_switch boolean`. O banner precisa de **quem/quando/por
quê** sem varrer a trilha a cada render:
```sql
ALTER TABLE tenant_ai_config
  ADD COLUMN kill_switch_reason text,          -- NÍVEL 2 (só via 1.2, admin)
  ADD COLUMN kill_switch_by     text,          -- ator (envelope D33) — nível 1 (amplo)
  ADD COLUMN kill_switch_at     timestamptz,   -- desde quando   — nível 1 (amplo)
  ADD COLUMN fx_usd_brl         numeric(10,4) CHECK (fx_usd_brl IS NULL OR fx_usd_brl > 0);
```
- Denormalização para leitura **O(1)** do banner; **`tenant_audit_events` continua a fonte de
  verdade** (as colunas são só o "último estado" para o read barato).
- `kill_switch_reason` fica na mesma linha, mas **só a rota 1.2 (admin) o projeta** — 1.1
  (amplo) nunca o seleciona. A reserva é imposta na projeção da rota, não só na coluna.

## 4 · Fora deste shape (só rotas, conforme pedido)

UI do **banner** (Operate, persistente, fora da Admin) + **tela de config** (Admin) =
**marcação do designer** após a triagem destas rotas. A tela de config carrega os itens já
cravados na ADENDO-04 (senha temporária em card "Copiar e confirmar", "+ adicionar pessoa"
ausente, desativar-acesso nomeia os três efeitos) — mas isso é **AG-3.5 (admin)**, slice
seguinte, não este.

## 5 · Ordem de código (quando o gate abrir)
migração 0018 → `GET/PUT /v1/ai/config` → `GET/POST /v1/ai/kill-switch` → GRANTS + espelho
`capabilities.ts` → testes:
- **motivo nas duas direções** (pausar e retomar 422 sem motivo);
- **chave nunca volta** (nem `keyRef` resolvido; estender o leak-fail a estas respostas);
- **read amplo × write estreito** (operator lê fato, não aciona/configura; razão só no admin);
- **fato sem razão** em 1.1; **razão presente** em 1.2 (admin);
- **retomar religa os jobs** pausados por kill-switch (mesma TX).

## 6 · Decisões que o gate fecha
1. ~~`ai:operate` = operator+admin?~~ → **admin apenas** (decidido pelo dono).
2. ~~motivo no banner amplo?~~ → **não**: fato amplo, razão reservada ao admin (dois níveis — decidido).
3. `fxUsdBrl` = **taxa única por tenant** (proposta) vs. tabela datada (F4). *Confirmar.*
4. `auditor` vê `keyRef` ponteiro em 1.2? *Confirmar.*
5. Corte: **1.1–1.4 + migração 0018** nesta fatia; UI (banner + config) na marcação seguinte. *Confirmar.*
