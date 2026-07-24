# Marcação de superfícies — estados do agente (slice 3)

> **De:** Designer da plataforma · **Data:** 2026-07-24
> **Par de:** `docs/handoff/ag2-etapa5-inventario-estados.md` (verdade do runtime, `main` @ slice 2)
> **Divisão acordada:** **`kind` é contrato (do dev)** — não renomeio nada; **`label`, voz e
> tratamento visual são do design** — é o que fixo aqui. Onde o dev propôs kind novo
> (`agentProposalExpired`, `agentToolStale`), **adoto os nomes** e dou a voz.
> **Escopo (slice 3):** visibilidade **mínima no Operate que já existe** — card de incidente,
> nota de estado no detalhe da instância, aba de histórico. **A timeline rica do P2 e as
> superfícies P1–P7 são AG-3** (as linhas "AG-3" abaixo são referência, não pedido de agora).

## Regra de família (decide cor e onde renderiza)

- **Parada honesta / espera** → **âmbar** (`--ui-role-warning-*`; o gate usa `--ui-role-gate-*`).
  Nada quebrou: o agente ou o tenant pausou de propósito, ou espera um humano. **Não é card de
  incidente vermelho** — é **nota de estado (âmbar) no detalhe da instância** + fato na trilha.
- **Falha / incidente** → **vermelho** (`--ui-role-danger-*`). Algo precisa de ação. Renderiza
  no **card de incidente** que já existe (repetir/resolver). Voz específica, nunca "falhou".

Cor nunca sozinha — sempre **ícone + rótulo** (E9/axe). Precisa de uma variante `tone-warning`
no `.inline-banner` (hoje só há success/danger) — adição de shared-ui, é o âmbar honesto.

## 1 · As cinco paradas do AgentRunner (`AgentBlock.blocked`)

| `blocked` (kind — contrato) | Rótulo / voz (design) | Ícone | Família | Onde no Operate atual |
|---|---|---|---|---|
| `budget` | **Parada honesta — orçamento esgotado** | ⏸ | âmbar | nota de estado no detalhe + linha `agent:parada`; mostra consumo vs teto |
| `kill-switch` | **Pausado — kill-switch do tenant** | ⏻ | âmbar | nota de estado; nomeia quem acionou (envelope de ator) |
| `no-config` | **Sem inteligência configurada** — o agente não pôde rodar | ⚠ | vermelho (setup) | card de incidente; ação leva à config do tenant (P4) |
| `no-graph` | **Agente não resolvido no registry** (`agnt-x@1.0.0`) | ⚠ | vermelho (setup) | card de incidente |
| `walk-error` | **O agente não completou** (ex.: deadlock) | ⚠ | vermelho | card de incidente; repetir/resolver |

Distinção de design que importa: **`budget` e `kill-switch` são âmbar** (pausa esperada,
retomável — parada honesta é feature); **`no-config`/`no-graph`/`walk-error` são vermelho**
(algo está quebrado/mal configurado). A `message` real do runtime já nomeia nó/razão — a voz
acima é o **título**; a `message` entra como detalhe.

## 2 · Espera de gate + os dois estados novos

| kind (contrato) | Rótulo / voz (design) | Ícone | Família | Onde |
|---|---|---|---|---|
| aguardando gate (hoje: nó `btvGate` + `user_tasks.open`) | **Aguardando gate humano** | ⚑ | âmbar (papel **gate**) | nota de estado no detalhe **com link para a tarefa de gate**; distinta das paradas |
| `agentProposalExpired` *(adoto o nome)* | **Proposta expirada — reavaliar** | ↻ | âmbar | nota de estado: "a instância avançou desde a proposta"; **reavaliar é ação explícita** |
| `agentToolStale` *(adoto o nome)* | **Efeito não executado — a tool `id@version` mudou desde a aprovação** | ⚠ | vermelho (incidente) | card de incidente; **o gate aprovado permanece visível na trilha** (o humano aprovou de boa-fé) |

**Cap de reproposta (resolve a pergunta do budget):** `agentProposalExpired` **não** repropõe
em laço. Reavaliar é ação explícita (usa o `requestReproposal` que já existe), **cada reproposta
consome budget** e a **contagem aparece** na nota ("reavaliada 2×"). A voz diz: "reavaliar
consome novo orçamento".

## 3 · Trilha do agente (aba histórico existente — `history_events` `agent:*`)

Slice 3 mostra na **aba de histórico que já existe** (filtrável por `kind LIKE 'agent:%'`).
Cada linha: **ator** (agente ⬡ violeta `--ui-role-agent-*` · humano ◍ verde · sistema ⚙) +
kind mono + frase humana.

