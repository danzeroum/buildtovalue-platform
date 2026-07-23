# AG-2.2 etapa 5 — INVENTÁRIO DE SUPERFÍCIES (backend fechado → revisão G-UX-3)

Não é protótipo. É o que o **backend do slice 3 agora EMITE de verdade** (`main` após itens
1–3, PR #32/#33/#34), com o kind/coluna real de cada estado, exemplos reais de payload e de
trilha extraídos dos testes, e **o que ainda NÃO existe** (as superfícies — é o que você marca
antes de eu escrever UI). O vocabulário (`agentToolStale`, `agentProposalExpired`, marcador de
gate) é o que você fixou na marcação; adotei-o literalmente.

---

## 1. O que o runtime AGORA emite (era "pronto mas não fiado" no inventário anterior)

| voz (marcação) | como CONSULTAR agora (real) | família |
|---|---|---|
| **gate — aguardando aval** | `user_tasks.is_gate = true` (coluna, migração 0013) + instância `active` | âmbar |
| **world-delta do gate** | `user_tasks.payload` = o world-delta (populado no `OpenUserTask`) | — |
| **efeito sob selo** | `history_events` `kind='agent:acao'`, `effect_key='host:gate-effect:<inst>:<gate>'`, `payload.selo` | verde/dourado |
| **tool alterada — staleness** | `incidents` `kind='agentToolStale'` (`payload.toolRef`,`gateId`) | vermelho (incidente) |
| **proposta expirada (D28)** | resposta **409** da conclusão do gate (`reason:'proposalExpired'`) — ver §5 | âmbar |
| **gate aprovado** | `history_events` `kind='taskDecision'` (`payload.decision`,`elementId`) + `instance_gate_state.approved_at/approved_actor` | — |

Marcador de gate na Tasklist: **a fila comum EXCLUI `is_gate`** por padrão (o modo-agente da
fila é AG-3); `includeGates=true` traz o gate ao Operate. Provado em `gate-tasklist.test.ts`.

### 1a. Já existiam (etapas 2–4, sem mudança)
Paradas do AgentRunner (`blocked`): `kill-switch` · `budget` (âmbar, parada honesta, RETOMÁVEL —
ver §1c) · `no-config` · `no-graph` · `walk-error` (vermelho, incidente). Trilha `agent:*`:
`agent:pinResolved`(system) · `intencao` · `acao` · `io` · `decisao` · `evidencia` · `parada` ·
**`agent:retomado`** (novo, §1c). Incidentes: `agentUnpublished` · `agentPinMissing`.

### 1b. Selo do efeito — a linha `agent:acao` (marcação §4)
É onde o selo entra quando a `agent:acao` é o efeito sob gate. Exemplo REAL (do e2e feliz):
```json
{
  "elementId": "gate",
  "message": "efeito sob gate: tool:send-email@2.0.1",
  "actor": { "type": "user", "id": "aprovador", "requestId": "req-aprova" },
  "selo": {
    "gateId": "gate",
    "tool": "tool:send-email@2.0.1",
    "effectClass": "external-commitment",
    "actor": { "type": "user", "id": "aprovador", "requestId": "req-aprova" },
    "approvedAt": "2026-07-24T10:00:00.000Z"
  }
}
```

### 1c. Retomada da parada honesta (§5.2, PR #31)
`budget`/`kill-switch` ESTACIONAM o job (`jobs.status='paused'`, `pause_kind`), SEM incidente.
Retomam → `jobs.status='available'` + fato `agent:retomado` (`payload.actor`,`motivo`,`pauseKind`)
+ auditoria `agent.jobs.resumed`. **kill-switch** retoma sozinho ao reativar; **budget** é ação
explícita do operador (`POST /v1/agents/resume`). Isto é uma AÇÃO na nota de estado âmbar.

---

## 2. Payload REAL do gate (`user_tasks.payload`, populado no gate-open)

Do e2e (tool + params PROPOSTOS pelo agente + consequência):
```json
{
  "tool": "tool:send-email@2.0.1",
  "capability": "enviar e-mail ao cliente",
  "effect": "external-commitment",
  "authorization": "gate",
  "dataScope": "3 destinatários",
  "evidenceRequired": "cópia enviada",
  "params": { "to": ["a@x", "b@y", "c@z"] },
  "processConsequence": { "source": "derived", "kind": "timer", "description": "abre um prazo (P5D)" }
}
```
**DEGRADE honesto** (sem timer/userTask/end a jusante nem anotação): `"processConsequence": null`
→ a superfície mostra **só as duas dimensões da tool** (a 3ª linha NÃO é inventada). Provado em
`gate-fio.test.ts`.

---

## 3. Incidente REAL de staleness (`incidents`, `kind='agentToolStale'`)

Tool alterada/removida ENTRE aprovar e executar:
```json
{
  "kind": "agentToolStale",
  "message": "efeito não executado — a tool tool:stale-email@2.0.1 mudou/foi desabilitada desde a aprovação",
  "payload": { "toolRef": "tool:stale-email@2.0.1", "gateId": "gate", "actor": { "type": "user", "id": "aprovador" }, "approvedAt": "…" }
}
```
O efeito **não executa**; o **gate aprovado** (`taskDecision`) permanece visível na trilha (o
humano aprovou de boa-fé; a falha é posterior). Vermelho/incidente — distinto das paradas âmbar.

---

## 4. As cinco vozes × onde consultar (mapa para a marcação)

| voz (§1/§2 da marcação) | kind/coluna real | família | superfície-alvo |
|---|---|---|---|
| orçamento esgotado | `jobs.pause_kind='budget'` + `agent:parada` | âmbar | nota de estado + ação "retomar" |
| kill-switch | `jobs.pause_kind='kill-switch'` + `agent:parada` | âmbar | nota de estado (retoma ao reativar) |
| proposta expirada | 409 `proposalExpired` na conclusão | âmbar | ao aprovar; **reavaliar** é ação explícita |
| tool stale | `incidents.kind='agentToolStale'` | vermelho | card de incidente |
| aguardando gate | `user_tasks.is_gate=true` | âmbar | nota "aguardando gate humano" + link |

---

## 5. O que NÃO existe (para não desenhar sobre ar)

- **Nenhuma superfície do Operate/Tasklist** renderiza nada disto — nem o world-delta no gate,
  nem o selo na linha `agent:acao`, nem os cards `agentToolStale`, nem a nota âmbar com ação de
  retomar/reavaliar. **Tudo isto é o que sua marcação vai desenhar (G-UX-3).**
- **[ESCOPO 1] `agentProposalExpired` NÃO é estado persistido — hoje só 409.** A conclusão do
  gate com `expectedInstanceRevision` divergente responde **409 `proposalExpired`**; a instância
  NÃO avança e **nenhuma linha é gravada**. Você marcou "proposta expirada" como **estado com voz
  + ação ("reavaliar")** → para a UI pintar, precisa ser consultável, não só o erro no ato.
  **Custo: SEM migração** — emitir `incidents.kind='agentProposalExpired'` (âmbar) no ramo
  `proposalExpired` do `completeUserTask` (a tabela `incidents` e a coluna `payload` já existem);
  o Operate lê o incidente. Fio pequeno (~1 ponto). **Provavelmente entra na etapa 5.**
- **[ESCOPO 2] Reproposta sem rota exposta.** A Q4 fechou em "ação explícita + cap duro"; sem
  rota, a **ação explícita não existe** (só a função `requestReproposal`, testada em
  `gate-runtime.test.ts`). **Custo: SEM migração** (`instance_gate_state.reproposal_count` já
  existe) — uma **ROTA NOVA** `POST /v1/agents/reproposta` (`operate:act`) que chama
  `requestReproposal` (respeita o cap → estourou = parada honesta "reavaliação manual"), grava
  fato na trilha e consome budget novo. Fio: rota + método no facade + fato. **Provavelmente
  entra junto.** Decisão final (etapa 5 × AG-3) é sua com o designer.
- **Rota de reprovação**: o backend roteia pela aresta definida e a instância segue (provado),
  mas "seguiu pela rota de reprovação" não é renderizado em lugar nenhum.
- **`expectedInstanceRevision`** é aceito na rota de conclusão, mas nada na UI lê a revisão do
  gate para enviá-la — o controle canônico aprovar/reprovar com o world-delta ao lado + a revisão
  fencing é P1/AG-3.
- **`params` do world-delta**: hoje vêm de uma variável declarada no nó do gate (`proposalVar`).
  Se o agente não a produzir, `params={}` (o gate ainda abre com as dimensões da tool). A forma
  como o agente PROPÕE params estruturados é do lote de agentes (fora da v1 desta etapa).

---

## Aceite (fechado)
`agent-gate-e2e` prova, pelas portas reais: FELIZ (propõe → gate com world-delta → aprova com
`expectedInstanceRevision` → efeito com selo → completa) + reprovar (roteia sem executar) +
staleness (`agentToolStale`, efeito não executa, gate aprovado na trilha). Suíte db verde (121).
**Próximo passo é seu:** marcar as superfícies (âmbar vs vermelho, selo completo na `agent:acao`,
degrade de `processConsequence:null`, ação de retomar/reavaliar) antes de qualquer código de UI.
