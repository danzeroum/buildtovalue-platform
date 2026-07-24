# AG-3.2 — Inventário do banner de kill-switch · para MARCAÇÃO do designer

> Rito: **inventário (dev) → MARCAÇÃO (designer) → código (dev)**. Este doc é só o
> inventário — dado REAL (das rotas mergeadas em #55/#56), exemplo REAL (dos testes), e
> **o que o console NÃO renderiza ainda** (não existe UI nenhuma para isto hoje — zero
> componente, zero chamada de cliente). Sem marcação e sem código.
>
> **Escopo:** só o **banner** (o item que vive fora da Admin, na Operação inteira). A
> tela de config/A2 (kill-switch como ação, dentro da Admin) **já está marcada** em
> `ag3-marcacao-administracao.md` §1 — não repito aqui. O que mudou desde aquele
> documento: a leitura do kill-switch virou **dois níveis** (fato amplo × razão
> reservada ao admin), decisão fechada nesta sessão — o §1 daquele doc ainda fala em
> "quem + quando + **motivo**" num único nível; **superado** pelo contrato real das
> rotas abaixo. Sinalizo a divergência para você decidir se atualiza aquele parágrafo.

## 1 · O que a API PRODUZ hoje (rotas mergeadas, #55 + #56)

**Nível 1 — FATO, amplo** (`GET /v1/ai/kill-switch`, `apps/api/src/routes/ai.ts:47-59`).
Escopo `ai:read-state` — concedido a `admin·analyst·business·operator·auditor`
(`packages/auth/src/rbac.ts:30-49`, todo papel que atua na Operação). Shape real:

```jsonc
// ativo (nenhum banner deveria aparecer)
{ "state": "active", "by": null, "since": null }

// pausado
{ "state": "paused", "by": { "type": "user", "id": "admin" }, "since": "2026-07-24T21:43:00Z" }
```

**Nunca carrega razão** — a função que resolve isto (`getKillSwitchState`,
`packages/db/src/agent/tenantAiConfig.ts:114-131`) **nem seleciona** a coluna
`kill_switch_reason` no SQL. Não é omissão na resposta; é ausência na fonte.

**Nível 2 — razão, reservada** (`GET /v1/ai/config`, `ai.ts:97-119`). Escopo
`ai:read-config` — só `admin`+`auditor`. Mesma forma do fato + `killSwitch.reason`
(pode conter contexto de incidente: *"suspeita de vazamento no fornecedor X"* é o
exemplo real do teste `kill-switch.test.ts:97-118`). **Fora do escopo deste banner** —
cito só para o contraste: o banner amplo NUNCA tem acesso a este campo.

## 2 · Onde o banner PRECISA viver (o shell, não uma rota)

`AppShell` (`apps/console/src/shell.tsx:32-84`) é o **único** chrome persistente —
todo `NavLink` (Tarefas/Formulários/Operação/Estúdio) renderiza dentro do mesmo
`<main className="shell-main"><Outlet/></main>` (`shell.tsx:70-71`). É o único lugar
que garante "aparece em toda a Operação, não só numa rota" — a marcação já fixou isso
(`ag3-marcacao-administracao.md` §1.1) e o inventário confirma: **hoje não existe
nada ali além do header de navegação + usuário**. Nenhum componente de banner, nenhum
`useEffect`/chamada a `GET /v1/ai/kill-switch` em lugar nenhum do console.

## 3 · Vocabulário visual já disponível (fundação AG-3.0) — e o que falta nele

`packages/shared-ui/src/selo.tsx`:
- **`GateSeal`** (`:96-107`) — hoje só tem `'aguardando' | 'expirado'`. É por-GATE
  (uma decisão individual), sempre âmbar, nunca vermelho (assinatura F-AG). **Não tem
  estado de kill-switch** — é conceitualmente outra coisa (um gate específico vs. TODO
  o tenant pausado). Decisão para a marcação: um estado novo aqui, ou componente
  PRÓPRIO (`KillSwitchBanner`)?
- **`AutonomyDial`** (`:116-129`) — dial 0-5, tom `gate` (dourado) quando
  `requiresGate`, `agent` (violeta) senão. Não se aplica ao banner (é por-agente, não
  por-tenant).
- **`EvidenceSeal`** (`:78-91`) — estados `auditado`/`mascarado`/`ancorável`. O
  parônimo mais próximo seria um estado `pausado`, mas o contrato de `EvidenceSeal` é
  sobre EVIDÊNCIA de um dado, não sobre um interruptor operacional — provavelmente
  não é o encaixe certo.
- **Tons disponíveis nos tokens** (`packages/shared-ui/src/tokens.css`):
  `--ui-role-warning-*` (âmbar — é a família que a assinatura F-AG usa pra parada
  honesta: "parada honesta em âmbar, nunca vermelho"), `--ui-role-gate-*` (dourado),
  `--ui-role-danger-*` (vermelho — reservado a irreversível/proibida, **não** para
  isto). O honest-stop já estabelecido (`packages/db/tests/honest-stop.test.ts`,
  `AgentRunner.isHonestStop`) trata budget/kill-switch como pausas **esperadas e
  retomáveis** — a mesma voz "âmbar, não vermelho" deveria valer aqui.

## 4 · O que o backend GARANTE agora (contexto novo — fecha #56)

Até agora (`#56`, hoje): acionar o kill-switch com um job de agente **já em
execução** cancelava o lease no PRÓXIMO passo que o worker checasse (podia demorar o
tempo de uma chamada de LLM em voo). Isso mudou — `setKillSwitch` agora cancela o
lease de agent jobs `locked` **na mesma transação** do acionamento
(`packages/db/src/agent/tenantAiConfig.ts:183-197`, teste
`kill-switch.test.ts:133-172`). **Efeito para o design:** quando o banner aparecer
"pausado", já é verdade — não há uma janela em que o servidor diz "pausado" mas
agentes ainda estão de fato rodando.

## 5 · O que NÃO existe (gaps — tudo por construir)

1. Zero componente de banner no console.
2. Zero chamada de cliente a `GET /v1/ai/kill-switch` (nem polling, nem fetch único).
3. `capabilities.ts` já espelha `ai:read-state` (`apps/console/src/capabilities.ts`,
   mergeado em #55) mas nada o consome ainda — é código morto até esta peça.
4. Nenhuma voz textual definida para os dois estados (ativo = ausência? pausado = qual
   frase exata?).
5. Nenhuma decisão de OFFLINE/erro: se `GET /v1/ai/kill-switch` falhar (rede,
   sessão), o banner deveria degradar como quê — silêncio, ou um estado de "não sei"?

## 6 · Exemplos reais (dos testes — para a marcação ter dado concreto)

- Fato após acionar: `apps/api/tests/ai.e2e.test.ts:84-104` (`admin ACIONA com
  motivo → 200; o FATO na rota ampla NÃO carrega a razão`) — `{ state: 'paused', by:
  { type: 'user', id: 'admin' } }`, `since` truthy, `'reason' in body === false`.
- Leitura ampla × escrita estreita: `ai.e2e.test.ts:106-119` — operator lê o fato
  (200) mas 403 em acionar/configurar/ler-config.
- Auditor lê a razão como oculta: `ai.e2e.test.ts:135-153` — o `killSwitch.reason`
  do auditor vem `null` mesmo pausado (só quem tem `ai:configure` vê).
- Fato "ativo" (sem ninguém pausado): `kill-switch.test.ts:117`
  (`{ state: 'active', by: null, since: null }`) — este é o estado em que,
  presumivelmente, o banner **não aparece** (ausência, não "tudo ok" ostensivo).

---

## Perguntas que a MARCAÇÃO do designer decide (não decididas aqui)

1. **Componente**: estado novo em `GateSeal`, ou um `KillSwitchBanner` próprio? (Given
   que kill-switch é por-TENANT, não por-gate, a segunda opção parece mais honesta ao
   contrato — mas é sua chamada de linguagem visual.)
2. **Voz exata** dos dois estados — `active` (nada aparece? ou uma confirmação
   discreta "agentes operando normalmente"?) e `paused` (frase exata com ator+hora —
   ex.: *"Agentes pausados por {ator} desde {hora}"*, ou outra).
3. **Persistência**: já fixado alhures que é banner **persistente** (não
   dispensável/toast) — confirmando aqui para não haver ambiguidade nesta peça
   específica.
4. **Clique/interação**: o banner é só leitura (nada acontece ao clicar), ou linka
   para algum lugar (ex.: Operate, ou uma tela que só o admin resolve — nesse caso, o
   que um `business` vê ao clicar, dado que ele não tem `ai:configure`)?
5. **Degrade de erro**: se a leitura do fato falhar (rede/sessão), qual voz — silêncio
   honesto (como o `processConsequence = null` do P1) ou um estado de "não verificado"?
6. **Acessibilidade do fato**: `role="status"` com `aria-live`? Cor + ícone + rótulo
   (nunca só cor, regra já vinculante em todo o produto) — só confirmando que se aplica
   aqui como em todo lugar.

## Nota de sequência para o dev (depois da marcação)

Nenhum pré-requisito de backend falta — as duas rotas (`GET /v1/ai/kill-switch` nível
1 amplo, `GET /v1/ai/config` nível 2 admin) já estão mergeadas e testadas. Esta peça é
**pura UI de consumo** — sem migração, sem rota nova.
