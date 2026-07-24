# Auditoria de evidência — Gate de Piloto 8.4 (13 itens)

> Mesmo método da auditoria da AG-2.2 (`docs/reports/ag2-2.md` §4), agora sobre os
> **13 itens** do Gate de Piloto (plano §8.4 itens 1–6 + ADENDO-02 §6 itens 7–9 +
> ADENDO-03 §4 itens 10–13). Cada item é classificado:
>
> - **(a) provado por máquina** — teste/benchmark **no CI** que falha quando a
>   propriedade quebra; cita o arquivo.
> - **(b) verificado uma vez** — feito e documentado, sem gate automático.
> - **(c) nunca verificado / depende de infra** — não existe evidência, ou depende
>   de infraestrutura ainda não provisionada.
>
> Princípio vinculante (dossiê): *critério sem gate de máquina é HIPÓTESE, não fato*.
> Vários itens do gate são **rituais de ambiente** (ensaio, simulação, demo) ou
> **infra** (secret manager, KMS, WAL imutável) — por natureza não viram teste de
> unidade; para esses, a honestidade é dizer **(b)/(c)** e nomear o que falta.

## Tabela 13 itens

| # | Critério | Classe | Evidência / o que falta |
|---|---|---|---|
| 1 | RLS+FORCE testada; API sem BYPASSRLS; papel de migração separado | **(a)** | `packages/db/tests/rls-isolation.test.ts` (17 tabelas FORCE; cross-tenant vazio) |
| 2 | Redaction testada; TLS; secrets em secret manager; audit de deps verde | **(a)** redaction · **(c)** resto | redaction: `observability/tests/redaction.test.ts` + `apps/api/tests/log-leak.e2e.test.ts`. **Falta (c):** TLS (infra), secret manager (infra §A), `pnpm audit` no CI (não há step — **posso adicionar já**) |
| 3 | Backup automatizado + restore ensaiado e documentado | **(b)** restore · **(c)** automação | ensaio manual 2026-07-22 (`docs/runbooks/database.md`); **nenhum teste dirige** `backup.sh`/`pg_restore`; automação = infra |
| 4 | Ledger sem PII (teste); cifra de `sensitive` com KeyProvider em KMS — chave estática REPROVA (D20) | **(a)** testes · **(c)** KMS | `lgpd-seam.test.ts` (ledger sem PII + cifra ativa); KeyProvider de **KMS = infra §B** (hoje env → reprova de propósito) |
| 5 | Plano de incidentes escrito + simulação executada (G-LGPD-4) | **(c)** | não escrito, não simulado |
| 6 | Repo `buildtovalue-platform` → PRIVATE (D1 revisado) | **(c)** | decisão sua; verificação por método externo (404 anônimo) |
| 7 | Provider real do tenant piloto via secret manager; chave estática reprova | **(a)** o CHECK · **(c)** provider real | `key_ref LIKE 'secret://%'` (CHECK 0006) + `kill-switch.test.ts` provam a barreira; **provider real = infra §A** |
| 8 | Kill-switch ensaiado uma vez com evidência | **(a)** mecanismo · **(c)** ensaio no gate | `kill-switch.test.ts` prova o mecanismo; o **ensaio no ambiente do gate com evidência** não ocorreu |
| 9 | Demo AG-4 ponta a ponta no ambiente do gate | **(c)** | AG-4 não construída; ciclo de agente existe em CI com fixtures (`agent-cycle-e2e`), mas a demo real no gate não |
| 10 | Append-only: dump de grants + teste de UPDATE negado | **(a)** | `rls-isolation.test.ts` (UPDATE/DELETE negado nas trilhas); dump de grants é anexo trivial |
| 11 | WAL imutável / PITR no Postgres gerenciado do piloto | **(c)** | infra §C — reforço físico do append-only já imposto por permissão |
| 12 | Export de auditoria com recibo de ancoragem **verificado** | **(a)** laço self-recorded · **(c)** ancoragem externa | `audit-export.test.ts`, `audit.e2e.test.ts` (export+recibo+verify); a **ancoragem externamente verificável** depende da **AG-2.4 + WAL (§C)** — hoje `assurance: self-recorded` |
| 13 | Dossiê de conformidade v1 preenchido e revisado pelo dono | **(b)** | dossiê preenchido (`docs/compliance/dossie.md`); falta a **revisão/assinatura formal sua** |

**Saldo:** o núcleo de **produto** está em (a) — RLS, append-only, redaction, ledger
sem PII, cifra, kill-switch, export/verify. O que resta é **infra** (2/4/7/11 + TLS +
backup) e **rituais de ambiente** (3-restore, 5, 8-ensaio, 9, 6, 13) — nada disso é
retrabalho de código, e cada linha diz o que falta. Dois itens são **ação sua**
(6 repo-privado, 13 revisão do dossiê); um é **ação minha imediata** (2 — `pnpm audit`
no CI, sem depender de infra).

