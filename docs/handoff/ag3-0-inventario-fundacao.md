# AG-3.0 — Inventário da fundação (para o designer)

Rito (ajuste 1 do dono): **inventário → marcação (rótulo/voz/tratamento) → código**.
Sem protótipo novo. Este doc lista o **dado REAL**, o **exemplo REAL** e **o que NÃO
existe**, e traz a **marcação** proposta. Tudo com `file:line` — nada inventado.

Escopo AG-3.0 (fundação `shared-ui`, ajustado à realidade):
1. **Selo de procedência** (ator + estado de evidência) — componente novo.
2. **Primitivas de gate/autonomia** — apresentacionais (o controle *wired* de
   aprovar/reprovar é a AG-3.1 / P1).
3. **Estados não-ideais** sem teste (forms/studio) — fechar a dívida + unificar no `NonIdeal`.
4. Tokens `--ui-role-gate-*`/`--ui-role-agent-*` — **achado: já existem com teste AA**.

---

## 1. Selo de procedência

### Dado REAL (o que o runtime produz)
- **Envelope de ator (D33)** = `user | system | agent` (`packages/db/src/audit/tenantAudit.ts:13`),
  **+ um quarto caso `null`** = ato do motor, sem ator (`packages/db/src/audit/export.ts:39`:
  *"não se inventa `{system,engine}` — `null` é honesto"*). São **quatro** casos.
- A `/v1/audit/export` já carrega o envelope inteiro no schema do console:
  `actorType`, `actorId`, `assurance`, `assuranceNote`, `anchorRef`, `unanchoredCount`
  (`apps/console/src/api/generated/schema.d.ts:2731-2810`).
- **Assurance = `'self-recorded'` SÓ** (`packages/db/src/audit/export.ts:64`). O rótulo
  `externally-anchored` **não emite** até WAL imutável no piloto.

### Exemplo REAL
- Máscara já renderiza (fragmento do estado "mascarado"): `apps/console/src/routes/operate.tsx:591-614`
  → `<span className="masked" aria-label="valor mascarado">••••••</span>`; fail-closed em
  `:594` (`v.masked === true || classification === 'sensitive'`).
- Rótulos de evidência de agente (texto, não selo): `apps/console/src/voices.ts:41` `'I/O (mascarado)'`, `:43` `'evidência'`.

### O que NÃO existe
- **Nenhum componente de selo.** A palavra "selo" aparece só numa nota diferindo-o
  (`operate.tsx:377` "com selo … entra na AG-3"). O `HistoryTab` que seria o hospedeiro
  natural **nunca lê `e.actor`** — mostra só `kind` + hora (`operate.tsx:660-666`).
- **Estado "negado" NÃO existe no backend** — E5 (404/403/tombstone) está aprovado no
  design mas não construído (zero ocorrências de tombstone/retention no código).
- **`shared-ui` exporta só tokens** (`packages/shared-ui/src/index.ts` — sem componentes).

### 🔴 Achado honesto (decisão de ESCOPO para o dono)
Dos **4 estados de evidência** do design (auditado · ancorado-verificável · mascarado ·
negado), o runtime hoje só sustenta **auditado** e **mascarado** plenos; **ancorado** é
parcial (âncora + `verifyAnchors` existem, mas `assurance='self-recorded'`); **negado**
não existe. Pintar "negado" ou afirmar "ancorado-verificável" como estado pleno seria
**fabricar evidência** — viola o princípio-mãe (D30: `evidência-verificada` só do runtime
real). **Proposta:** o selo v1 renderiza só o que é real; os outros dois entram quando o
backend os produzir (E5 / WAL imutável).

### Marcação (designer)
| eixo | valor |
|---|---|
| **Ator — rótulo/voz** | `Pessoa` (user) · `Sistema` (system) · `Agente` (agent) · `Motor` (null). Voz neutra, factual — nunca "desconhecido" para o `null` (é o motor, não ignorância). |
| **Ator — tratamento** | `agent` → papel violeta (`--ui-role-agent-*`); `user`/`system`/`Motor` → tinta neutra (`--ui-ink-*`) + ícone próprio. **Sinal nunca só cor**: ícone + rótulo sempre. `actorId` em `--ui-font-mono` (regra do mono). |
| **Evidência — rótulo** | `auditado` (verde `--ui-role-success-*`) · `mascarado` (dourado `--ui-role-gate-*` + cadeado) · `ancorável` (info `--ui-role-info-*`, **com nota** `self-recorded`, nunca "verificado"). **Sem** `negado` na v1. |
| **Evidência — tratamento** | selo pequeno (piso `--ui-font-size-meta` = 11px), ícone + rótulo; `ancorável` só aparece onde `anchorRef != null`; a nota de assurance vem do `assuranceNote` real. |

---

## 2. Primitivas de gate / autonomia

### Dado REAL
- `GateWaitingNote` — nota âmbar read-only quando a instância está parada num gate
  (`operate.tsx:355-386`, acha `t.isGate` em `:365`). Diz explícito: *"O controle canônico
  de aprovar/reprovar entra na AG-3"* (`:377`).
