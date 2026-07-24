# AG-3.2 — Marcação do banner de kill-switch

> **De:** Designer da plataforma · **Data:** 2026-07-24
> **Par de:** `docs/handoff/ag3-2-inventario-banner-killswitch.md`
> **Rito:** rótulo, voz, tratamento e colocação são do design; rota/escopo/`kind` são contrato.
> Sem código.

## 0 · Correção da marcação anterior (o dev sinalizou certo)

`ag3-marcacao-administracao.md` §1.1 diz que o banner mostra “quem + quando + **motivo**”.
**Superado pelo contrato real:** o banner amplo mostra **apenas o fato** (quem + quando); a
razão vive só na tela de admin (`ai:configure`). Mantenho a exigência de **motivo obrigatório
nas duas direções** — mas ela é do **ato** (trilha), não da exibição. O nível 1 não deve nem
poder ler a razão, e o SQL de `getKillSwitchState` não a seleciona: correto assim.

## 1 · Componente — próprio (`KillSwitchBanner`)

Confirmo a inclinação. Razão de design, para não reabrir: `GateSeal` é estado de **uma
tarefa** (`aguardando`/`expirado`), montado inline junto da decisão; o kill-switch é
**condição do tenant inteiro**, montado no shell e verdadeiro em todas as rotas. Escopo,
tempo de vida e colocação diferentes. Estender o `GateSeal` criaria um componente cujo
significado depende de onde foi montado — é assim que vocabulário visual apodrece. Também
não é `EvidenceSeal`: ali o assunto é a evidência de um dado, não um interruptor operacional.

**Tom: âmbar** (`--ui-role-warning-*`), nunca vermelho. Pausa esperada e retomável — a mesma
assinatura da parada honesta que rege todo o F-AG. Vermelho fica reservado a
irreversível/proibido.

## 2 · Voz dos dois estados

**`active` → o banner não aparece.** Ausência é o sinal. Uma faixa verde permanente
(“agentes operando normalmente”) tem dois defeitos: treina o olho a ignorar aquela faixa, e
transforma a pausa em *mudança de texto* em vez de *aparecimento* — enfraquecendo justo o
momento que precisa chamar atenção.

**`paused` → aparece, com duas linhas:**

- **Linha 1 (o fato):** **“Agentes de IA pausados”** + ator + quando.
  Ex.: *“Agentes de IA pausados — por Ana Ruiz, hoje às 21:43.”*
- **Linha 2 (o alívio — não é opcional):** **“Tarefas e aprovações seguem normalmente.”**

A linha 2 é a contribuição mais importante desta marcação. Um usuário de negócio que lê
“pausados” assume que **o sistema caiu** e abre chamado. Dizer o que continua funcionando é
o mesmo princípio da parada honesta: nomear o que é verdade, inclusive a parte boa.

**Tratamento do ator:** badge de ator do E2 — `user` → iniciais em verde; `system` → ⚙ e a
voz muda para *“pausados pelo sistema”*. Nunca “pausados por desconhecido”.

**Quando:** relativo (“hoje às 21:43”), absoluto no `title`, **no fuso do usuário** (A5).

> **Lacuna de shape (levanto, decisão é do dev):** o fato devolve `by: {type, id}` — `id`
> cru (`"admin"`). Renderizar “por admin” é o mesmo defeito do rótulo cru que apontei na
> varredura (V3). Precisa de **nome de exibição** — na resposta, ou resolvido pelo console.
> Sem isso, a voz fica robótica no lugar mais visível do produto.

## 3 · Persistência e colocação

- **Persistente e não dispensável.** É estado, não evento: se pudesse ser fechado, a
  condição seguiria verdadeira com o aviso apagado.
- **Onde:** largura total, **imediatamente abaixo do header, acima do `<main>`** — presente
  em toda rota, sem empurrar marca/navegação e sem sobrepor conteúdo (nada de overlay fixo
  cobrindo UI).
- **Estreito:** o texto **quebra**, nunca trunca — o ator e a hora não podem sumir por corte.

## 4 · Clique e permissão

Aceito a inclinação do dono, com um cuidado:

- **Todo o banner é o alvo** (não um link pequeno no fim da frase) — alvo ≥ 44px.
- **Destino:** a tela de estado. **Todos veem o fato ampliado**; a **razão** só para
  `ai:configure`; **“Reativar agentes…”** só para `ai:operate` (mesmo padrão do reveal no P1).
- **Nunca um beco 403.** Para quem não tem permissão, o destino mostra o fato + o caminho
  humano: *“Só um administrador pode reativar — fale com um administrador.”* É a voz do 403
  por persona que fixei na F3: negócio recebe a saída, não o detalhe técnico.

## 5 · Degrade de erro — silêncio no banner, explícito na tela

Split deliberado:

- **No banner (ambiente):** falha de leitura → **não renderiza nada**. Nunca inventar
  emergência (banner de pausa sem certeza) e nunca um “não verificado” ambiente, que viraria
  ruído alarmante a cada oscilação de rede. Como `active` já é ausência, o silêncio é a
  mesma renderização — honesto por construção.
- **Na tela de estado / Admin (A2):** falha **precisa** aparecer — *“Não foi possível
  confirmar o estado dos agentes. Tentar novamente.”* Ali o estado **é** o assunto; omitir
  seria fingir conhecimento.

Mesma disciplina do `processConsequence = null` no P1: mostrar menos > afirmar errado.

## 6 · Acessibilidade — requisito, com uma emenda

`role="alert"` / `aria-live="assertive"` confirmado (nunca `status`/`polite`). Duas emendas
de design:

1. **`alert` anuncia mudança.** Numa carga de página com o estado **já** pausado, o alerta
   pode não disparar. Então o banner precisa ser **o primeiro conteúdo legível do shell**,
   antes da navegação na ordem do DOM, dentro de uma região rotulada (ex.: “estado dos
   agentes”) — quem chega no meio da emergência também é informado.
2. **O anúncio carrega as duas linhas** (fato + o que segue funcionando), não só “pausados”.
   Um leitor de tela ouvindo apenas “agentes pausados” fica com o mesmo susto que a linha 2
   existe para evitar.

Cor + ícone + rótulo (⏸ + texto), contraste AA no tamanho usado, nenhum color-emoji.

## Aceite de design (G-UX-3 antes do merge)

Componente próprio em âmbar; `active` não renderiza nada; `paused` traz as duas linhas com
badge de ator e hora no fuso do usuário; nome de exibição (não id cru); persistente,
não dispensável, abaixo do header e sem overlay; banner inteiro clicável (≥44px) levando ao
fato ampliado, com reativar só para `ai:operate` e sem beco 403; falha de leitura silenciosa
no banner e explícita na tela de estado; `role="alert"` + primeiro no DOM + anúncio das duas
linhas; nenhum sinal só por cor.
