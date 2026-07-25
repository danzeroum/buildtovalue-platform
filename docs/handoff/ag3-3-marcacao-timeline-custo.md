# AG-3.3 — Marcação da timeline unificada (custo real)

> **De:** Designer da plataforma · **Data:** 2026-07-25
> **Par de:** `docs/handoff/ag3-3-inventario-timeline-custo.md` (main, #59 `0ac2997`)
> **Rito:** rótulo, voz, tratamento e colocação são do design; `kind`/rota/RBAC são contrato.
> Sem código. As três restrições do §2 não são reabertas.

## Princípio que rege a tela

A linha responde **“o que aconteceu”**; o custo é **metadado**, não o assunto. Isso decide
quase todas as cinco: o custo precisa ser *localizável e comparável*, sem competir com o fato.
E como a mesma linha é servida a quem não vê custo, ela tem de **fechar sozinha** — a ausência
da chave não pode deixar cicatriz.

## 1 · Onde o número senta — chip à direita, alinhado em coluna

**Decisão:** chip discreto **alinhado à direita** da linha, não inline após o rótulo, nem em
segunda linha.

- **Inline** (`ação · llm-review · R$ 3,42`) empurra o custo para dentro da frase do fato:
  vira parte do que aconteceu, que é justamente o que ele não é. E a posição varia conforme o
  tamanho do rótulo — impossível varrer com o olho.
- **Segunda linha** dobraria a altura da lista por causa de uma minoria de linhas (só nós
  `llm` custam).
- **À direita** cria uma **coluna implícita**: o olho desce a borda direita e lê só os valores,
  que é o gesto real do operador (“onde está gastando?”). E, para o papel sem custo, **não há
  coluna nenhuma** — a linha simplesmente termina no horário, sem espaço reservado, sem
  travessão, sem placeholder. Nenhum buraco: é o layout natural da linha sem aquele elemento.

Peso visual: `mono`, tamanho de metadado (piso 11px), cor de tinta secundária — **não** dourado
nem vermelho. Custo não é alerta; ficar âmbar o confundiria com parada honesta.

## 2 · Formato — “R$ 3,42”, sempre moeda humana

**Decisão:** valor humano na moeda do tenant (`R$ 3,42`), nunca centavos (`342¢`). Centavo é
unidade de máquina; ninguém raciocina orçamento em centavos.

**Conversão:** o dado já chega convertido (`currency: BRL` + `fxRate`). Então a linha mostra
**só o valor final** — `fxRate` e `priceTableVersion` são **procedência**, não valor, e vivem no
detalhe da linha (§4), junto do `usage`. Isso mantém a disciplina do Atlas: a evidência de
*como* se chegou ao número existe e é alcançável, sem poluir a leitura.

Se algum dia a resposta trouxer `currency` diferente da moeda do tenant, aí sim a linha ganha
sufixo mono discreto (`· USD`) — porque aí o número **não** está na moeda que o leitor espera,
e omitir seria enganoso.

## 3 · Glifo — nenhum novo; o `R$` já é o sinal

**Decisão:** sem glifo de custo. O símbolo monetário **é** a marca tipográfica monocromática
que identifica o valor num relance, e ele já vem no número.

A família de glifos do produto (◆ agente · ⚑ gate · ⏸ parada · ⚙ sistema) marca **estados**.
Custo é **valor**. Emprestar um glifo de estado para um valor dilui o vocabulário — e a regra
“nunca só cor” já está satisfeita pelo texto.

## 4 · `usage` (tokens) — fora da linha, dentro do detalhe

**Decisão:** não na linha; **no detalhe expansível da linha**, junto de `priceTableVersion`,
`fxRate` e `nodeId`.

A pergunta do operador é “quanto custou”, não “quantos tokens” — tokens são diagnóstico. Mas
esconder de vez seria o oposto da procedência: quando alguém contesta um valor, precisa ver a
conta. Expandir mostra: `120 entrada · 40 saída · tabela deepseek-2026-07 · câmbio 5,30`.

**Não é ESCOPO:** o dado já vem no `payload`; é divulgação progressiva de algo que a resposta
já carrega — nenhuma rota, nenhum campo novo.

## 5 · Ator — `ActorBadge` em **toda** linha de agente, não só nas que custam

**Decisão:** `ActorBadge` em todo fato que tenha `payload.actor` — é o que torna a timeline
*unificada* de verdade. Restringir aos fatos com custo faria o “quem” aparecer e sumir ao longo
da lista, sugerindo que só aqueles têm autor.

- **agente** → ⬡ violeta com o `agentRef` (`agnt-aprova@1.0.0`) em mono;
- **humano** → iniciais em verde + nome;
- **sistema/motor** → ⚙ neutro.

**O traço lateral violeta fica** — e deixa de ser decorativo: ele é o sinal de varredura
(“este trecho é do agente”), o badge é a identidade. Um responde “de que canal”, o outro
“quem”. Com o badge ao lado, o traço deixa de ser sinal só-por-cor.

> **Lacuna que levanto (decisão do dev):** o inventário confirma `payload.actor` em **todo fato
> de agente**. Não afirma o mesmo dos fatos **humanos** (tarefa concluída, instância cancelada).
> Se o lado humano não carregar ator consultável, a “timeline unificada” fica unificada só de um
> lado. Onde não houver ator, **não inventar** — a linha vai sem badge; mas vale conferir, porque
> é a metade humana da promessa da fase.

## 6 · Densidade, rótulo e paginação

- **Uma linha por fato**, ritmo constante, expansão sob demanda (§4). Nada de cartões.
- **Rótulo humano primário; `kind` cru fora da linha.** Hoje a linha mostra os dois
  (`ação` + `agent:acao`) — a 11px, é ruído duplicado em cada linha. Recomendo: **rótulo humano
  na linha**, `kind` cru no **detalhe**; e a regra herdada permanece intacta — **kind
  desconhecido continua aparecendo cru na linha**, nunca escondido. *(Melhoria não encomendada;
  é forma, entra direto.)*
- **Agrupamento:** nenhum agrupamento artificial por tempo. Sequências consecutivas do mesmo
  ator se lêem juntas pelo traço lateral contínuo — agrupamento por percepção, não por cabeçalho.
- **Rodapé honesto:** *“Mostrando os 100 eventos mais recentes”* + “Carregar mais”. **Nunca**
  “todos os passos” nem “a instância inteira” — a tela vê uma fatia. É a mesma razão de não
  haver total (§2.3 do inventário), dita na cara do usuário.

## 7 · Degrade de erro

- **Lista falha:** erro explícito com “Tentar novamente” e `aria-live` — **nunca lista vazia**.
  Um histórico vazio *lê como “nada aconteceu”*, que é uma afirmação falsa e perigosa numa tela
  de auditoria. Vazio real (instância recém-criada) tem voz própria: *“Nenhum evento ainda.”*
- **Campo malformado numa linha:** a linha **ainda renderiza o fato** (seq, rótulo, hora) e
  omite só o pedaço problemático. Nunca sumir com a linha — some um evento da trilha.
- **Custo ausente:** ausência, ponto. Sem `R$ 0,00`, sem “—”, sem “oculto” (§2.2).

## Aceite de design (G-UX-3)

Chip de custo à direita, mono/secundário, sem cor de estado; linha sem custo fecha sem cicatriz;
`R$ x,yy` e nunca centavos; sem glifo novo; `usage`/`fxRate`/tabela no detalhe; `ActorBadge` em
todo fato com ator (traço lateral mantido); rótulo humano na linha e `kind` cru no detalhe
(exceto desconhecido); rodapé diz “100 mais recentes”; falha ≠ lista vazia; alvos ≥44px;
nenhum color-emoji; nenhum sinal só por cor.