- Variante gate-expirado: "Aprovar indisponível … Reprovar segue disponível" (`:425-431`, prosa).
- Vozes (rótulos, não interativos): `voices.ts:18` `'kill-switch'`, `:19` `'aguardando-gate'`, `:47` `'decisão de tarefa (gate)'`.
- Tokens de papel gate: `apps/console/src/app.css:106,205,214`.

### O que NÃO existe
- **Controle de aprovar/reprovar (world-delta)** — não há; é a AG-3.1 (P1). A fundação
  entrega só as **primitivas apresentacionais**.
- **Dial de autonomia — não existe** (zero hits de `autonom|dial` em `src/`). A assinatura
  "autonomia como dial" está por construir.
- **kill-switch / world-delta como componente** — não; só rótulos + tipos de API (`schema.d.ts:1173` `kind:"budget"|"kill-switch"`).

### Marcação (designer)
| primitiva | marcação |
|---|---|
| **Selo de gate** | papel `gate` (dourado `--ui-role-gate-*`); rótulo `Gate humano`; ícone de balança/portão + rótulo. Estado âmbar = **parada honesta**, nunca vermelho (assinatura F-AG). |
| **Dial de autonomia** | apresentacional (nível 0–5, D-ref da lib); leitura, não escrita, na v1. Nível alto NÃO vira alarme vermelho — é dourado `gate` (exige gate) vs neutro. Rótulo textual do nível sempre ao lado do dial (nunca só posição). |
| **Estado de âmbar** | reusa o padrão de `GateWaitingNote`: âmbar + saída honesta (aprovar indisponível ⇒ reprovar roteia sem executar). |

---

## 3. Estados não-ideais (forms/studio)

### Dado REAL — primitiva compartilhada sólida
- `NonIdeal` (`apps/console/src/ui/ui.tsx:88-126`): `kind: empty|loading|error|forbidden|conflict`;
  loading = skeletons (`:106-110`), error = `role="alert"` (`:114`). Máquina de estado
  `useResource.ts:11-14` (`loading|forbidden|error|ready`).
- **tasks** e **operate** têm a tríade completa (loading/empty/error via `NonIdeal`).

### O que NÃO existe / dívida
- **forms** (`routes/forms.tsx`): **sem loading, sem empty** (editor de estado local, nada
  buscado no mount); erro é **hand-rolled** `<div className="publish-error">` (`:117-118`), **fora** do `NonIdeal`.
- **studio** (`routes/studio.tsx`): **sem empty**; erro de publish também hand-rolled (`:122-125`); lint em erro de API é engolido para `[]` (`:74`).
- **Dívida de teste** (achado do inventário):
  - loading **não testado em nenhuma tela**;
  - **forms erro NÃO testado** (`forms.test.tsx:44` cobre só sucesso 201);
  - **studio erro de deploy NÃO testado** (`studio.test.tsx:33` mocka sucesso); studio empty/loading não testados;
  - empty testado só em tasks (`tasks.test.tsx:199`) e operate (`operate.test.tsx:161`);
  - a11y (axe=0) roda por tela mas contra estado **carregado**, não contra os não-ideais.
  - **Não há camada e2e/Playwright** no console (só `*.test.tsx`).

### Marcação / decisão (designer)
- **Unificar**: forms e studio passam a usar o `NonIdeal` para erro (fim do `publish-error`
  hand-rolled) — voz e tratamento idênticos às outras telas (`role="alert"`, `--ui-role-danger-*`).
- forms ganha **empty** ("formulário em branco — comece por um campo") e studio ganha
  **empty** ("nada publicado ainda"); loading onde há busca real.
- **Fechar a dívida de teste**: teste de erro em forms e studio; loading/empty onde
  aplicável; axe contra os estados não-ideais (não só carregado).

---

## 4. Tokens `--ui-role-gate-*` / `--ui-role-agent-*`

**Achado: já existem, com teste AA.** `packages/shared-ui/src/tokens.css:42-48` (gate dourado,
agent violeta) e `tokens.ts:57-64`, ambos em `CONTRAST_PAIRS` (`tokens.ts:93-94`) — o teste
de contraste (`tests/tokens.test.ts`) já os trava em ≥AA. **Nada a fazer** aqui além de
consumi-los nos componentes novos. (Registrar para não recriar.)

---

## Net para o código (após a marcação ser aprovada)
- **Construir novo:** selo de procedência (ator 4-casos + evidência 2,5-estados honestos);
  dial de autonomia apresentacional; selo de gate. Tudo em `shared-ui`, consumindo os tokens
  existentes, com teste AA + sinal-não-só-cor.
- **Reusar/estender:** `NonIdeal` + `useResource` (sólidos) — trazer forms/studio para dentro.
- **Dívida de teste a fechar:** loading em geral; forms/studio erro; studio empty/loading;
  axe contra não-ideais.
