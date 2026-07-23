# AG-2.2 etapa 5 — INVENTÁRIO DE ESTADOS (para a marcação de superfícies do designer)

Não é protótipo — é o que EXISTE no runtime hoje (`main` @ slice 2), com o kind/rótulo
real de cada estado, um payload de gate montado de verdade, uma linha de trilha com selo,
e **o que ainda NÃO existe** (para não desenhar sobre ar). Você marca as superfícies; eu
codo o slice 3. As quatro vozes de parada foram sua proposta — aqui está o vocabulário exato.

---

## 1. Estados que EXISTEM no runtime hoje

### 1a. Paradas do AgentRunner (etapa 2) — `AgentBlock` (retorno de `runAgentJob`)
Cada uma vem com `message` humana nomeando o nó/razão. Kind real = o valor de `blocked`:

| voz | `blocked` (real) | mensagem-exemplo (real) |
|---|---|---|
| **pausado — kill-switch** | `'kill-switch'` | `'classificar': kill-switch acionado EM EXECUÇÃO — parada honesta após 1 passo(s)` |
| **parada honesta — budget** | `'budget'` | `'classificar': parada honesta em 'llm-review' — budget: projeção estourou o teto` |
| sem inteligência configurada | `'no-config'` | `'classificar': tenant sem inteligência configurada (tenant_ai_config)` |
| agente não resolvido | `'no-graph'` | `'classificar': nenhum grafo de agente resolvido no registry (agnt-x@1.0.0)` |
| erro no walk | `'walk-error'` | `'classificar': walk não completou (deadlock)` |

### 1b. Trilha do agente (etapa 3/4) — `history_events`, kind `agent:*`
Um fato por linha, cadeia D1, **filtrável por `kind LIKE 'agent:%'`**. Kinds reais:
`agent:pinResolved` (ator `system`) · `agent:intencao` · `agent:acao` · `agent:io` ·
`agent:decisao` · `agent:evidencia` · `agent:parada` (todos com envelope de ator `{type,id,requestId}`).

### 1c. Incidentes de agente (etapas 3/4) — tabela `incidents`, coluna `kind`
Kinds reais: `agentUnpublished` (ref não publicada no registry) · `agentPinMissing`
(despacho de `CreateJob(agent)` sem pin operacional).

### 1d. Aguardando gate humano (etapa 5, slice 2) — **estado REAL, marcador PARCIAL**
- **Existe:** instância `status='active'` + uma linha `user_tasks` com `status='open'`
  cujo `element_id` é um nó `btv:gate`. Provado pelo `agent-cycle-e2e` (o agente propõe,
  o `JobCompleted` roteia ao gate, a instância aguarda).
- **Identificação hoje:** pelo `properties.btvGate === true` do NÓ no diagrama da definição
  (não há coluna/marcador em `user_tasks` ainda — ver §5).

---

## 2. Prontos no runtime, mas NÃO persistidos como estado (isto é o slice 3 a fiar)

Funções existem e são testadas (`gate-runtime.test.ts`), mas ainda **não emitem** um
estado/incidente consultável nem populam superfície:

| voz | função pronta (slice 2) | falta (slice 3) |
|---|---|---|
| **proposta expirada** (D28) | `verifyProposalFresh(state, revisão)` → `{fresh:false}` | emitir estado/incidente consultável (kind proposto `agentProposalExpired`) |
| **tool alterada — staleness** | `checkToolFresh(tx, ref)` → `{fresh:false}` | idem (kind proposto `agentToolStale`) |
| world-delta no payload do gate | `buildWorldDelta(...)` | popular `user_tasks.payload` ao ABRIR o gate |
| selo do efeito | `effectSelo(...)` | gravar na linha de trilha do efeito ao EXECUTAR |
| cap de reproposta | `requestReproposal(...)` (ação explícita + cap) | expor a ação explícita + a contagem na superfície |

