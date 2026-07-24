# Ratificação de design — `shared-ui` selo + tokens (AG-3.0)

> **De:** Designer da plataforma · **Data:** 2026-07-24
> **Ref.:** `main @ d2cb64f` — `packages/shared-ui/src/{selo.tsx,selo.css,tokens.ts,tokens.css}`
> **Rito:** ratificação posterior (padrão do tom `gold`). O dev implementou na fundação
> conteúdo que é E2 do Atlas; leio o código real e dou o veredito. **Nada a desfazer.**

## Veredito: RATIFICADO, com duas correções menores e três notas de calendário.

O trabalho está fiel ao Atlas E2 e ao delta de tokens, e em **dois pontos é mais honesto do
que a minha marcação** — decisões que eu ratifico com louvor.

## Ratifico com louvor (não mude)

1. **`ancorável` em vez de "verificado".** Eu havia marcado o estado como
   `ancorado·verificável`. O dev recusou dizer "verificado" enquanto não houver WAL imutável
   e o renomeou para `ancorável` + nota `self-recorded`. **É a aplicação do "nunca fingir" ao
   próprio selo** — a prova de integridade não pode afirmar mais garantia do que existe. Certo.
   É exatamente o princípio-mãe do Atlas ("evidência nunca é conteúdo") virado contra o próprio
   selo. Mantenha.

2. **`actor === null` → "Motor".** Em vez de inventar `{system, engine}` para atos
   determinísticos do motor (D6), criou um caso próprio com voz factual ("Motor"), nunca
   "desconhecido". Meu E2 tinha três atores (pessoa/sistema/agente); este quarto caso honesto
   é uma melhoria. Ratifico.

3. **Os dois tokens pendentes entraram certos.** `--ui-role-gate-*` (dourado, papel próprio,
   divergível do `warning`) e `--ui-role-agent-*` (violeta `#5b57b8`, fg `#3c3883`) — **ambos
   em `CONTRAST_PAIRS` com teste AA**, como pedido antes da AG-3. O fg do agente foi escurecido
   para `#3c3883` (do meu `#3f3785`) — presumo que para fechar AA sobre o tint; correto priorizar
   o teste. Aprovo o valor.

4. **Gate sempre âmbar, nunca vermelho** (`GateSeal`, `data-tone="gate"`); autonomia lida
   **sempre em texto** (`autonomia N/5`, `aria-label`), nível alto não é alarme; regra do mono
   no id do ator; piso de 11px (`--ui-font-size-meta`). Todas as regras vinculantes do parecer
   estão codificadas. 

## Corrijo (duas, menores — forma, entram direto no shared-ui)

1. **`mascarado` não deve pedir emprestado o papel `gate`.** Em `selo.tsx`, o estado
   `mascarado` usa `tone: 'gate'` (dourado). Mascaramento é **classificação de dado sensível**
   (D20) — é justamente o terceiro significado que o item 1 do delta separou do gate para uma
   **escala própria**. Reusar `--ui-role-gate-*` aqui recria a colisão que o delta desfez (gate
   e classificação na mesma cor). Visualmente idêntico hoje, mas semanticamente é o erro do
   `gold` de novo. **Correção:** criar `--ui-role-masked-*` (ou `--ui-class-personal-*`) — pode
   apontar o mesmo dourado hoje, divergível depois. É a mesma disciplina "papel por intenção,
   não hex".

2. **Trocar os glyphs emoji `🔒` (mascarado) e `⚓` (ancorável) por glyphs monocromáticos.**
   São color-emoji: renderizam em azul/colorido em quase toda plataforma, quebrando a paleta
   creme/verde/dourado e o princípio "sinal pela cor do papel". Os glyphs de ator (`●■◆▸`) estão
   certos — herdam `currentColor`. Use da mesma família para os estados (ex. `◆`/`▦` para
   mascarado, `⚓` só se for o glyph mono, ou um cadeado desenhado que herde a cor). Nit de
   consistência visual, não de função (o rótulo textual já carrega o sinal).

## Notas de calendário (não são pedidos agora)

- **`negado` volta quando E5 for construído.** O selo tem três estados porque a negação (E5)
  não existe no runtime — correto não pintar o que não há. Quando E5 entrar, `negado` (vermelho)
  se soma ao vocabulário; o schema do selo já comporta.
- **`ancorável` → estado verificado quando o WAL imutável entrar** (item de infra do Gate de
  Piloto). Aí a nota `self-recorded` some e o selo pode afirmar garantia externa.
- **A bandeira de gate na posição da cadeia** (o ⚑ no ponto exato do dial, como no protótipo
  P1/P6) é composição de superfície — vem na AG-3.1+, não na primitiva. A primitiva
  apresentacional (dial dourado + "exige gate") está correta para a fundação.

## Para a AG-3.1 (P1)
Com o selo e o dial ratificados, o P1 monta sobre eles. Mantenho a linha: **você entrega o
inventário do P1 e para; eu marco; você coda.** As duas correções acima entram como toque de
shared-ui (você sinaliza, eu já ratifiquei aqui) — não bloqueiam a AG-3.1.
