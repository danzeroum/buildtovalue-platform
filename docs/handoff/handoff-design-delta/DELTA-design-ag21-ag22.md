# DELTA de design — AG-2.1 / AG-2.2 (criações da implementação)

> **De:** Designer da plataforma BuildToValue · **Data:** 2026-07-24
> **Ref.:** `main @ e9712d9` — `apps/console/src/app.css`, `packages/shared-ui/src/tokens.css`, `apps/console/src/routes/tasks.tsx`
> **Artefatos:** `Delta-Decisao-e-Tokens.html` (protótipo) · `Parecer-Delta-Design.html` (parecer)

Desde o Atlas de Governança, AG-2.1 (contratos/governança de runtime) e AG-2.2 (motor de
agente) correram sem o circuito de design. Três coisas nasceram na implementação e são
território de design; este delta ratifica/corrige e registra uma varredura do console real.

## Itens ratificados / corrigidos

**1 · Tom `gold` no `Tag` + `.decision-option` — RATIFICO A COR, CORRIJO O NOME.**
A leitura dourado = escrita/gate/decisão que roteia está certa. Mas `gate`, `warning` e a
classificação `personal` compartilham hoje o literal `--ui-role-warning-*`. Correção
(forma → shared-ui direto): uma **rampa dourada primitiva** + **papéis por intenção** —
`--ui-role-warning-*` (aviso), `--ui-role-gate-*` (decisão/gate), e a classificação numa
**escala própria** (fora do gate). Mesma cor hoje; divergível depois sem retrofit nas 7
superfícies. Princípio "papel semântico, não hex" (decisão C / Atlas E2).
**Falta um papel de agente:** `tokens.css` tem 5 famílias (success/warning/danger/info +
superfícies) e **nenhum papel de agente/squad**. Criar `--ui-role-agent-*` (violeta
`#5b57b8` / tint `#ecebf6`) em `tokens.ts` com teste de contraste AA **antes da AG-3** —
senão nasce ad-hoc como o dourado nasceu.

**2 · Controle de decisão — FORMA CANÔNICA (protótipo).**
Ratifico a abordagem do dev (opções derivadas do gateway, escolha exata, servidor recusa
fora da lista — melhor que os botões dos protótipos, casa com D19). Um só controle,
`DecisionOption { value, label, intent }`, serve à user task e ao gate de agente P1:
- **A cor vem da intenção, e só quando conhecida.** User task = `routing` (dourado —
  honesto: o sistema não sabe qual rota é "boa"; **é o que o dev já fez**). Gate P1 =
  `affirmative`/`destructive`/`neutral` (verde/vermelho/discreto). Mesma peça, não duas línguas.
- **Rótulo humano**; o valor cru permanece o dado auditado.
- Estados (travado/carregando/muitas-longas) e pós-decisão via **selo de procedência**
  (idêntico em tarefa/histórico/Operate).

**3 · Tela 05 — CIENTE, RATIFICO AS DUAS.** (a) Negócio vê o botão via
`startable-definitions` escopado por `instances:start` — fecha o beco do parecer do Console.
(b) Só a versão ativa — correto e coerente com D3/D19 (a instância nasce na versão publicada
e fica pinada). Iniciar versão anterior = rollback deliberado, permissionado e explícito
(F4/F5), não o padrão.

## Varredura do console (o que ninguém pediu)

| # | Achado | Classe |
|---|---|---|
| V1 | Alvo de toque < 44px em `.decision-option` (`padding:.35rem .8rem` ≈ 28px); vale p/ `.chip`, `.palette-pill`, `.segment` | a11y · direto |
| V2 | Um verbo, duas palavras: botão "Desatribuir…" vs voz do sistema "liberar"/"Tarefa liberada". Fixar: **"Liberar"** = soltar a própria (unclaim); **"Reatribuir"** = operador (D24 ✓); aposentar "Desatribuir" | microcopy · direto |
| V3 | Rótulo de decisão é o valor cru (`{opt}` verbatim, `aprovar` minúsculo). Convenção de rótulo humano; valor cru segue como dado auditado | microcopy · direto |
| V4 | Reatribuir por **campo de texto livre** (digitar id) — risco de typo. Vira seletor de pessoas (precisa endpoint de membros do papel) | **ESCOPO leve** |
| V5 | `var(--ui-surface-raised, #fff)` em `.task-decision` — fallback hex contra o cabeçalho "nenhum hex" (D25.1) | trivial · direto |
| ✓ | **Confirmações:** 403 forbidden e 409 claim-conflict (com `holder` nomeado) agora tratados — dois "ESCOPO" do parecer do Console, fechados pelo dev | reconhecimento |

## Protocolo de gate (etapa 5) — posição de design validada

Desenho do dev **"o agente propõe, o processo faz o gate"** aprovado do lado de design.
Consequências que são schema/runtime da etapa 5 (não visual da AG-3):
1. **"Aguardando gate humano" é estado próprio** no Operate (âmbar, link p/ user task),
   distinto de `blocked:budget` e `blocked:kill-switch`. Com staleness de tool e proposta
   expirada, são **quatro vozes de parada**.
2. **O efeito aprovado carrega o selo de procedência** `{gateId, tool, effectClass,
   actor{type,id,requestId}, approvedAt}` — é a prova de auditoria do D31 (schema, grava já).
3. **Controle canônico encaixa**: gate P1 = user task de decisão + world-delta ao lado +
   `expectedInstanceRevision` re-verificado.
4. **Staleness de tool** = 4ª voz ("efeito não executado — a tool mudou desde a aprovação").
5. **Proposta expirada** (D28) = estado com voz, não botão mudo; quem repropõe precisa de
   limite/ação explícita (cada reproposta consome budget).

**O world-delta agora tem schema** (congelado a partir do P1 anotado): campos do
`ToolContract` `{tool, capability, effect, authorization, dataScope, evidenceRequired,
params}` + **consequência derivada do processo** (BPMN a jusante). Regra: nunca inferir
consequência que possa estar errada — degradar honestamente para "só as consequências da tool".

## Mapa de aplicação

- **Protótipo (entregue):** controle de decisão canônico; aliasing gold→gate + papel de agente.
- **Direto → shared-ui:** renomear papéis (gate/warning/classificação); criar `--ui-role-agent-*` (AA); "Liberar" (V2); rótulo humano (V3); piso 44px (V1); remover `#fff` (V5).
- **ESCOPO (passa pelo plano):** intenção por rota na publicação (colorir Reprovar); seletor de pessoas (V4); iniciar versão anterior (rollback).

## Rito novo
Mudança em `shared-ui`/tokens/controle novo = dev sinaliza na PR, designer ratifica em
paralelo (não trava) — mesma disciplina de contrato e migração.
