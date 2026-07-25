# AG-3.4 — Proposta de shape (dev → triagem do dono) · P5 (catálogo de tools por tenant)

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Nenhuma rota
> codada antes do ok. Par de: `docs/handoff/ADENDO-04-administracao.md` (P5/A3 aprovados como
> v1), protótipo A3 já existente (`Prototipos Administracao.dc.html`). Corre em PARALELO à A7
> (execução direta, sem gate) — ordem confirmada pelo dono.
>
> Requisito do dono para esta proposta: **efeito e autorização vêm do `ToolContract` (código),
> NUNCA editáveis pela tela — o operador só liga/desliga (`enabled`)**. Mudar autorização é
> F4. Isso protege D31: se desse para rebaixar autorização pela tela, o gate humano deixaria
> de ser garantido.

## 0 · O que já existe (confirmado por investigação, nada presumido)

- **Schema pronto desde a `0006`**: `tenant_tools (id, tenant_id, tool, enabled, requires_gate, scope jsonb, updated_at)`, `UNIQUE(tenant_id, tool)`. **Zero função de acesso, zero rota HTTP** — mesmo estado que `tenant_ai_config` tinha antes da AG-3.2.
- **`tool_definitions`** (migração `0009`, catálogo IMUTÁVEL — só `SELECT+INSERT`, sem `UPDATE`/`DELETE`): cada versão publicada de uma tool carrega `effect` (`ToolEffect`) e `authz`/`authorization` (`ToolAuthorization`: `automatica|gate|proibida`) como **campos próprios do contrato**, nunca inferidos. O deploy já recusa (`validateToolContract`, `TOOL_EFFECT_AUTOMATICA_GATED`) um efeito que exige gate (`write-irreversible`/`external-commitment`) declarado como `automatica` — **este é "o lint que já existe"** que o dono citou.
- **Runtime já verifica staleness** (`checkToolFresh`, `gate.ts`) — se a tool ainda existe no registry no momento de executar um efeito sob gate. Não verifica `tenant_tools.enabled` (achado da §1 abaixo).

## 1 · ACHADO + DECISÃO DO DONO: `tenant_tools.enabled` não é lido em NENHUM lugar hoje — o enforcement ENTRA nesta fatia, em DOIS pontos

Busquei `tenant_tools` em todo `packages/db/src` e `apps/api/src` — **zero ocorrências fora
da própria migração e do teste de isolamento RLS**. Mesmo que a tela ligasse/desligasse uma
tool hoje, **nada no runtime consultaria esse estado**. O toggle seria decoração sem efeito —
a mesma classe de achado da correção de dados da AG-3.3 (uma coluna que existe mas ninguém lê).

**Decisão do dono: o enforcement (b) ENTRA nesta fatia — tela sem dentes não entra.** Desabilitar
uma tool é decisão de segurança do tenant (integração comprometida, tool que vazou); um toggle
decorativo mentiria sobre ter controle, o que é pior que não ter a tela.

### 1.1 · Os DOIS pontos (complementares, não um OU outro)

**(1) LINT DE DEPLOY — preventivo.** Publicar um processo que referencia (`toolRef`) uma tool
`enabled:false` para o tenant é **recusado no deploy**, mensagem clara. Mesmo lugar onde o
efeito já é resolvido hoje contra o registry — `packages/db/src/registry/store.ts:106-118`
(`deployProcessDefinition`), o laço que já chama `toolEffectOfTx(tx, toolRef)` por elemento
com `toolRef` e empurra `issues` que `lintBlocks` (linha 120) já bloqueia. A checagem nova
entra no MESMO laço:
```ts
const effect = await toolEffectOfTx(tx, toolRef);
if (effect && effectRequiresGate(effect)) gatedElementIds.push(node.id);
// NOVO:
const toolId = parseRef(toolRef).id;                 // tool_id sem versão (decisão 2, §4)
if (!(await isToolEnabledForTenantTx(tx, tenantId, toolId))) {
  issues.push({
    code: 'EXEC_TOOL_DISABLED', severity: 'error', elementId: node.id,
    message: `tool '${toolId}' não está habilitada para este tenant — habilite em Administração › Ferramentas antes de publicar`,
  });
}
```

