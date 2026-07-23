# AG-2.2 etapa 5 (D31) — gate de tool: o agente PROPÕE, o processo faz o GATE

Design validado pelo dono + designer (os dois encaixes confirmados). Este doc é o
contrato da etapa; slices 2–3 têm dependências de design anotadas.

## Forma canônica
Para efeito com gate (`write-irreversible` / `external-commitment` — `effectRequiresGate`
= true), o `agentTask` **NÃO executa** o efeito: **PROPÕE** (o walk termina produzindo o
world-delta como saída). `validateGraph` + `reachableGateFrom` (core) exigem um `btv:gate`
a jusante (autonomia ≤3). O efeito roda como **serviceTask downstream, DEPOIS do gate**.
Como o interior é não-determinístico (D27), não há "replay até o gate" — propor (walk
completa) em vez de pausar-no-meio elimina o "aprova X, acontece Y".

## Respostas às três perguntas
- **Mecanismo (Q3):** o job do agente **COMPLETA com resultado estruturado = a proposta**
  (world-delta). Não é incidente nem falha. O engine roteia (pelo `btv:gate` que o lint
  garante) para uma **user task de gate** com o world-delta. Aprovar → serviceTask executa
  a tool. Reprovar → rota de reprovação.
- **Retomada (Q2):** **não há retomada de walk** — o walk já completou. Budget consumido
  uma vez, antes do gate, contado no total. Sem re-run → sem "aprova X, acontece Y". A
  trilha é UMA cadeia: `fatos do agente → gate → efeito`, com o gate no meio.
  - *Limite de escopo:* autonomia 4-5 (raciocinar sobre o resultado de tool irreversível)
    exigiria walk pausável/serializável — o agentflow NÃO expõe isso hoje. Fora da v1;
    se entrar, é item de lote da lib (run pausável + store de estado + migração).
- **Reprovação (Q1):** o gate é decisão (aprovar/reprovar) — a máquina do `decisionVar`
  da AG-2.1 etapa 6. Reprovar → rota DEFINIDA (o lint EXIGE que exista, molde
  `EFFECT_NEEDS_GATE`); o efeito não executa; o Operate mostra `reprovado por <ator> ·
  <motivo> · <momento>`. Nunca silêncio.

## Os dois encaixes (validados)
- **(a) world-delta sem segunda chamada:** do walk único + `ToolContract` (uma resolução):
  `{ tool: id@version, capability, effect, authorization, dataScope, reversibilidade =
  classe, evidenceRequired, params (validados por matchToolParams) }`.
- **(b) evidência de volta ao efeito:** selo `{ gateId, tool, effectClass, actor{type,id,
  requestId}, approvedAt }` na linha de trilha do efeito. É a prova de auditoria do D31.

## Cinco adições (dono + designer) — schema/runtime, não visual
1. **CONSEQUÊNCIA DO PROCESSO no payload do gate** (não só do ToolContract): "abre prazo
   de 5 dias", "aguarda respostas" vêm do BPMN a jusante. Sem isso, volta a 2ª chamada.
   **Regra:** nunca inferir consequência que possa estar errada — mostrar menos > prometer
   errado. Concretamente: derive o **estruturalmente derivável a jusante do gate** (timer
   com duração, user task, end event); aceite **anotação opcional do modelador** para a
   frase humana; **degrade honesto** para "só as consequências da tool" quando não houver
   nenhum dos dois. Nada de texto por inferência frouxa.
2. **STALENESS DE TOOL = 4ª voz de parada** (kind próprio, não erro genérico): "efeito não
   executado — a tool `<id@version>` mudou/foi desabilitada desde a aprovação", com o gate
   aprovado ainda visível na trilha (o humano aprovou de boa-fé; a falha é posterior).
   Distinta de budget, kill-switch e needs-gate.
3. **PROPOSTA EXPIRADA (D28 re-verify) = estado com voz**, não botão mudo: "esta proposta
   expirou (a instância mudou); reavaliar". Existe no runtime.
4. **Quem repropõe** (decisão a trazer no slice 2): re-proposta automática pode entrar em
   laço (propõe → avança → expira → repropõe), cada uma consumindo budget. Definir: ação
   explícita (operador/gate) OU cap duro de repropostas por elemento, com consumo visível
   na trilha. **Lean do dev:** ação **explícita** como primária (nada automático) +
   **cap duro** por elemento como backstop de runaway; cada reproposta é job novo, budget
   visível; após o cap → parada honesta "reavaliação manual necessária". Confirmar no slice 2.
5. **Designer revisa o slice 3** (trilha + estados no Operate) ANTES do código (G-UX-3), e
   anota o **P1 com os campos reais do schema** — usar o P1 anotado como referência do payload.

## Consequências no Operate (designer)
- "Aguardando gate humano": espera `kind:'gate'`, âmbar, link p/ a task — **distinta** de
  `blocked:budget`, `blocked:kill-switch`, e das novas `tool-stale`/`proposta-expirada`.
  Cinco vozes, cinco estados.
- Controle canônico: user task de decisão com intents `affirmative`/`destructive`/`neutral`
  + world-delta ao lado + `expectedInstanceRevision` (D28) re-verificado na aprovação.

## Slices
1. **(livre, sem dependência)** registry de tool contracts (migração 0009, imutável,
   RLS+FORCE) + validação effect↔authorization (irreversível/external nunca `automatica`)
   + lint de deploy `EFFECT_NEEDS_GATE`/`GATE_NOT_COVERING` (via `reachableGateFrom`/
   `gateBypassRoute` do core, `isGate` domínio-injetado).
2. runtime: propõe→gate→efeito com selo + D28 re-verify + rota de reprovação + decisão do
   item 4 (quem repropõe). Grava já: world-delta no `user_tasks.payload`, selo no efeito.
3. **[designer antes]** trilha do gate/efeito (selo schema) + estados no Operate (itens 1-3
   das adições como vozes próprias). Usar o P1 anotado.

Sem lote de lib para a v1 (`effectRequiresGate`/`matchToolParams` bastam).