---

## O que minha parte precisa da infra (para você configurar certo de primeira)

Três seams. Os **requisitos** abaixo são product-agnostic; as **escolhas de produto**
(marcadas ⟶ DECISÃO) mudam só o adaptador que eu escrevo, não o contrato.

### §A. Secret manager → AIProvider (D29)

O DB guarda **só** `key_ref` no formato **`secret://<path>`** (CHECK `LIKE 'secret://%'`
na 0006; `assertSecretRef` no código). A chave **nunca** entra no banco nem no log — o
evento `config.ai.updated` audita só `{provider, model}`, jamais o segredo.

- **O que o AIProvider espera:** na AG-2.5 eu escrevo o *provider real* que, dado
  `key_ref`, resolve `secret://<path>` → busca o segredo → constrói o cliente LLM. A
  interface consumida é mínima: `complete(prompt) → { text, costCents? }`
  (`packages/db/src/agent/aiProvider.ts`).
- **Preciso de você:**
  1. ⟶ **DECISÃO — produto** (Vault / AWS Secrets Manager / GCP SM / outro). Define o
     SDK/endpoint que API+worker usam para resolver o ref.
  2. ⟶ **DECISÃO — convenção de path** que você vai provisionar. Sugiro
     `secret://tenants/<tenantId>/ai-key` (um segredo por tenant, alinhado ao
     `tenant_ai_config`).
  3. ⟶ **DECISÃO — auth do runtime ao SM.** Recomendo **workload identity** (a
     API/worker se autenticam por identidade da carga, sem um segredo-bootstrap em
     env). Se o produto exigir bootstrap, ele é a **única** credencial em env.
- **Variáveis que meu lado lê:** nenhuma para a chave (é `secret://`); só a **config do
  cliente do SM** (endpoint/região/identidade), que eu adiciono ao `@platform/config`
  assim que você escolher o produto.

### §B. KMS → KeyProvider (D20)

Hoje: env **`FIELD_KEY_SECRET`** (≥16 chars) → `createEnvKeyProvider` → scrypt →
AES-256-GCM, `keyId = 'env-v1'`. **Isso REPROVA o gate de propósito** (chave estática).

- **Formato em repouso (já definido, não muda):** `enc:v1:<keyId>:<iv>:<tag>:<dados>`.
  A **rotação já é desenhada**: o `keyId` versionado vive em **cada** registro cifrado,
  e `byId(keyId)` decifra registros de versões anteriores.
- **O que o KeyProvider espera do KMS** (interface `packages/db/src/crypto/fieldCipher.ts`):
  - `active()` → `{ keyId, key: Buffer(32) }` — **keyId versionado estável** + material
    ativo (ou data-key desembrulhada);
  - `byId(keyIdAntigo)` → `Buffer(32) | undefined` — material daquela versão, para
    decifrar registros pré-rotação.
  → o KMS precisa de **chaves nomeadas com VERSÕES** e **fetch-por-versão**.
- **Preciso de você:**
  1. ⟶ **DECISÃO — produto** (AWS KMS / GCP KMS / Vault Transit / outro).
  2. ⟶ **DECISÃO — modelo:** (i) o KMS me devolve os **32 bytes diretos** por versão, ou
     (ii) **envelope** — o KMS embrulha/desembrulha uma **data-key por tenant** e nunca
     solta a mestra. **Recomendo (ii), envelope por tenant** (a mestra nunca sai do KMS;
     a data-key desembrulhada vive só em memória por request). Eu implemento o provider e
     o mapa `keyId ↔ versão-do-KMS` conforme sua escolha.

### §C. WAL imutável / PITR (item 11) — e o que a AG-2.4 precisa dele

O append-only já é imposto por **permissão** (REVOKE UPDATE/DELETE de `app_api`, 0006).
Falta a camada **física**: arquivar WAL num **bucket object-lock (write-once)** + PITR,
para um tamper de super-usuário ainda ser **recuperável e detectável**.

- **Para a AG-2.4** (ancoragem de digest) eu preciso saber:
  1. ⟶ **DECISÃO — qual Postgres gerenciado** (RDS / Cloud SQL / self-managed) — define
     como referencio segmentos de WAL/LSN na âncora.
  2. o arquivo de WAL é **externamente imutável/timestampado** (object-lock)? É isso que
     deixa a âncora apontar para um substrato **que não se reescreve**, promovendo o
     `assurance` de `self-recorded` → **`externally-anchored`** (D30/D35) — sem runtime
     real de ancoragem externa, o dossiê **não** reivindica o rótulo.

Com **(§A produto + path + auth)**, **(§B produto + envelope-sim/não)** e **(§C
Postgres + object-lock)**, deixo a AG-2.5 pronta para plugar sem retrabalho.