Os **kinds** propostos (`agentProposalExpired`, `agentToolStale`) e o **marcador de gate**
em `user_tasks` são exatamente o que sua marcação pode fixar — eu adoto o vocabulário que
você definir.

---

## 3. Exemplo REAL de payload de gate montado (`buildWorldDelta`)

Schema congelado no seu P1. As duas primeiras dimensões vêm do `ToolContract` resolvido 1×;
a terceira (`processConsequence`) é derivada do BPMN a jusante ou anotada.

### 3a. Com consequência DERIVADA (timer a jusante → prazo)
```json
{
  "tool": "tool:send-email@2.0.1",
  "capability": "enviar e-mail ao cliente",
  "effect": "external-commitment",
  "authorization": "gate",
  "dataScope": "3 destinatários",
  "evidenceRequired": "cópia enviada",
  "params": { "to": ["compras@metalsul.com", "vendas@fortaco.com.br", "cotacao@inducamp.com"] },
  "processConsequence": { "source": "derived", "kind": "timer", "description": "abre um prazo (P5D)" }
}
```

### 3b. Com consequência ANOTADA pelo modelador (frase humana)
```json
{
  "...": "(idem acima)",
  "processConsequence": { "source": "annotated", "kind": "annotation", "description": "abre prazo de 5 dias úteis e a instância aguarda respostas" }
}
```

### 3c. DEGRADE HONESTO — sem regra estrutural nem anotação → `null`
Regra do seu P1: nunca inferir consequência que possa estar errada (mostrar menos > prometer errado).
```json
{
  "...": "(idem 3a, menos a última linha)",
  "processConsequence": null
}
```
Na superfície, `null` = mostrar só as consequências da tool (as duas primeiras linhas), sem a 3ª.

---

## 4. Exemplo REAL de linha de trilha com o SELO do efeito (`effectSelo`)

Quando o efeito irreversível roda SOB aprovação, a linha do efeito carrega o selo de
procedência (D31) — prova de que rodou sob aval humano; procedência, não conteúdo:
```json
{
  "gateId": "gate",
  "tool": "tool:send-email@2.0.1",
  "effectClass": "external-commitment",
  "actor": { "type": "user", "id": "aprovador@acme", "requestId": "req-1" },
  "approvedAt": "2026-07-24T10:00:00Z"
}
```

---

## 5. O que NÃO existe (para não desenhar sobre ar)

- **Nenhuma superfície do Operate** para as vozes — nem P2 nem drill-down renderizam
  gate/expirada/stale hoje. É o que sua marcação vai desenhar.
- **Sem marcador consultável de "gate" em `user_tasks`** — hoje o gate se identifica pelo
  `btvGate` do nó no diagrama. Se a Tasklist/Operate precisar filtrar gate por SQL direto,
  isso é um campo a fixar (kind/coluna) no slice 3.
- **`agentProposalExpired` e `agentToolStale` não são emitidos** — as funções decidem, mas
  ninguém grava o estado ainda.
- **World-delta não está no `payload` do gate** nem o **selo na trilha do efeito** — as
  funções montam; o fio (despacho/execução) é slice 3.
- **Nenhuma ação de reproposta exposta** — `requestReproposal` existe; o botão/ação
  explícita e a contagem visível são superfície a marcar.
- **Sem rota de reprovação renderizada** — o lint exige a rota; o Operate mostrando "seguiu
  pela rota de reprovação" é superfície.

---

## Aceite do slice 3 (o teste que fecha a etapa 5)
Estender o `agent-cycle-e2e` até o fim: agente propõe → gate abre **com world-delta
populado** → humano aprova (**com `expectedInstanceRevision`**) → efeito executa **carregando
o selo** → instância completa. Negativos: reprovar roteia pela rota definida **sem** executar
o efeito; tool alterada entre aprovar e executar → **4ª voz** (`agentToolStale`), com o gate
aprovado ainda visível na trilha. Hoje o e2e para no gate; é ali que continua.