**(2) RUNTIME em `gateFio.ts` — definitivo, pega o que o deploy não pega.** Um processo pode
já estar PUBLICADO e RODANDO quando a tool é desabilitada depois — só o runtime intercepta
esse caso. `sealGatedEffectTx` (`packages/db/src/agent/gateFio.ts:145-167`) já verifica
`checkToolFresh` no MOMENTO de executar o efeito (não no deploy, não na aprovação) — é o
checkpoint certo, e cobre "desabilitada NO MEIO de uma instância em voo" de graça: o próximo
`executeGatedEffectTx` daquele gate roda essa verificação de novo, então uma tool desabilitada
depois do aval humano recusa no próximo passo, sem precisar cancelar lease de job em separado
(diferente do buraco do kill-switch, que precisou de um fix à parte porque só bloqueava LOCKS
novos — aqui a checagem já mora no ponto de EXECUÇÃO, não no de lock).
```ts
export type SealOutcome =
  | { executed: true; selo: EffectSelo }
  | { executed: false; reason: 'tool-stale' }
  | { executed: false; reason: 'tool-disabled' };   // NOVO

// dentro de sealGatedEffectTx, depois do checkToolFresh:
const toolId = parseRef(args.toolRef).id;
const enabled = await isToolEnabledForTenantTx(tx, args.tenantId, toolId);
if (!enabled) {
  await tx`INSERT INTO incidents (tenant_id, instance_id, kind, message, effect_key, payload)
    VALUES (${args.tenantId}, ${args.instanceId}, 'agentToolDisabled',
            ${`efeito não executado — a tool ${args.toolRef} foi desabilitada para este tenant`},
            ${`host:gate-disabled:${args.instanceId}:${args.gateElementId}`},
            ${tx.json({ toolRef: args.toolRef, gateId: args.gateElementId, actor: args.actor, approvedAt: args.approvedAt } as never)})
    ON CONFLICT (effect_key) DO NOTHING`;
  return { executed: false, reason: 'tool-disabled' };
}
```
**Por que `kind: 'agentToolDisabled'` PRÓPRIO, não reaproveitar `agentToolStale`:** o dono
pediu parada honesta (âmbar), não erro opaco — `agentToolStale` hoje é vermelho (mudança
inesperada do registry). Desabilitar é ação DELIBERADA do tenant, não uma surpresa; a mesma
distinção que o produto já faz para `agentProposalExpired` (também um `incidents.kind`, e
também âmbar — a prova de que "estar na tabela `incidents`" não obriga vermelho). Um par de
linhas em `apps/console/src/voices.ts`:
```ts
agentToolDisabled: { label: 'Parada honesta — tool desabilitada para o tenant', family: 'amber', icon: '⏸' },
```
Continua **retryable pelo mecanismo de incidente já existente** (`/v1/incidents/:id/retry`) —
quando o tenant reabilita a tool, repetir o efeito passa na checagem. *(Nota: o retry de
`agentToolStale` hoje não tem um teste e2e provando reavaliação completa — o mesmo gap, se
existir, é herdado aqui igualmente; não é uma lacuna NOVA desta fatia.)*

### 1.2 · D31 continua ortogonal (as duas checagens NÃO se confundem)

- `enabled` (`tenant_tools`) responde **"a tool está disponível para este tenant?"** —
  liga/desliga tudo, sem gradação.
- `effect`/`authorization` (`tool_definitions`, imutável) respondem **"o que ela pode fazer
  sem gate?"** — não muda com o toggle.

Uma tool `enabled:true` continua respeitando seu `authorization` (`gate` continua exigindo
gate humano; `proibida` nunca liga, ponto — §2.2 abaixo). Uma tool `enabled:false` não roda,
independente do que seu `authorization` diga. Os dois eixos nunca se substituem.

### 1.3 · Aceite nomeado (verbatim do dono)

- Deploy que referencia uma tool desabilitada para o tenant → **recusado** (lint, `EXEC_TOOL_DISABLED`).
- Tool desabilitada **NO MEIO** de uma instância em voo → o **próximo efeito dela para
  honestamente** (`agentToolDisabled`, âmbar, nunca vermelho, nunca silencioso).

## 2 · Rotas propostas

### 2.1 · Listar o catálogo do tenant — leitura
```
GET /v1/tools                                                     → 200
{ "items": [
    { "toolId": "send_email", "ref": "tool:send-email@2.0.1",     // última versão publicada
      "name": "…", "capability": "…", "effect": "external-commitment",
      "authorization": "gate",       // SEMPRE lido de tool_definitions — nunca de tenant_tools
      "dataScope": "…",
      "enabled": false,               // de tenant_tools; SEM linha ainda = false (honesto, não erro)
      "requiresGate": true            // COMPUTADO de effect+authorization — nunca armazenado/editável
    }
  ] }
```
- **RBAC `tools:read`** (proposta: admin + auditor — mesma régua de `ai:read-config`; tools
  habilitadas são evidência de superfície de risco do tenant, o auditor precisa ver).
- `requiresGate` **nunca vem de `tenant_tools.requires_gate`** — a coluna existe desde a
  `0006` mas fica **ignorada/vestigial** nesta proposta (ver §4, decisão que preciso do dono).
  A garantia real vem sempre do contrato publicado, ao vivo.

