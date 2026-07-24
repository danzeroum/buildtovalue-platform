# AG-3.1 — Inventário do P1 (gate de world-delta) · para MARCAÇÃO do designer

Rito: **inventário (dev) → MARCAÇÃO (designer) → código (dev)**. Este doc é só o
inventário — dado REAL, exemplo REAL (dos testes), e **o que o runtime/API NÃO
produz**. Sem marcação e sem código (a marcação de rótulo/voz/tratamento é do
designer; o selo da AG-3.0 aguarda ratificação dele). P1 é a superfície de maior
aposta — nenhum atalho.

Design de referência (não repetir protótipo): P1 = **modo da Tasklist, não rota**;
gate como **contrato de confiança**; **parada honesta em âmbar, nunca vermelho**.

---

## 1. World-delta — o que o runtime PRODUZ (o conteúdo do gate)

Shape congelado em `packages/db/src/agent/worldDelta.ts:14-38` (`WorldDelta`):

| campo | origem | observação |
|---|---|---|
| `tool` (`id@version`) | ToolContract resolvido 1× | ref pinada |
| `capability` | contrato | o que a tool faz |
| `effect` (`ToolEffect`) | contrato | classe do efeito (read/write/external/irreversible) |
| `authorization` | contrato | quem autoriza |
| `dataScope` | contrato | escopo de dados tocado |
| `evidenceRequired` | contrato | evidência exigida |
| `params` | **proposto pelo agente** | validado por `matchToolParams` no deploy |
| `processConsequence` | derivado do BPMN **ou** anotado **ou `null`** | ver abaixo |

**`processConsequence`** (`worldDelta.ts:26-38`, `deriveProcessConsequence:47`):
`{ source: 'annotated'|'derived', kind: 'timer'|'userTask'|'endEvent'|'annotation', description }`.
Regra de honestidade P1 (`worldDelta.ts:9-12`): sem regra estrutural nem anotação →
**`null`** ("só as consequências da tool"). *"Mostrar menos > prometer errado ao
aprovador."* — a UI tem que renderizar o caso `null` sem inventar consequência.

**Selo do efeito** pós-aprovação (`packages/db/src/agent/gate.ts:121-137`, `EffectSelo`):
`{ gateId, tool, effectClass, actor (AgentActor), approvedAt (ISO) }` — quem aprovou + quando.

## 2. Decisão aprovar/reprovar — como o runtime DECIDE

**Não há verbo de gate próprio.** A decisão passa pela **conclusão da userTask** de
gate (`packages/db/src/runtime/userTasks.ts:270-360`):
- o gate é uma `userTask` com `btvGate` → `is_gate=true`, resolvido no despacho
  contra a definição PINADA (`gate-tasklist.test.ts:68-81`);
- gate **não tem formulário** (`userTasks.ts:292`) — a decisão é `decision` (aprovar/
  reprovar), roteada por `decisionVar` para as arestas do gateway a jusante;
  `decisionOptions` derivam dos literais do gateway (`lint.ts deriveDecisionRouting`).
  Valor fora da lista → **422 com a lista** (`userTasks.ts:336-339`, aprovação inócua barrada);
- **fencing D28** (`userTasks.ts:271-291`): `expectedInstanceRevision` tem que casar
  `task.revision`; se a instância avançou → **proposta expirada** (incidente
  `agentProposalExpired`, âmbar) — reavaliar, não executar sob world-delta velho. **A
  UI PRECISA enviar a revisão que o aprovador viu.**

**Reproposta** (`packages/db/src/agent/gate.ts:55-80`): explícita, nunca automática;
CAP = 3 (`REPROPOSAL_CAP`); estourou → parada honesta "reavaliação manual".

## 3. Paradas honestas que o gate pode mostrar (todas âmbar)
- **proposta expirada** (D28) — incidente `agentProposalExpired` (`userTasks.ts:280`).
- **tool staleness** — `checkToolFresh` (`gate.ts:145`): tool mudou/despublicada entre
  aprovar→executar → `stale` (o aval de boa-fé segue na trilha). *(Fora do ensaio AG-2.5,
  mas existe no backend.)*
- **budget / kill-switch** — paradas honestas do agentRunner (âmbar).
- **reprovar** — roteia pela aresta de reprovação, efeito NÃO executa (`agent-gate-e2e.test.ts:224`).