| kind real | Renderização da linha |
|---|---|
| `agent:pinResolved` | "⚙ pin resolvido → `agnt-x@1.0.0`" (ator `system`) |
| `agent:intencao` | "⬡ intenção declarada: …" |
| `agent:acao` | "⬡ ação: `tool id@version` → …" — **é aqui que o selo do efeito entra** quando a ação é o efeito sob gate (§4) |
| `agent:io` | "⬡ I/O **mascarado** ••" (classificação; fora de logs/exports) |
| `agent:decisao` | "⬡ decisão/regra: `expr`" |
| `agent:evidencia` | "⬡ evidência" + rótulo de origem `fixture` / `evidência-declarada` / `evidência-verificada` (**só runtime real**, D30) |
| `agent:parada` | "⬡ parada honesta: <voz da §1/§2>" — o fato que espelha o estado |

> **AG-3 (referência):** a timeline unificada humano+agente do P2 consome estas mesmas linhas;
> no slice 3 elas vivem na aba de histórico simples, sem a timeline rica.

## 4 · Gate, world-delta e selo (o fio do slice 3)

- **World-delta no `payload` do gate** (schema do P1): duas dimensões do `ToolContract` +
  `processConsequence`. Tratamento por `source`:
  - `derived` / `annotated` → renderiza a 3ª linha ("abre prazo…").
  - **`null` → mostra só as duas linhas da tool** (nunca inferir; mostrar menos > prometer errado).
- **Reprovar** roteia pela aresta definida (o lint exige) e **não executa**; grava "reprovado
  por `<ator>` · motivo" — visível, nunca silêncio. (O controle canônico aprovar/reprovar/escalar
  é AG-3; no slice 3 basta a decisão existir e rotear.)
- **Selo do efeito** na linha `agent:acao` do efeito: `{gateId, tool, effectClass,
  actor{type,id,requestId}, approvedAt}` — prova do D31; procedência, não conteúdo. **Grava já.**

## 5 · Marcador de gate consultável (resposta ao §5 do inventário)

Recomendo **sim** um marcador consultável em `user_tasks` (não depender de ler `btvGate` do
diagrama): o Operate e a Tasklist precisam distinguir "tarefa de gate" de user task comum por
consulta direta — é o que permite a nota "Aguardando gate humano" e, na AG-3, o modo-agente da
Tasklist. **O literal do kind/coluna é seu (contrato);** do lado de design, só preciso que
"gate" seja um estado consultável, não inferido.

## 6 · Proposta expirada + ação de reproposta (agora na etapa 5, marcação detalhada)

Com os dois `[ESCOPO]` entrando na etapa 5, o estado é persistido e a reproposta tem rota —
então marco a **ação**, não só o estado (senão seria aviso com botão inexistente, "nunca fingir").

**Estado `agentProposalExpired`** — nota de estado **âmbar** no detalhe da instância (não card
vermelho): título **"Proposta expirada — reavaliar"**, corpo *"A instância avançou desde a
proposta do agente; a proposta não vale mais."* + a ação abaixo. Ícone ↻.

**Ação "Reavaliar proposta"** (o `requestReproposal`, exposto):
- **Rótulo:** `Reavaliar proposta`. Vive **dentro da nota âmbar** (é retomada honesta, não incidente).
- **Confirmação que nomeia o custo** (antes de disparar): *"Reavaliar gera uma nova proposta do
  agente e **consome novo orçamento**. Reavaliada `N×` de `M`."* — o custo nunca é surpresa.
- **Contagem visível:** "reavaliada `N×`" na nota; **cada reproposta é um fato na trilha**
  (envelope de ator + momento + "reproposta #N") — auditável, não silenciosa.
- **Cap duro atingido:** o botão fica **desabilitado com o motivo à vista** — *"Limite de
  repropostas (`M`) atingido — resolva manualmente ou escale."* Nunca some, nunca clica sem efeito.
- **Permissão:** ação gated (o literal da capability é do dev); sem permissão, não aparece o botão
  (a nota do estado permanece legível).

Isto fecha a Q4 ("ação explícita + cap duro") de forma real: a ação existe, tem rota, tem custo
visível e teto honesto. Tudo no detalhe da instância que já existe — sem superfície nova (AG-3).

## Aceite do slice 3 (lado de design)

Quando eu revisar antes do merge (G-UX-3): os `blocked`/kinds emitidos batem com §1/§2 e cada
um fala a voz certa (âmbar vs vermelho); a linha `agent:acao` do efeito carrega o selo completo;
`processConsequence:null` degrada para duas linhas; reprovar roteia sem executar; `agentToolStale`
preserva o gate aprovado na trilha; e a reproposta é ação explícita com contagem visível.
Tudo no Operate que já existe — timeline rica e P1–P7 seguem para a AG-3.