### 2.2 · Ligar/desligar uma tool — escrita, motivo obrigatório, auditado
```
PATCH /v1/tools/:toolId          body: { "enabled": true|false, "reason": "…" }   → 200 (shape do item de 2.1)
```
- **RBAC `tools:configure`** (proposta: admin apenas — mesma régua de `ai:configure`).
- **Único campo editável é `enabled`.** Enviar `effect`/`authorization`/`requiresGate` no
  corpo → **422 explícito** ("esses campos vêm do contrato, não são editáveis aqui") — a
  mesma disciplina do "nunca aceitar e descartar" que a etapa 6 (decisionVar) já estabeleceu.
- **`enabled:true` numa tool com `authorization:'proibida'` → 422 recusado.** Uma tool
  categoricamente proibida não liga para tenant nenhum — não é decisão de tenant, é
  invariante da plataforma.
- `reason` obrigatório nas duas direções (ligar E desligar) — mesmo padrão do kill-switch;
  auditado (`tools.toggled` ou nome equivalente, a definir no código).

## 3 · RBAC — o [GATE]

Escopos novos: `tools:read`, `tools:configure`.

| Papel | `tools:read` | `tools:configure` |
|---|---|---|
| admin | ✅ | ✅ |
| auditor | ✅ (evidência) | — |
| operator/analyst/business | — | — |

Diferente do kill-switch: **não há leitura ampla** proposta aqui — não existe um "banner" que
toda a Operação precise ver (habilitar/desabilitar tool é decisão administrativa, não uma
emergência que afeta o trabalho corrente de quem opera). *Confirmar se este corte está certo,
ou se operador/analyst também deveriam LER (não configurar) o catálogo.*

## 4 · Decisões que o gate fecha

1. ~~§1 — enforcement entra nesta fatia ou fica nomeado à parte?~~ → **FECHADA: entra, nos
   dois pontos (lint de deploy + runtime em `sealGatedEffectTx`)** — decisão do dono.
2. **`tenant_tools.tool` é `tool_id` (bare, ex. `send_email`) ou `ref` versionado
   (`send_email@2.0.1`)?** Proposta-default: **`tool_id`** — habilitar é por tool, não por
   versão (uma tool nova versão não deveria exigir re-habilitar; `CLAUDE.md` chama P5 de
   "catálogo mínimo", que soa a nível tool_id). *Confirmar.*
3. **`tenant_tools.requires_gate` (coluna existente desde a `0006`) fica vestigial (ignorada,
   nunca lida/escrita pela rota nova) ou uma migração a remove?** Proposta-default: ignorar
   por ora (remover é limpeza, não urgência) — mas registrar em pendências para não
   confundir alguém lendo o schema no futuro. *Confirmar.*
4. **RBAC de leitura do catálogo** (§3) — só admin+auditor, ou operator/analyst também leem
   (sem configurar)? *Confirmar.*
5. **`scope` (jsonb, coluna existente)** — este shape não o expõe nem o edita (fora de
   escopo desta fatia, mesmo já existindo na tabela). *Confirmar que fica de fora da v1.*

## 5 · Fora deste shape

UI da tela (A3, já prototipada em `Prototipos Administracao.dc.html`) = marcação do designer
depois da triagem destas rotas — mesmo rito do P4/kill-switch e do A7. Trago o inventário A3
depois deste gate fechar (ele precisa dos nomes reais das rotas para os campos, como os
anteriores).

## 6 · Ordem de código (quando o gate abrir)

Sem migração nova SALVO se a decisão 3 (§4) pedir remover `requires_gate` — nesse caso
migração leve (`ALTER TABLE ... DROP COLUMN`), própria, com `[GATE+MIGRAÇÃO]` no título.

1. `isToolEnabledForTenantTx` (novo, ao lado de `toolEffectOfTx` em `registry/toolStore.ts`).
2. **Enforcement (1) — lint de deploy**: `EXEC_TOOL_DISABLED` no laço de `deployProcessDefinition` (`registry/store.ts:106-118`).
3. **Enforcement (2) — runtime**: `sealGatedEffectTx` ganha o novo ramo `tool-disabled` +
   `kind:'agentToolDisabled'` (âmbar) em `gateFio.ts`; `apps/console/src/voices.ts` ganha a
   linha do rótulo.
4. `GET /v1/tools` (join `tool_definitions` × `tenant_tools`) → `PATCH /v1/tools/:toolId`.
5. GRANTS (`tools:read`/`tools:configure`) + espelho `capabilities.ts` + teste de paridade
   (mesmo padrão do `auditor`, PR #62 — todo papel novo é pego automaticamente).
6. Testes: deploy recusado por `EXEC_TOOL_DISABLED`; catálogo com `enabled:false` honesto sem
   linha em `tenant_tools`; 422 ao tentar editar `effect`/`authorization`; 422 ao ligar tool
   `proibida`; motivo obrigatório nas duas direções; **efeito de tool desabilitada DEPOIS do
   aval humano recusa no runtime** (`agentToolDisabled`, âmbar, sem efeito, gate aprovado
   permanece na trilha — mesmo padrão do teste de staleness já existente).
