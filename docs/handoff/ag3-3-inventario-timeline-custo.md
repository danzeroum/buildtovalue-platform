# AG-3.3 — Inventário da timeline (custo real) para marcação do designer

> **Par de:** `ag3-3-shape-proposta-custo-trilha.md` (aprovada, mergeada — PR #58, sem
> migração). Este doc é o levantamento do dev — rótulo, voz, tratamento e colocação são do
> design. Sem código.

## 0 · Estado da tela hoje (para não redesenhar do zero)

`apps/console/src/routes/operate.tsx`, `HistoryTab` — **bare list**, sem nenhum campo do
`payload` renderizado ainda:
```tsx
<li data-agent={e.kind.startsWith('agent:') || undefined}>
  seq {e.seq} · <strong>{historyLabel(e.kind)}</strong> <span className="hist-kind-raw">{e.kind}</span> ·
  <span className="hist-when">{relativeTime(e.occurredAt)}</span>
</li>
```
- `historyLabel`/`voiceOf` (`voices.js`) já traduzem `kind` cru → rótulo humano
  ("ação", "decisão", "evidência"…) + família âmbar/vermelho para paradas/incidentes.
  Desconhecido → mostra o `kind` cru (nunca esconde) — regra que a AG-3.3 herda.
- Linhas de agente já ganham um traço lateral violeta (`.history-list li[data-agent]`,
  `--ui-role-agent-solid`) — o ÚNICO tratamento visual hoje, puramente decorativo.
- **`payload.actor` já existe desde a AG-2.2** (todo fato de agente carrega
  `{type,id,requestId}`) e **também não é renderizado ainda** — "timeline unificada
  humano+agente" (assinatura do CLAUDE.md) ainda não mostra QUEM agiu. Como a AG-3.3 é
  literalmente "P2 Operate com timeline unificada + custo real", incluo a pergunta do
  ator nesta marcação (não é código novo pro dev — `ActorBadge` já existe em shared-ui).
- **A aba Histórico é aberta a QUALQUER papel com `instances:read`** — business/analyst
  chegam nela (só Incidentes/Jobs/Timers exigem `operate:read`; ver `operate.tsx:222-231`).
  Ou seja: o cenário "business abre o Histórico e não deve ver custo" **é real nesta tela
  exata**, não hipotético.

## 1 · Os campos reais que a AG-3.3 trouxe (exemplos reais dos testes que passam)

Um fato `agent:acao` com custo (`packages/db/tests/agent-cost.test.ts`):
```json
{
  "kind": "agent:acao",
  "payload": {
    "elementId": "classificar", "agentRef": "agnt-aprova@1.0.0",
    "actor": { "type": "agent", "id": "agnt-aprova@1.0.0", "requestId": "job-1" },
    "nodeId": "llm-review",
    "cost": {
      "cents": 342, "currency": "BRL",
      "priceTableVersion": "deepseek-2026-07", "fxRate": 5.3,
      "usage": { "inputTokens": 120, "outputTokens": 40 }
    }
  },
  "occurredAt": "…", "seq": 12
}
```
Um fato `agent:acao` de um nó que **não** gerou custo (mesma corrida, nó `dec-approve`):
```json
{ "kind": "agent:acao", "payload": { "nodeId": "dec-approve", "actor": {…} } }
```
— **repare: não há chave `cost` nenhuma** (nem `null`, nem `0`) — ausência real no jsonb.

**RBAC (operator/admin vs business/analyst), mesma linha exata da trilha:**
```json
// GET .../history como OPERATOR (tem operate:read)
{ "kind": "agent:acao", "payload": { "nodeId": "llm-review", "cost": { "cents": 342, … } } }

// GET .../history como BUSINESS (só instances:read) — MESMA linha, MESMO seq
{ "kind": "agent:acao", "payload": { "nodeId": "llm-review" } }  // sem "cost" — chave ausente
```
A linha da trilha (que o nó rodou, quando) é **idêntica** para os dois papéis — só a chave
`cost` desaparece. Isso é a régua para a marcação: **a ausência do campo não pode parecer
um buraco/erro** — a linha inteira precisa fazer sentido sem ele.

