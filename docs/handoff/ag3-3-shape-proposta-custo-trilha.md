# AG-3.3 — Proposta de shape (dev → triagem do dono) · custo real na trilha do agente

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Nenhuma
> gravação nova antes do ok. Par de: `ADENDO-04-administracao.md` ("AG-3.3 | P2 Operate
> (timeline) + custo real no drill-down").
>
> **Estado da triagem:** aguardando. Nota SOZINHA, como pedido — sem inventário/marcação da
> timeline ainda (isso depende de saber os campos que saem daqui).

## 0 · O achado que motiva esta fatia

Custo é **calculado e descartado**. `realWalker.ts` computa, por chamada `llm`, o objeto:
```ts
interface LlmCall {
  nodeId: string;
  costCents: number;
  priceTableVersion?: string;
  costCurrency?: string;
  fxRate?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}
```
Mas o caminho até a persistência quebra: `buildAgentFacts` (worker → `agentTrail.ts`) não tem
campo `cost` na entrada, e `persistAgentTrail` só grava `payload` (metadados) + `agent_io`
(I/O mascarado) em `history_events`. O custo vive só na memória do worker — usado para o
corte de budget dentro da MESMA corrida — e some. **Hoje é impossível auditar "quanto o
agente gastou aqui" depois do fato.** Não é refinamento da P2; é lacuna que a P2 destrava.

## 1 · Decisão 1 (conformidade) — já resolvida pelo próprio formato calculado

Você pediu: gravar custo junto da **versão da tabela de preços** e da **taxa de câmbio**
usadas no cálculo — sem isso, reconciliar depois de a tabela/câmbio mudarem é impossível.

Isso **já é de graça**: `LlmCall` já carrega `priceTableVersion`/`fxRate`/`costCurrency`
ao lado de `costCents` — não é campo a inventar, é **parar de descartar** o que já se
calcula. Proposta de payload por fato (chave nova, ver §3):
```ts
cost?: {
  cents: number;
  currency: string;               // 'BRL' | 'USD' (o que costCurrency trouxer)
  priceTableVersion: string | null;
  fxRate: number | null;           // null = moeda nativa, sem conversão (ex.: já BRL)
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}
```
Imutável por construção — `history_events` é append-only (D32), nunca `UPDATE`. Reconciliar
é **reler a linha**, nunca recalcular com a taxa/tabela atuais.

## 2 · Decisão 2 (onde gravar) — recomendo DIVERGIR das duas opções que você deu

Você propôs: chave no `agent_io` jsonb, ou coluna nullable nova. Investiguei o que essas
colunas já significam neste código e acho que nenhuma das duas é a melhor casa:

- **`agent_io`** é reservado para I/O **potencialmente pessoal**, sob a política de máscara
  conservadora (D20/D30 — `conservativeMaskingPolicy`, `maskIo`). Custo não é dado pessoal;
  colocá-lo lá mistura dois conceitos hoje limpos: "isto pode ser PII, mascare por padrão"
  vs. "isto é metadado financeiro, nunca PII".
- **`payload`** já é o balde de **metadado não-pessoal** do fato (`elementId`, `agentRef`,
  `actor`, `kind`, `source`, `message`, `nodeId`) — custo cabe exatamente nessa categoria,
  do mesmo jeito que o mundo-delta do P1 usou o payload existente sem coluna nova.
- É jsonb **já existente** — gravar `cost` ali não muda o schema da 0006, só o CONTEÚDO
  ganha uma chave nova. Mesmo tratamento que o world-delta do P1 recebeu ("schema
  congelado", sem migração dedicada).
- **Sobre agregação** (seu critério para decidir): verifiquei se já existe alguma soma de
  custo entre instâncias/tenant hoje — **não existe**. O corte de budget do `realWalker`
  acumula `accCents` **em memória, dentro de uma única corrida** (nunca lê trilha
  persistida). Não há requisito vivo de agregação — só hipotético. Proponho **adiar** a
  coluna indexável para quando isso for pedido de verdade (o mesmo raciocínio que já usamos
  para não construir P3 rico/telemetria antes da hora).

**Peço sua confirmação:** payload existente (minha recomendação — sem migração de schema),
ou prefere mesmo uma coluna nova indexável (`history_events.cost_cents integer`, nullable)
já agora, por rigor, mesmo sem uso imediato de agregação?

## 3 · Onde grudar o fato — no `'acao'` existente, não um `kind` novo

Custo é **por-nó** (`LlmCall.nodeId`), e o fato `'acao'` já é **um por nó visitado**, já
carrega `nodeId` (`buildAgentFacts`, um fato por elemento de `visitedNodes`). Proposta:
anexar `cost` ao payload do fato `'acao'` do nó correspondente, só quando aquele nó foi um
`llm` com chamada real. Nós não-`llm` simplesmente **não têm a chave** — ausência honesta
("este passo não gerou custo"), nunca "custo zero" (que mentiria sobre uma medição que não
aconteceu). Evita fragmentar a corrida em mais linhas com um `kind: 'custo'` novo, sem
necessidade.

## 4 · Decisão 3 (RBAC) — correção ao que a triagem presumiu

Você pediu para eu **confirmar** que o histórico já é `operate:read`, herdando. Verifiquei —
**não é**: `GET /v1/instances/:id/history` (`apps/api/src/routes/runtime.ts:143`, a rota
que alimenta a aba Histórico do Operate) é gated por **`instances:read`**, não
`operate:read`. `instances:read` é **mais amplo**: concedido a business/analyst/operator/
admin; `operate:read` só a operator/admin.

Isso muda o cálculo do que você pediu para proteger: se o custo simplesmente **herdar** o
RBAC da rota (`instances:read`), um `business`/`analyst` — que só deveria ver as próprias
tarefas/instâncias — também veria o gasto de LLM por instância. É exatamente o "vazar por
um caminho mais amplo" que a decisão 3 quis evitar, só que a premissa ("já é operate:read")
estava invertida.

**Recomendo o MESMO padrão de dois níveis fechado na AG-3.2 (kill-switch):** o histórico
segue devolvendo tudo (kind, payload sem custo) para quem tem `instances:read` — mas o
campo `cost` dentro do payload do fato `'acao'` só é **projetado** na resposta para quem tem
`operate:read`. Quem não tem, vê a linha da trilha (o que rodou, quando), mas sem o valor —
mesma disciplina do "fato amplo, razão estreita" já aprovada.

**Peço sua confirmação:** reusar `operate:read` (minha inclinação — custo por passo é
operacional, do mesmo círculo de quem já opera a instância), ou um escopo **nomeado próprio**
(`costs:read`), pelo mesmo motivo que o P4 ganhou 4 escopos dedicados em vez de emprestar
`operate:*`? Não vejo hoje um papel que opere sem dever ver custo, ou veja custo sem operar
— mas é sua chamada de governança, não minha.

## 5 · Resumo do que esta nota decide, antes de eu codar

1. **Formato do objeto `cost`** no payload (§1) — aceito como descrito?
2. **Onde gravar** — payload existente do `'acao'` (recomendo, sem migração) OU coluna nova
   indexável (`cost_cents`, nullable)?
3. **RBAC do campo** — reusa `operate:read` (recomendo) OU escopo novo `costs:read`?
4. Se envolver coluna nova (opção B de #2): migração leva **[GATE+MIGRAÇÃO]** no título, como
   sempre.

## 6 · Depois da nota

Com os campos fechados, sigo para o **inventário da timeline** (voz por tipo de fato — como
o custo aparece por linha? soma no cabeçalho do drill-down? degrade quando o passo não tem
custo, nunca "R$ 0,00"?) para você marcar — só então o G-UX-3, sobre campos reais, do jeito
que fizemos no P1 e no banner.
