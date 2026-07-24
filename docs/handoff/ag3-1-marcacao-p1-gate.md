# AG-3.1 — Marcação do P1 (gate de world-delta)

> **De:** Designer da plataforma · **Data:** 2026-07-24
> **Par de:** `docs/handoff/ag3-1-inventario-p1-gate.md` (inventário do dev, `main`)
> **Rito:** inventário (dev) → **marcação (designer, este doc)** → código (dev). Rótulo, voz e
> tratamento. Sem código. Referência de forma: o P1 anotado
> (`handoff-agentes/…P1-anotado-2026-07-24.html`) — aqui amarrado aos shapes reais do runtime.

Responde às quatro perguntas do §7 do inventário + a **dimensão de PII** que o triador
levantou (o world-delta carrega dado pessoal — é decisão de apresentação, não só de backend).

## 0 · Pré-requisito confirmado do lado de design

A lacuna 5.1 (world-delta não chega ao console) é **pré-requisito**: sem o conteúdo do gate
exposto, não há o que o humano aprovar. Aprovo a fatia de backend vir primeiro. **Mas o que
é exposto já nasce com a disciplina de PII abaixo** — não exponha em claro para "depois
mascarar na UI"; o mascaramento é do dado, não da tela.

## 1 · Modo da Tasklist (Q1) — o gate ENTRA na Tasklist