## 4. O que a UI RENDERIZA hoje (real)
- **`GateWaitingNote`** (`apps/console/src/routes/operate.tsx:355-381`) — **nota âmbar
  READ-ONLY** no Operate (montada só em instância `active`, `:274`). Texto: *"O agente
  propôs; o processo aguarda a aprovação humana… O controle canônico de aprovar/reprovar
  **entra na AG-3**."* Sem botão, sem formulário.
- **Nota de proposta expirada** (`operate.tsx:427-436`) — texto âmbar dentro do
  `IncidentsTab`: *"Aprovar indisponível… Reprovar segue disponível…"* — **prosa, sem
  botão** (as ações do incidente são só "Repetir"/"Resolver").
- Timeline unificada humano+agente já existe (`operate.tsx:661` `data-agent`), e as
  **vozes** do agente estão registradas (`voices.ts:18-46`: `aguardando-gate`,
  `agentProposalExpired`, `agent:decisao`, `agent:evidencia`, `agent:reproposta`…).

## 5. 🔴 O que o runtime/API NÃO produz (lacunas — pré-requisitos)

1. **O world-delta NÃO chega ao console.** O schema da API (`apps/console/src/api/
   generated/schema.d.ts`) **não tem** `worldDelta`/`effectSelo`/`processConsequence`/
   `selo`. O `GET /v1/user-tasks/{id}` devolve `isGate`, `decisionVar`, `decisionOptions`
   — mas **não** o conteúdo do gate. → **Pré-requisito de backend**: expor o world-delta
   (e o selo) na detalhe da tarefa de gate ANTES de a UI poder mostrá-lo. Sem isso, o
   controle de aprovar teria o quê para o humano decidir?
2. **Não existe controle de aprovar/reprovar** em lugar nenhum do console (nenhum POST a
   endpoint de gate/decisão; só notas read-only).
3. **Gate NÃO é modo da Tasklist** (`routes/tasks.tsx` não passa `includeGates`, não tem
   ramo `isGate`) — hoje o gate só aparece como nota **no Operate**, o oposto do intento P1.
4. **`POST /v1/agents/reproposta`** existe no schema (`{instanceId,elementId,motivo}` →
   `{reproposta,cap}`) mas **não está wired** em nenhuma UI.
5. **Zero teste** de renderização de gate (`GateWaitingNote`, nota expirada, `includeGates`).

## 6. Exemplos REAIS (dos testes — para a marcação ter dado concreto)
- Gate resolvido no despacho: `gate-tasklist.test.ts:68-81` (`byId = { gate: true, triagem: false }`).
- Fio world-delta→payload→selo: `packages/db/tests/gate-fio.test.ts` (5 casos).
- Aprovar sob selo + reprovar roteia sem executar: `packages/db/tests/agent-gate-e2e.test.ts:202,224,269`.
- Proposta expirada (D28) + reproposta capada: `packages/db/tests/gate-repropose.test.ts`.

---

## Perguntas que a MARCAÇÃO do designer decide (não decididas aqui)
1. **Modo da Tasklist**: como o gate se distingue de uma userTask comum na lista (rótulo,
   tom, ordem)? Entra na Tasklist (intento P1) ou fica no Operate como hoje?
2. **Apresentação do world-delta**: quais das ~6 dimensões da tool + a consequência do
   processo aparecem no card do aprovador, e em que hierarquia? Como se mostra o
   `processConsequence = null` (degrade honesto) sem parecer omissão?
3. **Aprovar × Reprovar × Repropor**: peso visual de cada ação; o irreversível "exige
   gate" (dourado + vermelho da identidade) vs o reversível.
4. **Paradas honestas em âmbar**: proposta expirada, tool stale, budget, kill-switch — voz
   e tratamento (a fundação AG-3.0 tem `GateSeal`/`EvidenceSeal`/`AutonomyDial` para reuso,
   sujeitos à ratificação do designer).

## Nota de sequência para o dev (depois da marcação)
O item 5.1 (expor o world-delta na API) é **pré-requisito de backend** — provavelmente uma
fatia própria antes (ou no começo) do código da UI do P1. Sinalizado como ESCOPO.