## 2 · Três pontos que o dono já fechou (restrições, não perguntas)

1. **Agregado coerente com visibilidade** — citação: *"o total é a soma do que ESTÁ
   VISÍVEL para aquele papel — operator vê o total, business não vê custo algum (nem
   linha nem total), sem um 'total oculto' que denuncie que há custo."* Se existir um
   total no cabeçalho do drill-down, ele **soma exatamente o que a resposta da API
   devolveu para aquele papel** — nunca soma no cliente algo que o servidor já reservou,
   e nunca aparece um placeholder tipo "custo oculto" (isso já denunciaria a existência).
   Para business, o cabeçalho simplesmente **não tem a seção de custo**, do mesmo jeito
   que a linha não tem a chave.
   - **Superado pela decisão 3 abaixo** — não há total na v1, então esta regra vale para
     o dia em que um endpoint de agregação existir (pendência §2.23), não para agora.
2. **Degrade honesto por passo** — citação: *"passo que não custou... não mostra
   'R$ 0,00' como se tivesse sido medido... mostra ausência de custo... distinta de
   custou zero."* Mesma disciplina do `processConsequence = null` no P1: nós não-`llm`
   (ou jobs não-agente) **não têm a linha/badge de custo**, nunca um zero.
3. **SEM total agregado na v1 (decisão de produto, fecha a pergunta §3.3 anterior).**
   Custo só **por linha, exato, por-passo**. Razão (citação): *"um total que soma só a
   página de 100 eventos parece dizer 'quanto a instância custou' e não diz — é agregado
   que mente sobre o próprio escopo, a família do 'nunca fingir'. Melhor ausência de total
   que total enganoso."* Se "quanto esta instância gastou" virar requisito real de
   cliente, vira **endpoint de agregação próprio** (soma no servidor, escopo — não
   cálculo aproximado na tela) — registrado como possibilidade futura nomeada em
   `docs/pendencias.md §2.23`.

## 3 · Perguntas abertas para a marcação (voz, tratamento visual, colocação)

1. **Onde o número senta na linha** — inline após o rótulo ("ação · llm-review · R$ 3,42"),
   um chip à direita (estilo `Tag`), ou uma segunda linha sob o fato? A linha já é `mono`/
   densa (`.history-list`, piso 11px) — o custo compete por espaço com `seq`/`kind`/`when`.
2. **Formato monetário** — "R$ 3,42" (centavos→reais) ou "342¢"? Quando `currency !== 'BRL'`
   (ex.: `USD`) e `fxRate` presente: mostra só o valor final convertido, ou uma nota tipo
   "USD convertido @ 5,30"? (O dado bruto sempre carrega os dois — a pergunta é só o que
   aparece na tela.)
3. **Ícone/glifo de custo** — existe um vocabulário monocromático (◆ agente, ⚖ gate, ⏸
   kill-switch) que a marcação pode estender, ou o rótulo textual basta (a regra "nunca
   só cor" já é atendida por texto puro, mas a família de sinais visuais do produto
   sempre usou glifo+rótulo juntos)?
4. **`usage` (tokens de entrada/saída)** — aparece na UI da v1, ou fica só no dado bruto
   (auditável via export, nunca renderizado nesta tela)?
5. **Ator na timeline** (§0 — não é exclusivo de custo, mas a AG-3.3 é onde a "timeline
   unificada" se materializa): mostra `ActorBadge` (já existe, shared-ui) por linha? Ou
   só para os fatos que custam (já que só `llm` chama um provider real)? `payload.actor`
   está em TODO fato de agente, não só nos que custam.

## 4 · Notas de sequência para o dev (depois da marcação)

- Nenhum pré-requisito de backend falta — a rota já devolve `cost` condicionalmente por
  RBAC (PR #58, mergeada).
- `payload` no SDK gerado é `Record<string, unknown>` (freeform) — o consumo do campo
  `cost`/`actor` no console precisa de um cast local, o mesmo padrão que `GateDetail.tsx`
  já usa para o world-delta do P1 (`task.payload as WorldDelta`).
- Pura UI de consumo — sem migração, sem rota nova, sem mudança de RBAC.