O gate é **modo do detalhe de tarefa** na Tasklist (intento P1), não nota no Operate. A nota
read-only atual do Operate (`GateWaitingNote`) **permanece como espelho + link** ("esta
instância aguarda um gate → abrir na Tasklist"), mas a **superfície acionável é a Tasklist**.

- **Distinção na lista:** um item de gate se lê diferente de uma user task comum —
  - badge **`◆ decisão de agente`** (glyph de ator agente + papel `gate` dourado);
  - **chip de efeito** já no item (`external-commitment` / `irreversível` em vermelho da
    identidade; `reversível` em dourado) — o peso da decisão visível antes de abrir;
  - o **agente proponente** nomeado ("proposto por `agnt-compras@2.1.0`").
- **Ordem:** gates de efeito **irreversível/external** sobem ao topo (maior aposta primeiro);
  **nunca** auto-assumidos — claim persistente (D21) continua explícito.
- **Corpo (modo agente):** mesma moldura da Tasklist; o corpo troca para o contrato de gate
  (§2–§3). Reusa a fundação AG-3.0 (`GateSeal`/`AutonomyDial`/`EvidenceSeal`), com as duas
  correções da ratificação (papel `masked` próprio; glyphs sem emoji).

## 2 · Apresentação do world-delta (Q2) — consequência primeiro, contrato depois

Hierarquia do card do aprovador (de cima para baixo):

1. **Título em linguagem de negócio** — `capability` + `params` humanizados ("Enviar
   cotação a 3 fornecedores"). É o que o humano decide, não a assinatura técnica.
2. **Bloco world-delta — "se você aprovar, isto acontece no mundo":**
   - `dataScope` → **a quem/o que toca** (com a regra de PII do §5);
   - `effect` → **reversibilidade** em voz humana ("não pode ser desfeito" p/ irreversible/
     external; "pode ser corrigido depois" p/ write-reversible);
   - `processConsequence` → a **3ª linha** (timer→prazo, userTask→"vai para X", endEvent→
     "encerra o processo"), **com o badge de origem** (`derivado do processo` / `anotado`).
3. **Linha de contrato (secundária, mono)** — `tool id@version · effect · authorization ·
   evidenceRequired`. É o schema; vive abaixo, discreta, não compete com a consequência.
4. **`processConsequence = null` (degrade honesto):** o bloco **simplesmente omite a 3ª
   linha** e mostra a legenda calma *"só as consequências desta ação"*. **Nunca** placeholder
   vazio, **nunca** "consequência desconhecida" — ausência honesta, não buraco. (É a regra
   `worldDelta.ts:9-12` virada em tratamento visual.)

## 3 · Aprovar × Reprovar × Repropor (Q3) — o controle canônico, com peso por efeito

Reusa o **controle de decisão canônico** (delta AG-2): `decisionOptions` derivadas do gateway,
intents dão a cor.

| Ação | Intent | Tratamento |
|---|---|---|
| **Aprovar** | `affirmative` (verde sólido) | para efeito **irreversível/external**: verde sólido **+ confirmação de peso** que nomeia o irreversível ("Isto envia 3 e-mails agora e não pode ser desfeito") — é o "dourado + **vermelho** da identidade" do efeito irreversível. Para reversível: verde sem a confirmação vermelha. |
| **Reprovar** | `destructive` (vermelho contorno) | roteia pela aresta de reprovação (o lint exige); **efeito não executa**; grava "reprovado por `<ator>` · motivo". Visível, nunca silêncio. |
| **Escalar / Reavaliar** | `neutral` (discreto) | sai do fluxo sem julgá-lo. **Reproposta** usa a §6 da marcação AG-2.5: ação explícita, custo nomeado, **cap 3** desabilita com motivo à vista. |

**Fencing D28 com voz (crítico):** o card **pina a `revision` que renderizou** e a envia na
aprovação. Se a instância avançou enquanto o humano decidia → **não** um 422 mudo: a voz é
*"A proposta expirou enquanto você decidia — reavaliar"* (âmbar, §4). É o "não aprovar mundo
obsoleto" com rosto humano.

**Pós-decisão:** o chip escolhido + **selo de procedência** (`EffectSelo`: quem aprovou +
quando + `gate #id`), **idêntico** na tarefa, no histórico e no Operate.

## 4 · Paradas honestas (Q4) — remeto à marcação AG-2.5, sem divergir

As quatro vozes já estão marcadas em `ag2-etapa5-marcacao-superficies.md` (§1–§2/§6); **valem
igual aqui**, para não criar um segundo vocabulário:
- **proposta expirada** → âmbar, nota com **reavaliar explícito** e contagem visível;
- **tool stale** → incidente vermelho **com o gate aprovado ainda na trilha** (aval de boa-fé);
- **budget / kill-switch** → âmbar (parada honesta, retomável).
Todas com `GateSeal`/`EvidenceSeal` da fundação (âmbar, nunca vermelho para a espera).

## 5 · 🔒 PII no world-delta (ressalva do triador) — marcação de apresentação

O `dataScope` (destinatários) e os `params` (conteúdo proposto) carregam dado pessoal. **O
world-delta não pode ser um caminho paralelo que escapa do D20.** Marcação:

- **Herança de classificação, mascaramento por padrão.** Todo campo de `params`/`dataScope`
  que veio de variável classificada **sensível** entra no card **mascarado** (`EvidenceSeal`
  `mascarado`, com o papel `--ui-role-masked-*` da correção — **não** o do gate), com
  **revelação auditada** — a mesma disciplina de `variables`. *É requisito de backend provar
  por teste que herda, não por inspeção* (concordo com o triador; do meu lado, a UI assume
  mascarado como default e só revela sob ação auditada).
- **Mascarar não pode cegar a decisão.** O aprovador precisa decidir com o que vê: mostre o
  **formato não-sensível sempre** — "**3 destinatários**" (contagem), domínios se não forem
  sensíveis — e o detalhe cru (endereços, corpo) **atrás da revelação auditada**. Decidir
  "para quantos / que tipo de ação" sem expor o PII em claro; revelar é ato registrado.
- **Log/export:** o world-delta segue a **mesma redaction** das variáveis — nunca em claro em
  log/export; estender a asserção do leak-fail a este caminho (é backend, mas marco que a UI
  nunca recebe o campo sensível em claro sem reveal).
- **Quem revela** é RBAC (do dev): do lado de design, quem tem o gate atribuído/candidato vê o
  card mascarado e pode revelar (auditado); "expor tudo em claro" não é opção.

## Aceite do P1 (lado de design, quando eu revisar antes do merge — G-UX-3)
World-delta com consequência acima do contrato; `processConsequence=null` degrada sem buraco;
aprovar de efeito irreversível carrega a confirmação de peso; reprovar roteia sem executar;
D28 stale fala ("expirou enquanto você decidia"), não 422 mudo; **PII mascarada por padrão no
card com revelação auditada**; selo idêntico nas três superfícies; gate na Tasklist, não só no
Operate. Fundação AG-3.0 reusada com as duas correções.
