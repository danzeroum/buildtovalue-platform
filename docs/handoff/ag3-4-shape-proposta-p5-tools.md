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

## 1 · ACHADO que muda o escopo: `tenant_tools.enabled` não é lido em NENHUM lugar hoje

Busquei `tenant_tools` em todo `packages/db/src` e `apps/api/src` — **zero ocorrências fora
da própria migração e do teste de isolamento RLS**. Ou seja: mesmo que a tela ligasse/
desligasse uma tool hoje, **nada no runtime consultaria esse estado** — nem o gate
(`gateFio.ts`), nem o dispatcher, nem o lint de deploy do processo. O toggle seria **decoração
sem efeito**, o oposto de "controle real" — a mesma classe de achado da AG-3.3 (uma coluna que
existe mas ninguém lê).

**Isso significa que o shape de P5 tem DUAS peças, não uma:**
- **(a) Superfície administrativa** — rotas de listar/ligar/desligar (o que o dono pediu).
- **(b) Enforcement** — ALGUÉM no caminho de execução precisa recusar um efeito de uma tool
  `enabled:false` para o tenant. Candidatos ao ponto de checagem: no lint de DEPLOY do
  processo (recusa publicar um processo que referencia uma tool desabilitada) e/ou no
  `gateFio.ts` no momento de executar o efeito (mesmo lugar do `checkToolFresh`, mesma
  família de checagem "ainda vale?").

**Decisão que preciso do dono**: (b) entra nesta fatia (P5 fecha com dentes de verdade) ou é
nomeado como pendência separada e P5 nesta fatia é só a superfície (com o risco explícito de
"toggle sem efeito" registrado, não escondido)? Minha recomendação: **(b) entra**, porque uma
tela de "desligar tool" que não desliga nada é pior que não ter a tela — é a mesma lição do
kill-switch (achei e corrigi o mesmo tipo de buraco na correção de dados da AG-3.3).

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

## 4 · Decisões que o gate fecha (a confirmar)

1. **§1 — enforcement entra nesta fatia ou fica nomeado à parte?** (recomendação: entra).
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
`GET /v1/tools` (join `tool_definitions` × `tenant_tools`) → `PATCH /v1/tools/:toolId` →
enforcement (se a decisão 1 entrar: checagem em `gateFio.ts` e/ou no lint de deploy) → GRANTS +
espelho `capabilities.ts` → testes: catálogo com `enabled:false` honesto sem linha em
`tenant_tools`; 422 ao tentar editar `effect`/`authorization`; 422 ao ligar tool `proibida`;
motivo obrigatório nas duas direções; (se entrar) efeito de tool desabilitada recusado no
runtime, não só na tela.
